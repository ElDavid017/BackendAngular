import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import ExcelJS from 'exceljs';
import connection from '../../database/connection_firmador';
import connection_firmas_2 from '../../database/connection_firmas_2';

// helper para normalizar resultados (siempre devolver array de filas)
function normalizeResults(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    if (raw.length === 0) return [];
    if (Array.isArray(raw[0])) return raw[0];
    return raw as any[];
  }
  return [raw];
}
/**
 *  Obtener registros por rango de fechas
 */
export const obtenerRegistrosPorFechas = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, generarExcel } = req.body;

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
      'CALL obtener_registros_por_fechas(?, ?)',
      {
        replacements: [fechaInicioString, fechaFinString],
        type: QueryTypes.SELECT,
      }
    );
    // Si se desea generar Excel
    if (generarExcel) {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Registros por Fechas');
      // Definir columnas
      worksheet.columns = Object.keys(results[0]).map(key => ({ header: key, key }));
      // Agregar filas
      results.forEach((row: any) => {
        worksheet.addRow(row);
      });
      // Enviar archivo Excel como respuesta
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename=registros_fechas.xlsx');
      // Generar y enviar el archivo
      await workbook.xlsx.write(res);
        res.end();
    }else{
      return res.json(results);

        }
  
  } catch (err) {
    console.error('Error al llamar el procedimiento:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
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
      'CALL firmasecuador.obtener_firmas_factura_fechas(?, ?)',
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

// Endpoint que llama al procedimiento FirmasporVencer en la BD 2 (DB_*_2)
export const obtenerFirmasEstado = async (req: Request, res: Response) => {
  const { fecha_inicio, fecha_fin, estado = 'Todos', page, pageSize } = req.body || {};
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ error: 'Debes proporcionar ambas fechas.' });

  try {
    const raw: any = await connection_firmas_2.query('CALL FirmasporVencer(?, ?, ?)', {
      replacements: [fecha_inicio, fecha_fin, estado],
      type: QueryTypes.SELECT,
    });

    const filas = normalizeResults(raw);

    const p = Math.max(1, parseInt(String(page || '1'), 10));
    const ps = Math.max(1, parseInt(String(pageSize || '50'), 10));
    const total = filas.length;
    const totalPages = Math.max(1, Math.ceil(total / ps));
    const start = (p - 1) * ps;
    const items = filas.slice(start, start + ps);

    return res.json({ items, total, page: p, pageSize: ps, totalPages });
  } catch (err) {
    console.error('Error obtenerFirmasEstado:', err);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
};
