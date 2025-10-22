import { Request, Response } from 'express';
import { QueryTypes, Sequelize } from 'sequelize';
import ExcelJS from 'exceljs';
import connection from '../../database/connection_firmador';
import connection_firmas from '../../database/connection_firmas';

// helper para normalizar resultados (siempre devolver array de filas)
function normalizeResults(raw: any): any[] {
  if (!raw) return [];
  // A veces mysql2/Sequelize devuelve múltiples paquetes: filas y luego un OK-packet con metadatos.
  // Queremos devolver sólo las filas reales.
  const metadataKeys = new Set(['fieldCount','affectedRows','insertId','info','serverStatus','warningStatus','changedRows']);

  const isOkPacket = (obj: any) => {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    return keys.length > 0 && keys.every(k => metadataKeys.has(k));
  };

  let res: any[] = [];
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    // A veces raw = [ [rows...], okPacket ] o raw = [ okPacket ]
    // Normalizar a las filas del primer elemento si es un array, sino filtrar los ok packets
    if (Array.isArray(raw[0])) res = raw[0];
    else res = raw.filter((r: any) => !isOkPacket(r));
  } else {
    res = [raw];
  }

  // Si el primer elemento es un objeto con claves numéricas, convertir a array
  if (res.length > 0 && typeof res[0] === 'object' && !Array.isArray(res[0])) {
    const keys = Object.keys(res[0]);
    if (keys.length > 0 && keys.every(key => !isNaN(Number(key)))) {
      return Object.values(res[0]);
    }
  }

  // Filtrar cualquier ok-packet que pudiera quedarse
  res = res.filter(r => !isOkPacket(r));
  return res;
}

// Construir una lista ordenada de claves a partir de todas las filas.
// Si se proporciona `preferredOrder`, colocará esas claves primero (si existen en los datos),
// luego el resto de claves encontradas en el conjunto de filas.
function buildColumnsFromRows(rows: any[], preferredOrder: string[] = []): string[] {
  if (!rows || rows.length === 0) return [];
  const keySet = new Set<string>();
  // Agregar claves preferidas que existan en algún row (mantener orden)
  for (const k of preferredOrder) {
    for (const r of rows) {
      if (r && Object.prototype.hasOwnProperty.call(r, k)) {
        keySet.add(k);
        break;
      }
    }
  }
  // Agregar todas las demás claves vistas en las filas, en orden de aparición
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) {
        if (!keySet.has(k)) keySet.add(k);
      }
    }
  }
  return Array.from(keySet);
}

/**
 *  Obtener registros por rango de fechas
 */
