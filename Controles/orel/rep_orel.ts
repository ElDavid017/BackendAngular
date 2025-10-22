import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import ExcelJS from 'exceljs';
import connection_orel from '../../database/connection_orel';

// helper simple para normalizar resultados
function normalizeResults(raw: any): any[] {
  if (!raw) return [];
  const metadataKeys = new Set(['fieldCount','affectedRows','insertId','info','serverStatus','warningStatus','changedRows']);
  const isOkPacket = (obj: any) => {
    if (!obj || typeof obj !== 'object') return false;
    const keys = Object.keys(obj);
    return keys.length > 0 && keys.every(k => metadataKeys.has(k));
  };

  let res: any[] = [];
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (Array.isArray(raw[0])) res = raw[0];
    else res = raw.filter((r: any) => !isOkPacket(r));
  } else {
    res = [raw];
  }

  if (res.length > 0 && typeof res[0] === 'object' && !Array.isArray(res[0])) {
    const keys = Object.keys(res[0]);
    if (keys.length > 0 && keys.every(k => !isNaN(Number(k)))) return Object.values(res[0]);
  }

  res = res.filter(r => !isOkPacket(r));
  return res;
}

function buildColumnsFromRows(rows: any[], preferredOrder: string[] = []): string[] {
  if (!rows || rows.length === 0) return [];
  const keySet = new Set<string>();
  for (const k of preferredOrder) {
    for (const r of rows) {
      if (r && Object.prototype.hasOwnProperty.call(r, k)) { keySet.add(k); break; }
    }
  }
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) if (!keySet.has(k)) keySet.add(k);
    }
  }
  return Array.from(keySet);
}

/**
 * ComplementoCaducar
 * Llama al procedimiento `ConsultarRegistrosPorCaducar(fecha_inicio, fecha_fin)` en la BD orel_complemento
 * Body: fecha_inicio, fecha_fin, generarExcel (opcional)
 */
export const ComplementoCaducar = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel = false } = req.body || {};

  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Las fechas son requeridas' });

  const fechaInicioString = new Date(fecha_inicio).toISOString().split('T')[0];
  const fechaFinString = new Date(fecha_fin).toISOString().split('T')[0];

  console.log('[ComplementoCaducar] Petición:', { fechaInicioString, fechaFinString, generarExcel });

  try {
    // Intentar llamar al procedimiento en la conexión Orel
    const raw = await connection_orel.query(
      'CALL ConsultarRegistrosPorCaducar(?, ?)',
      { replacements: [fechaInicioString, fechaFinString], type: QueryTypes.SELECT }
    );

    let rows = normalizeResults(raw);

    // manejar caso de objeto con claves numéricas
    if (rows.length > 0 && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
      const keys = Object.keys(rows[0]);
      if (keys.length > 0 && keys.every(k => !isNaN(Number(k)))) rows = Object.values(rows[0]);
    }

      let parsedRows = rows.map((row: any) => {
      if (typeof row === 'string') {
        try { return JSON.parse(row); } catch { return { valor: row }; }
      }
      if (row && typeof row === 'object') {
        const vals = Object.values(row);
        if (vals.length === 1 && typeof vals[0] === 'string') {
          try { return JSON.parse(vals[0] as string); } catch { return row; }
        }
      }
      return row;
    });
      parsedRows = parsedRows.filter(r => {
        if (r == null) return false;
        if (typeof r === 'object' && Object.keys(r).length === 0) return false;
        return true;
      });

    console.log(`[ComplementoCaducar] Filas encontradas: ${parsedRows.length}`);

    if (generarExcel) {
      if (!parsedRows || parsedRows.length === 0) return res.status(404).json({ error: 'No hay datos para exportar' });

      const workbook = new ExcelJS.Workbook();
      const ws = workbook.addWorksheet('Complemento Caducar');

      const preferred = [
        'IDREGISTRO','REGUSERNAME','REGRUC','REGPLAN','CORREO','TELEFONO','VIGENCIA','BOT_RECIBIDOS','BOT_EMITIDOS',
        'REGUSER','FECHA_INICIO','FECHA_CADUCIDAD','REGCIUDAD','REGRAZON','REGPAGO','FECHA_REGDEMO','COMENTARIO',
        'CONTROL','PRECIO','OBSERVACION','LICENCIA','BANCO','NRO_COMPROBANTE','CODIGO_UNICO','ESTADO'
      ];

      const keys = buildColumnsFromRows(parsedRows, preferred);
      ws.columns = keys.map(k => ({ header: k.toUpperCase(), key: k, width: 20 }));

      parsedRows.forEach((r: any) => ws.addRow(r));

      ws.columns.forEach(column => {
        let max = 0;
        column.eachCell({ includeEmpty: true }, cell => {
          const l = cell.value ? String(cell.value).length : 10;
          if (l > max) max = l;
        });
        column.width = max < 10 ? 10 : max + 2;
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=complemento_caducar_${fechaInicioString}_${fechaFinString}.xlsx`);
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    return res.json(parsedRows);
  } catch (err: any) {
    console.error('[ComplementoCaducar] Error al ejecutar procedimiento:', err?.message || err);
    return res.status(500).json({ error: 'Error en la base de datos', message: err?.message });
  }
};

export default {};