export const obtenerRegistrosPorFechas = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel = false, cod_distribuidor } = (req.body || {}) as any;

  console.log('[obtenerRegistrosPorFechas] Petición recibida:', { fecha_inicio, fecha_fin, generarExcel });
  
  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const fechaInicioFormateada = new Date(fecha_inicio);
  const fechaFinFormateada = new Date(fecha_fin);

  const fechaInicioString = fechaInicioFormateada.toISOString().split('T')[0];
  const fechaFinString = fechaFinFormateada.toISOString().split('T')[0];

  console.log('Fecha de inicio:', fechaInicioString);
  console.log('Fecha de fin:', fechaFinString);
  console.log('¿Generar Excel?:', generarExcel);

  try {
    // Verificación de a qué DB/host está apuntando esta conexión
    try {
      const dbInfoRes: any = await connection.query(
        'SELECT DATABASE() AS db, @@hostname AS hostname, @@port AS port',
        { type: QueryTypes.SELECT }
      );
      let dbInfoRow: any = null;
      if (Array.isArray(dbInfoRes)) {
        dbInfoRow = Array.isArray(dbInfoRes[0]) ? dbInfoRes[0][0] : dbInfoRes[0];
      } else {
        dbInfoRow = dbInfoRes;
      }
      console.log(`[DB verificar] ENV host=${process.env.DB_HOST_1}:${process.env.DB_PORT_1} db=${process.env.DB_NAME_1} | SERVER db=${dbInfoRow?.db} hostname=${dbInfoRow?.hostname} port=${dbInfoRow?.port}`);
    } catch (e: any) {
      console.warn('[DB verificar] No se pudo obtener info DB:', e?.message || e);
    }

    const raw = await connection.query(
      'CALL obtener_registros_por_fechas(?, ?)',
      {
        replacements: [fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );

    let results = normalizeResults(raw);

    // Si el objeto tiene claves numéricas, convertirlo a un array
    if (results.length > 0 && typeof results[0] === 'object' && !Array.isArray(results[0])) {
      const firstItem = results[0];
      const keys = Object.keys(firstItem);
      
      if (keys.length > 0 && keys.every(key => !isNaN(Number(key)))) {
        console.log('[normalizeResults] Detectado objeto con claves numéricas, convirtiendo a array');
        results = Object.values(firstItem);
      }
    }

    // Parsear los datos si son cadenas JSON
    let parsedRows = results.map((row: any) => {
      if (typeof row === 'string') {
        try { return JSON.parse(row); } catch { return { valor: row }; }
      }
      if (row && typeof row === 'object') {
        const values = Object.values(row);
        if (values.length === 1 && typeof values[0] === 'string') {
          try { return JSON.parse(values[0] as string); } catch { return row; }
        }
      }
      return row;
    });
    // Filtrar objetos vacíos y nulos que pueden aparecer (ok-packets ya filtrados en normalizeResults)
    parsedRows = parsedRows.filter(r => {
      if (r == null) return false;
      if (typeof r === 'object' && Object.keys(r).length === 0) return false;
      return true;
    });
    console.log(`[obtenerRegistrosPorFechas] Total de registros: ${results.length}. Tras parseo: ${parsedRows.length}`);

    // Si se suministra un código de distribuidor, filtrar en memoria.
    // Hacemos un filtrado robusto: buscamos por claves candidatas, por cualquier valor
    // dentro del objeto (recursivamente), y también comparamos solo-dígitos para códigos numéricos.
    let filteredRows = parsedRows;
    if (cod_distribuidor) {
      const codeRaw = String(cod_distribuidor).trim();
      const codeStr = codeRaw.toLowerCase();
      const codeDigits = codeRaw.replace(/\D/g, '');

      const candidateKeys = [
        'cod_distribuidor', 'codigo_distribuidor', 'codigo_distrib', 'coddistribuidor', 'cod_dist',
        'codigo_dis', 'codigo', 'codigo_distribuidor1', 'distribuidor_codigo', 'cod_distri', 'codigo_distrib'
      ];

      // Extrae valores primitivos del objeto recursivamente (hasta depth 3)
      const extractValues = (obj: any, depth = 0): string[] => {
        if (obj == null) return [];
        if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
          return [String(obj)];
        }
        if (depth > 3) return [];
        if (Array.isArray(obj)) {
          return obj.flatMap(item => extractValues(item, depth + 1));
        }
        if (typeof obj === 'object') {
          return Object.values(obj).flatMap(v => extractValues(v, depth + 1));
        }
        return [];
      };

      const rowMatches = (row: any) => {
        if (!row) return false;

        // 1) Buscar por claves candidatas (si existen)
        for (const k of candidateKeys) {
          if (Object.prototype.hasOwnProperty.call(row, k)) {
            const v = row[k];
            if (v == null) continue;
            const s = String(v).toLowerCase();
            const digits = String(v).replace(/\D/g, '');
            if (s.includes(codeStr)) return true;
            if (codeDigits && digits === codeDigits) return true;
          }
        }

        // 2) Buscar en cualquier valor primitivo del objeto (recursivo)
        const values = extractValues(row);
        for (const val of values) {
          const s = val.toLowerCase();
          const digits = val.replace(/\D/g, '');
          if (s.includes(codeStr)) return true;
          if (codeDigits && digits === codeDigits) return true;
        }

        return false;
      };

      filteredRows = parsedRows.filter(rowMatches);
      console.log(`[obtenerRegistrosPorFechas] Filtrado por cod_distribuidor='${cod_distribuidor}' => ${filteredRows.length} registros encontrados`);

      if (filteredRows.length === 0) {
        // Loguear una muestra para debugging: keys y primeros 3 rows parseadas
        console.warn('[obtenerRegistrosPorFechas] WARNING: el filtro no devolvió coincidencias; mostrando muestra de filas para inspección');
        const sample = parsedRows.slice(0, 3).map((r: any, i: number) => ({ idx: i, keys: r && typeof r === 'object' ? Object.keys(r) : typeof r, sampleValues: extractValues(r).slice(0,5) }));
        console.warn(JSON.stringify(sample, null, 2));
      }
    }
    
    if (generarExcel) {
      console.log('[Excel] Iniciando generación de Excel...');

      if (!filteredRows || filteredRows.length === 0) {
        console.log('[Excel] ERROR: No hay datos para exportar');
        return res.status(404).json({ error: 'No hay datos para exportar' });
      }

      // Crear libro de trabajo de Excel
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Registros por Fechas');

      // Construir columnas a partir de la unión de claves de todas las filas (evita cabeceras vacías)
      const columnas = buildColumnsFromRows(filteredRows);

      // Configurar las columnas de Excel según el orden devuelto por buildColumnsFromRows
      worksheet.columns = columnas.map(key => ({ header: key.toUpperCase(), key: key, width: 15 }));

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      };

      // Agregar las filas de datos al Excel
      filteredRows.forEach((row: any) => {
        worksheet.addRow(row);
      });

      // Ajustar el ancho de las columnas automáticamente
      worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

  // Configurar los encabezados para la descarga del archivo
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=registros_${fechaInicioString}_${fechaFinString}.xlsx`);
      
      console.log('[Excel] Headers configurados, escribiendo archivo...');

      // Escribir el archivo en la respuesta
      await workbook.xlsx.write(res);
      res.end();

      console.log('[Excel] Archivo Excel generado y enviado exitosamente');
      return;
    } else {
      // Si no se requiere generar Excel, devolver datos en formato JSON
      console.log('[JSON] Devolviendo datos en formato JSON (normalizados)');
      return res.json(filteredRows);
    }

  } catch (err: any) {
    console.error('Error al llamar el procedimiento:', err);
    console.error('Stack trace:', err.stack);
    return res.status(500).json({
      error: 'Error en la base de datos',
      message: err.message || 'Error desconocido'
    });
  }
};

/**
 *  Obtener registros de firmas-facturas por fechas
 */
export const obtenerRegistrosFirmasFactura = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin } = req.body;

  console.log('Fecha recibida - inicio:', fecha_inicio);
  console.log('Fecha recibida - fin:', fecha_fin);

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const regexFecha = /^\d{4}-\d{2}-\d{2}$/;
  if (!regexFecha.test(fecha_inicio) || !regexFecha.test(fecha_fin)) {
    return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
  }

  try {
    const results = await connection.query(
      'CALL sabinf.obtener_firmas_factura_fechas(?, ?)',
      {
        replacements: [fecha_inicio, fecha_fin],
        type: QueryTypes.SELECT,
      }
    );

    const registros = Array.isArray(results) && Array.isArray(results[0])
      ? results[0]
      : results;

    console.log(`Registros encontrados entre ${fecha_inicio} y ${fecha_fin}: ${registros.length}`);
    return res.json(registros);
  } catch (err) {
    console.error('Error al llamar el procedimiento:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
};

/**
 *  Obtener reporte de distribuidores por fechas
 */
export const obtenerReporteDistribuidores = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin } = req.body;

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const fechaInicioFormateada = new Date(fecha_inicio);
  const fechaFinFormateada = new Date(fecha_fin);

  const fechaInicioString = fechaInicioFormateada.toISOString().split('T')[0];
  const fechaFinString = fechaFinFormateada.toISOString().split('T')[0];

  console.log('Fecha de inicio:', fechaInicioString);
  console.log('Fecha de fin:', fechaFinString);

  try {
    const results = await connection.query(
      'CALL filtrar_distribuidores_por_fecha(?, ?)',
      {
        replacements: [fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );

    return res.json(results);
  } catch (err) {
    console.error('Error al llamar el procedimiento:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
};

/**
 *  Filtro de distribuidores (usa la conexión local - localhost)
 *  Llama al procedimiento: CALL filtrar_distribuidores_por_fecha(fecha_inicio, fecha_fin)
 */
export const filtroDistribuidoresPorFecha = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel = false } = req.body || {};

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const fechaInicioString = new Date(fecha_inicio).toISOString().split('T')[0];
  const fechaFinString = new Date(fecha_fin).toISOString().split('T')[0];

  console.log('[filtroDistribuidoresPorFecha] Petición recibida:', { fechaInicioString, fechaFinString });

  try {
    // Intentar en la BD local (connection_firmas_2)
    try {
      const raw = await connection_firmas.query(
        'CALL filtrar_distribuidores_por_fecha(?, ?)',
        {
          replacements: [fechaInicioString, fechaFinString],
          type: QueryTypes.SELECT,
        }
      );

      const registros = normalizeResults(raw);
      const filteredRegistros = (registros || []).filter(r => {
        if (r == null) return false;
        if (typeof r === 'object' && Object.keys(r).length === 0) return false;
        return true;
      });
      console.log(`[filtroDistribuidoresPorFecha] Registros desde BD local: ${registros.length} -> tras filtrar: ${filteredRegistros.length}`);

      if (generarExcel) {
        if (!filteredRegistros || filteredRegistros.length === 0) {
          return res.status(404).json({ error: 'No hay datos para exportar' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Distribuidores por Fecha');

          const columnas = buildColumnsFromRows(filteredRegistros);
          worksheet.columns = columnas.map(key => ({ header: key.toUpperCase(), key, width: 15 }));
        worksheet.getRow(1).font = { bold: true };

        filteredRegistros.forEach((r: any) => worksheet.addRow(r));

        worksheet.columns.forEach(column => {
          let maxLength = 0;
          column.eachCell({ includeEmpty: true }, cell => {
            const columnLength = cell.value ? String(cell.value).length : 10;
            if (columnLength > maxLength) maxLength = columnLength;
          });
          column.width = maxLength < 10 ? 10 : maxLength + 2;
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=distribuidores_${fechaInicioString}_${fechaFinString}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
        return;
      }

      return res.json(filteredRegistros);
    } catch (localErr: any) {
      console.warn('[filtroDistribuidoresPorFecha] Error en BD local, intentando fallback a conexión principal:', localErr?.message || localErr);
      // Fallback a la conexión principal
      const raw2 = await connection.query(
        'CALL filtrar_distribuidores_por_fecha(?, ?)',
        {
          replacements: [fechaInicioString, fechaFinString],
          type: QueryTypes.SELECT,
        }
      );
      const registros2 = normalizeResults(raw2);
      const filteredRegistros2 = (registros2 || []).filter(r => {
        if (r == null) return false;
        if (typeof r === 'object' && Object.keys(r).length === 0) return false;
        return true;
      });
      console.log(`[filtroDistribuidoresPorFecha] Registros desde BD principal: ${registros2.length} -> tras filtrar: ${filteredRegistros2.length}`);

      if (generarExcel) {
        if (!filteredRegistros2 || filteredRegistros2.length === 0) {
          return res.status(404).json({ error: 'No hay datos para exportar' });
        }

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Distribuidores por Fecha');

  const columnas = buildColumnsFromRows(filteredRegistros2);
  worksheet.columns = columnas.map(key => ({ header: key.toUpperCase(), key, width: 15 }));
        worksheet.getRow(1).font = { bold: true };

    filteredRegistros2.forEach((r: any) => worksheet.addRow(r));

        worksheet.columns.forEach(column => {
          let maxLength = 0;
          column.eachCell({ includeEmpty: true }, cell => {
            const columnLength = cell.value ? String(cell.value).length : 10;
            if (columnLength > maxLength) maxLength = columnLength;
          });
          column.width = maxLength < 10 ? 10 : maxLength + 2;
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=distribuidores_${fechaInicioString}_${fechaFinString}.xlsx`);
        await workbook.xlsx.write(res);
        res.end();
        return;
      }

      return res.json(filteredRegistros2);
    }
  } catch (err: any) {
    console.error('[filtroDistribuidoresPorFecha] Error al ejecutar el procedimiento:', err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

/**
 *  Maqueta: Cantidad de firmas por distribuidor
 *  Intentará llamar a un procedimiento (si existe) y si no, devolverá datos de ejemplo
 *  Parámetros: fecha_inicio, fecha_fin, cod_distribuidor (opcional), generarExcel (opcional)
 */
export const cantidadFirmasPorDistribuidor = async (req: Request, res: Response) => {
  const { cod_distribuidor, generarExcel = false } = req.body || {};

  if (!cod_distribuidor) {
    return res.status(400).json({ error: 'El parámetro cod_distribuidor es requerido' });
  }

  try {
    // Ejecutar la consulta remota según lo provisto por el usuario
    const sql = `
      SELECT duracion, COUNT(*) AS cantidad
      FROM registroa
      WHERE codDis = ?
      GROUP BY duracion
      ORDER BY duracion
    `;

    const raw = await connection.query(sql, { replacements: [cod_distribuidor], type: QueryTypes.SELECT });
    const rows = normalizeResults(raw);

    console.log(`[cantidadFirmasPorDistribuidor] Filas encontradas (remoto): ${rows.length}`);

    if (generarExcel) {
      if (!rows || rows.length === 0) return res.status(404).json({ error: 'No hay datos para exportar' });

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Cantidad Firmas');
      ws.columns = [
        { header: 'DURACION', key: 'duracion', width: 20 },
        { header: 'CANTIDAD', key: 'cantidad', width: 12 }
      ];
      rows.forEach((r: any) => ws.addRow(r));
      ws.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const columnLength = cell.value ? String(cell.value).length : 10;
          if (columnLength > maxLength) maxLength = columnLength;
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=cantidad_firmas_${cod_distribuidor}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    return res.json(rows);
  } catch (err: any) {
    console.error('[cantidadFirmasPorDistribuidor] Error al ejecutar consulta remota:', err?.message || err);
    // Como fallback, devolver maqueta
    const example = [
      { duracion: '1 Año', cantidad: 10 },
      { duracion: '2 Años', cantidad: 3 }
    ];
    return res.json(example);
  }
};

/**
 *  Factura por fechas
 *  Llama al procedimiento remoto `obtener_registro_firmas_factura_por_fechas(fecha_inicio, fecha_fin)`
 *  Parámetros: fecha_inicio, fecha_fin, generarExcel (opcional)
 */
export const facturaPorFechas = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel = false } = req.body || {};

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const fechaInicioString = new Date(fecha_inicio).toISOString().split('T')[0];
  const fechaFinString = new Date(fecha_fin).toISOString().split('T')[0];

  console.log('[facturaPorFechas] Petición recibida:', { fechaInicioString, fechaFinString, generarExcel });

  try {
    const raw = await connection.query(
      'CALL obtener_registro_firmas_factura_por_fechas(?, ?)',
      {
        replacements: [fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );

    const rows = normalizeResults(raw);
    // Filtrar nulos y objetos vacíos que puedan venir del driver
    const filteredRows = (rows || []).filter(r => {
      if (r == null) return false;
      if (typeof r === 'object' && Object.keys(r).length === 0) return false;
      return true;
    });
    console.log(`[facturaPorFechas] Filas encontradas (raw): ${rows.length}, tras filtrar: ${filteredRows.length}`);

    if (generarExcel) {
      if (!filteredRows || filteredRows.length === 0) {
        return res.status(404).json({ error: 'No hay datos para exportar' });
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Factura por Fechas');
  const columnas = buildColumnsFromRows(filteredRows);
  worksheet.columns = columnas.map(key => ({ header: key.toUpperCase(), key, width: 15 }));
    worksheet.getRow(1).font = { bold: true };
    filteredRows.forEach((r: any) => worksheet.addRow(r));

      worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const columnLength = cell.value ? String(cell.value).length : 10;
          if (columnLength > maxLength) maxLength = columnLength;
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=factura_${fechaInicioString}_${fechaFinString}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

  return res.json(filteredRows);
  } catch (err: any) {
    console.error('[facturaPorFechas] Error al ejecutar procedimiento remoto:', err?.message || err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

/**
 * FirmasVendidas - lee la vista remota FirmasVendidasxMes-Dist y devuelve filas
 * Opcional: enviar { generarExcel: true } en body para descargar .xlsx
 */
export const FirmasVendidas = async (req: Request, res: Response) => {
  const { generarExcel = false } = req.body || {};

  try {
    const sql = 'SELECT * FROM firmasecuador.`FirmasVendidasxMes-Dist`';
    const rows = await connection.query(sql, { type: QueryTypes.SELECT });
    const data = Array.isArray(rows) ? rows : normalizeResults(rows);

    console.log(`[FirmasVendidas] Filas encontradas: ${data.length}`);

    if (generarExcel) {
      if (!data || data.length === 0) return res.status(404).json({ error: 'No hay datos para exportar' });

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Firmas Vendidas');
  const cols = buildColumnsFromRows(data);
  ws.columns = cols.map(c => ({ header: c.toUpperCase(), key: c, width: 20 }));
      data.forEach((r: any) => ws.addRow(r));

      ws.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const l = cell.value ? String(cell.value).length : 10;
          if (l > maxLength) maxLength = l;
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=firmas_vendidas.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    return res.json(data);
  } catch (err: any) {
    console.error('[FirmasVendidas] Error al leer la vista:', err?.message || err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

/**
 * Firmas generadas con factura
 * Llama al procedimiento remoto `obtener_firmas_factura_fechas(fecha_inicio, fecha_fin)`
 * Devuelve JSON o Excel si generarExcel=true
 */
export const obtenerFirmasGeneradasConFactura = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel = false } = req.body || {};

  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Las fechas son requeridas' });
  }

  const fechaInicioString = new Date(fecha_inicio).toISOString().split('T')[0];
  const fechaFinString = new Date(fecha_fin).toISOString().split('T')[0];

  try {
    const raw = await connection.query(
      'CALL obtener_firmas_factura_fechas(?, ?)',
      {
        replacements: [fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );

    const rows = normalizeResults(raw);
    const filteredRows = (rows || []).filter(r => {
      if (r == null) return false;
      if (typeof r === 'object' && Object.keys(r).length === 0) return false;
      return true;
    });
    console.log(`[obtenerFirmasGeneradasConFactura] Filas encontradas (raw): ${rows.length}, tras filtrar: ${filteredRows.length}`);

    if (generarExcel) {
  if (!filteredRows || filteredRows.length === 0) return res.status(404).json({ error: 'No hay datos para exportar' });

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Firmas con Factura');

  // Columns suggested by user
  const columnas = [
        'ruc','codUnico','cedula','localizador','codDis','nombre_distribuidor','correo_distribuidor','telefono_distribuidor',
        'tipo','dia','mes','duracion','razon_social','direccion','correo','telefono','valorC','Banco','codUserT',
        'horaIngreso','horaTramitacion','horaFinalizacion','tiempoFirma','Emisor','Estado','codUserF','Comentario',
        'periodo','clave','correo3','creacionClave','notificado','tipoP','comprobante','recurrencia','codigo_factura',
        'numero_factura','identificacion_factura','empresa_distribuidor'
      ];

      // Use the keys present in rows[0] but keep order from columnas where possible
  // Construir columnas respetando el orden sugerido y luego cualquier clave adicional
  const keys = buildColumnsFromRows(filteredRows, columnas);
  ws.columns = keys.map(k => ({ header: k.toUpperCase(), key: k, width: 20 }));
    filteredRows.forEach((r: any) => ws.addRow(r));

      ws.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const l = cell.value ? String(cell.value).length : 10;
          if (l > maxLength) maxLength = l;
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=firmas_factura_${fechaInicioString}_${fechaFinString}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

  return res.json(filteredRows);
  } catch (err: any) {
    console.error('[obtenerFirmasGeneradasConFactura] Error al ejecutar procedimiento:', err?.message || err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

/**
 * Firmas por Enganchador
 * Llama al procedimiento remoto `obtener_firmas_por_enganchador(codigo_enganchador, fecha_inicio, fecha_fin)`
 * Parámetros (body): codigo_enganchador, fecha_inicio, fecha_fin, generarExcel (opcional)
 */
export const obtenerFirmasPorEnganchador = async (req: Request, res: Response) => {
  const { codigo_enganchador, fecha_inicio, fecha_fin, generarExcel = false } = req.body || {};

  if (!codigo_enganchador) return res.status(400).json({ error: 'El parámetro codigo_enganchador es requerido' });
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Las fechas son requeridas' });

  const fechaInicioString = new Date(fecha_inicio).toISOString().split('T')[0];
  const fechaFinString = new Date(fecha_fin).toISOString().split('T')[0];

  console.log('[obtenerFirmasPorEnganchador] Petición:', { codigo_enganchador, fechaInicioString, fechaFinString, generarExcel });

  try {
    const raw = await connection.query(
      'CALL obtener_firmas_por_enganchador(?, ?, ?)',
      {
        replacements: [codigo_enganchador, fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );

    let rows = normalizeResults(raw);

    // si viene como objeto con claves numéricas convertir a array
    if (rows.length > 0 && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
      const firstItem = rows[0];
      const keys = Object.keys(firstItem);
      if (keys.length > 0 && keys.every(key => !isNaN(Number(key)))) {
        console.log('[normalizeResults] Detectado objeto con claves numéricas en obtenerFirmasPorEnganchador, convirtiendo a array');
        rows = Object.values(firstItem);
      }
    }

    // parsear filas que vengan como JSON string
    let parsedRows = rows.map((row: any) => {
      if (typeof row === 'string') {
        try { return JSON.parse(row); } catch { return { valor: row }; }
      }
      if (row && typeof row === 'object') {
        const values = Object.values(row);
        if (values.length === 1 && typeof values[0] === 'string') {
          try { return JSON.parse(values[0] as string); } catch { return row; }
        }
      }
      return row;
    });

    // Filtrar objetos vacíos / nulos
    parsedRows = parsedRows.filter(r => {
      if (r == null) return false;
      if (typeof r === 'object' && Object.keys(r).length === 0) return false;
      return true;
    });

    console.log(`[obtenerFirmasPorEnganchador] Filas encontradas: ${parsedRows.length}`);

    if (generarExcel) {
      if (!parsedRows || parsedRows.length === 0) return res.status(404).json({ error: 'No hay datos para exportar' });

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Firmas por Enganchador');

      // Orden sugerido de columnas según especificación del usuario
      const preferredOrder = [
        'ID','RUC','CEDULA','RAZON_SOCIAL','TIPO','CODIGO_UNICO','DIA','MES','PERIODO','DURACION',
        'DIRECCION','CORREO','TELEFONO','VALOR_COBRADO','BANCO','HORA_INGRESO','HORA_TRAMITACION',
        'HORA_FINALIZACION','TIEMPO_FIRMA','EMISOR','ESTADO','COMENTARIO','PLATAFORMA_FIRMAS',
        'NOMBRE_DISTRIBUIDOR','CODIGO_DISTRIBUIDOR','NOMBRE_ENGANCHADOR','CODIGO_ENGANCHADOR'
      ];

      // Build keys respecting preferred order (keys in data may have same names or lowercase variants)
      const keys = buildColumnsFromRows(parsedRows, preferredOrder);
      ws.columns = keys.map(k => ({ header: k.toUpperCase(), key: k, width: 20 }));

      parsedRows.forEach((r: any) => ws.addRow(r));

      ws.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const l = cell.value ? String(cell.value).length : 10;
          if (l > maxLength) maxLength = l;
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=firmas_enganchador_${codigo_enganchador}_${fechaInicioString}_${fechaFinString}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    return res.json(parsedRows);
  } catch (err: any) {
    console.error('[obtenerFirmasPorEnganchador] Error al ejecutar procedimiento remoto:', err?.message || err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

/**
 * Endpoint que llama al procedimiento FirmasporVencer en la BD 2 (DB_*_2)
 */
export const obtenerFirmasEstado = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, estado = 'Todos', page, pageSize, generarExcel = false } = req.body || {};
  
  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: 'Debes proporcionar ambas fechas.' });
  }
  
  try {
    // Comprobar que la conexión a la BD local está disponible antes de ejecutar el CALL
    let useAltConnection = false;
    try {
      await connection_firmas.authenticate();
    } catch (connErr: any) {
      console.error('[FIRMAS_2] No se puede conectar a la BD local:', connErr?.message || connErr);
      console.warn('[FIRMAS_2] Intentando fallback a DB_1 (remota)');
      useAltConnection = true;
    }
    // Verificación de conexión: asegurar que esta llamada usa la DB local (DB_*_2)
    try {
      const infoRes: any = await connection_firmas.query(
        'SELECT DATABASE() AS db, @@hostname AS hostname, @@port AS port, USER() AS user',
        { type: QueryTypes.SELECT }
      );
      let row: any = null;
      if (Array.isArray(infoRes)) {
        row = Array.isArray(infoRes[0]) ? infoRes[0][0] : infoRes[0];
      } else {
        row = infoRes;
      }
      console.log(`[FIRMAS_2 DB verificar] ENV host=${process.env.DB_HOST_2}:${process.env.DB_PORT_2} user=${process.env.DB_USER_2} db=${process.env.DB_NAME_2} | SERVER db=${row?.db} hostname=${row?.hostname} port=${row?.port} user=${row?.user}`);
    } catch (e: any) {
      console.warn('[FIRMAS_2 DB verificar] No se pudo obtener info DB:', e?.message || e);
    }

    // Intentar múltiples nombres de procedimientos posibles
    const schema2 = process.env.DB_NAME_2 || '';
    const possibleProcedures = [
      'FirmasporVencer',
      'Firmas_por_Vencer', 
      'obtener_firmas_por_vencer',
      'obtener_FirmasporVencer',
      'sp_FirmasporVencer'
    ];

    let raw: any;
    let procedureFound = false;
    
    if (!useAltConnection) {
      // Probar cada procedimiento en conexión local
      for (const procName of possibleProcedures) {
        try {
          const callSql = schema2 ? `CALL \`${schema2}\`.${procName}(?, ?, ?)` : `CALL ${procName}(?, ?, ?)`;
          console.log(`[FIRMAS_2] Probando procedimiento: ${callSql}`);
          raw = await connection_firmas.query(callSql, {
            replacements: [fecha_inicio, fecha_fin, estado],
            type: QueryTypes.SELECT,
          });
          console.log(`[FIRMAS_2] ✓ Procedimiento encontrado: ${procName}`);
          procedureFound = true;
          break;
        } catch (err: any) {
          if (err.code === 'ER_SP_DOES_NOT_EXIST') {
            console.log(`[FIRMAS_2] ✗ Procedimiento ${procName} no existe, probando siguiente...`);
            continue;
          } else {
            throw err; // Si es otro error, lanzarlo
          }
        }
      }
    } else {
      // Fallback a DB_1 (remota) probando procedimientos
      const host1 = process.env.DB_HOST_1;
      const port1 = Number(process.env.DB_PORT_1) || 3306;
      const user1 = process.env.DB_USER_1;
      const pass1 = process.env.DB_PASS_1;
      const name1 = process.env.DB_NAME_1;
      const dialect1 = (process.env.DB_DIALECT_1 as any) || 'mysql';

      const altSequelize = new Sequelize(name1 as string, user1 as string, pass1 as string, {
        host: host1,
        port: port1,
        dialect: dialect1 as any,
        logging: false,
      });

      try {
        await altSequelize.authenticate();
        for (const procName of possibleProcedures) {
          try {
            const callSql1 = name1 ? `CALL \`${name1}\`.${procName}(?, ?, ?)` : `CALL ${procName}(?, ?, ?)`;
            console.log(`[FIRMAS_2 Fallback] Probando procedimiento: ${callSql1}`);
            raw = await altSequelize.query(callSql1, { replacements: [fecha_inicio, fecha_fin, estado], type: QueryTypes.SELECT });
            console.log(`[FIRMAS_2 Fallback] ✓ Procedimiento encontrado: ${procName}`);
            procedureFound = true;
            break;
          } catch (err: any) {
            if (err.code === 'ER_SP_DOES_NOT_EXIST') {
              console.log(`[FIRMAS_2 Fallback] ✗ Procedimiento ${procName} no existe, probando siguiente...`);
              continue;
            } else {
              throw err;
            }
          }
        }
        if (procedureFound) {
          console.log('[FIRMAS_2] Fallback exitoso usando DB_1');
        }
      } catch (altErr: any) {
        console.error('[FIRMAS_2] Fallback a DB_1 falló:', altErr?.message || altErr);
        throw altErr;
      } finally {
        try { await altSequelize.close(); } catch (_) {}
      }
    }

    if (!procedureFound) {
      throw new Error(`Ningún procedimiento encontrado. Probados: ${possibleProcedures.join(', ')}`);
    }

    // Normalizar resultados y parsear JSON embebido para evitar que todo quede en una sola celda
    let filas = normalizeResults(raw);

    // Si el resultado viene como objeto con claves numéricas, convertir a array
    if (filas.length > 0 && typeof filas[0] === 'object' && !Array.isArray(filas[0])) {
      const firstItem = filas[0];
      const keys = Object.keys(firstItem);
      if (keys.length > 0 && keys.every(key => !isNaN(Number(key)))) {
        console.log('[normalizeResults] Detectado objeto con claves numéricas en FirmasEstado, convirtiendo a array');
        filas = Object.values(firstItem);
      }
    }

    // Parsear cada fila si viene como string JSON o como objeto con un único campo JSON
    const parsedRows = filas.map((row: any) => {
      if (typeof row === 'string') {
        try { return JSON.parse(row); } catch { return { valor: row }; }
      }
      if (row && typeof row === 'object') {
        const values = Object.values(row);
        if (values.length === 1 && typeof values[0] === 'string') {
          try { return JSON.parse(values[0] as string); } catch { return row; }
        }
      }
      return row;
    });

    console.log(`[obtenerFirmasEstado] Total de registros: ${parsedRows.length}. ¿Generar Excel?: ${generarExcel}`);

    if (generarExcel) {
      console.log('[Excel FirmasEstado] Iniciando generación de Excel...');

      if (!parsedRows || parsedRows.length === 0) {
        console.log('[Excel FirmasEstado] ERROR: No hay datos para exportar');
        return res.status(404).json({ error: 'No hay datos para exportar' });
      }

      // Crear libro de trabajo de Excel
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Firmas por Estado');

      const columnas = Object.keys(parsedRows[0]);

      // Configurar las columnas de Excel
      worksheet.columns = columnas.map(key => ({
        header: key.toUpperCase(),
        key: key,
        width: 15
      }));

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      };

      // Agregar las filas de datos al Excel
      parsedRows.forEach((row: any) => {
        worksheet.addRow(row);
      });

      // Ajustar el ancho de las columnas automáticamente
      worksheet.columns.forEach(column => {
        let maxLength = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const columnLength = cell.value ? cell.value.toString().length : 10;
          if (columnLength > maxLength) {
            maxLength = columnLength;
          }
        });
        column.width = maxLength < 10 ? 10 : maxLength + 2;
      });

      // Configurar los encabezados para la descarga del archivo
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=firmas_estado_${fecha_inicio}_${fecha_fin}.xlsx`);
      
      console.log('[Excel FirmasEstado] Headers configurados, escribiendo archivo...');

      // Escribir el archivo en la respuesta
      await workbook.xlsx.write(res);
      res.end();

      console.log('[Excel FirmasEstado] Archivo Excel generado y enviado exitosamente');
      return;
    } else {
      // Si no se requiere generar Excel, devolver datos paginados en formato JSON
      const p = Math.max(1, parseInt(String(page || '1'), 10));
      const ps = Math.max(1, parseInt(String(pageSize || '50'), 10));
      const total = parsedRows.length;
      const totalPages = Math.max(1, Math.ceil(total / ps));
      const start = (p - 1) * ps;
      const items = parsedRows.slice(start, start + ps);

      console.log('[JSON FirmasEstado] Devolviendo datos paginados en formato JSON');
      return res.json({ items, total, page: p, pageSize: ps, totalPages });
    }
  } catch (err) {
    console.error('Error obtenerFirmasEstado:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
};
