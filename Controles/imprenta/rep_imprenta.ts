import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import ExcelJS from 'exceljs';
import connection_imprenta from '../../database/connection_imprenta';

// Normaliza resultados de CALL (array anidado, objeto con claves numéricas, etc.)
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

    // Si la primera fila es un objeto con claves numéricas (0,1,2,...) convertir a array
    if (res.length > 0 && typeof res[0] === 'object' && !Array.isArray(res[0])) {
        const keys = Object.keys(res[0]);
        if (keys.length > 0 && keys.every(k => !isNaN(Number(k)))) {
            return Object.values(res[0]) as any[];
        }
    }

    // Filtrar cualquier ok-packet que pudiera quedar
    res = res.filter(r => !isOkPacket(r));
    return res;
}

// Parsear filas cuando vienen como string JSON dentro de una única columna
function parseJsonRows(rows: any[]): any[] {
    const parsed = rows.map(row => {
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
    // Filtrar objetos vacíos y nulos
    return parsed.filter(r => {
        if (r == null) return false;
        if (typeof r === 'object' && Object.keys(r).length === 0) return false;
        return true;
    });
}

// Campos esperados del procedimiento obtener_PagosFacturadores
const EXPECTED_COLUMNS = [
    'RUC',
    'RAZON_SOCIAL',
    'TELEFONO',
    'FECHA_REG_PLAN',
    'PLAN',
    'VALOR_PAGO',
    'USADOS',
    'FECHA_CAD_PLAN',
    'Codigo_Distribuidor',
    'RUC_Distribuidor',
    'Nombre_Distribuidor',
    'Telefono_Distribuidor',
    'Correo_Distribuidor',
];

export const obtenerPagosFacturadores = async (req: Request, res: Response) => {
    const { fecha_inicio, fecha_fin, generarExcel } = req.body || {};

    console.log('[imprenta] obtenerPagosFacturadores:', { fecha_inicio, fecha_fin, generarExcel });

    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ error: 'Debes proporcionar fecha_inicio y fecha_fin.' });
    }

    try {
        // Verificación de la conexión actual (DB/host/puerto/usuario)
        try {
            const infoRes: any = await connection_imprenta.query(
                'SELECT DATABASE() AS db, @@hostname AS hostname, @@port AS port, USER() AS user',
                { type: QueryTypes.SELECT }
            );
            let row: any = null;
            if (Array.isArray(infoRes)) {
                row = Array.isArray(infoRes[0]) ? infoRes[0][0] : infoRes[0];
            } else {
                row = infoRes;
            }
            console.log(`[IMPRENTA DB verificar] ENV host=${process.env.DB_HOST_3}:${process.env.DB_PORT_3} user=${process.env.DB_USER_3} db=${process.env.DB_NAME_3} | SERVER db=${row?.db} hostname=${row?.hostname} port=${row?.port} user=${row?.user}`);
        } catch (e: any) {
            console.warn('[IMPRENTA DB verificar] No se pudo obtener info DB:', e?.message || e);
        }

        // Asegurar que se invoque en el esquema correcto. Si el servidor reporta una DB distinta, prefijamos con DB_NAME_3
        const schema = process.env.DB_NAME_3 || '';
        const callSql = schema ? `CALL \`${schema}\`.obtener_PagosFacturadores(?, ?)` : 'CALL obtener_PagosFacturadores(?, ?)';
        const raw = await connection_imprenta.query(callSql, {
            replacements: [fecha_inicio, fecha_fin],
            type: QueryTypes.SELECT,
        });

        const normalized = normalizeResults(raw);
        const rows = parseJsonRows(normalized);

        if (generarExcel) {
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: 'No hay datos para exportar' });
            }

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Pagos Facturadores');

            const columnas = EXPECTED_COLUMNS.filter(c => c in rows[0]);
            const headers = (columnas.length ? columnas : Object.keys(rows[0]));

            worksheet.columns = headers.map(key => ({ header: key.toUpperCase(), key, width: 18 }));
            worksheet.getRow(1).font = { bold: true };
            worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3D3D3' } };

            rows.forEach(r => worksheet.addRow(r));

            worksheet.columns.forEach(col => {
                let max = 10;
                col.eachCell({ includeEmpty: true }, cell => {
                    const len = (cell.value ? String(cell.value) : '').length;
                    if (len > max) max = len;
                });
                col.width = Math.min(Math.max(max + 2, 10), 60);
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=pagos_facturadores_${fecha_inicio}_${fecha_fin}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
            return;
        }

        return res.json(rows);
    } catch (err: any) {
        console.error('[imprenta] Error obtenerPagosFacturadores:', err);
        return res.status(500).json({ error: 'Error en la base de datos', message: err.message || 'Error' });
    }
};

// Endpoint: obtenerEmisoresPorFechas
export const obtenerEmisoresPorFechas = async (req: Request, res: Response) => {
    const { fecha_inicio, fecha_fin, generarExcel, page, pageSize } = req.body || {};

    console.log('[imprenta] obtenerEmisoresPorFechas:', { fecha_inicio, fecha_fin, generarExcel, page, pageSize });

    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ error: 'Debes proporcionar fecha_inicio y fecha_fin.' });
    }

    try {
        // Verificar conexión/entorno
        try {
            const infoRes: any = await connection_imprenta.query(
                'SELECT DATABASE() AS db, @@hostname AS hostname, @@port AS port, USER() AS user',
                { type: QueryTypes.SELECT }
            );
            let row: any = null;
            if (Array.isArray(infoRes)) {
                row = Array.isArray(infoRes[0]) ? infoRes[0][0] : infoRes[0];
            } else {
                row = infoRes;
            }
            console.log(`[IMPRENTA DB verificar] ENV host=${process.env.DB_HOST_3}:${process.env.DB_PORT_3} user=${process.env.DB_USER_3} db=${process.env.DB_NAME_3} | SERVER db=${row?.db} hostname=${row?.hostname} port=${row?.port} user=${row?.user}`);
        } catch (e: any) {
            console.warn('[IMPRENTA DB verificar] No se pudo obtener info DB:', e?.message || e);
        }

        const schema = process.env.DB_NAME_3 || '';
        const callSql = schema ? `CALL \`${schema}\`.obtenerEmisoresPorFechas(?, ?)` : 'CALL obtenerEmisoresPorFechas(?, ?)';

        const raw: any = await connection_imprenta.query(callSql, {
            replacements: [fecha_inicio, fecha_fin],
            type: QueryTypes.SELECT,
        });

        const normalized = normalizeResults(raw);
        const rows = parseJsonRows(normalized);

        // Si se solicita Excel
        if (generarExcel) {
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: 'No hay datos para exportar' });
            }

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Emisores por Fechas');

            const headers = Object.keys(rows[0] || {});
            worksheet.columns = headers.map(key => ({ header: key.toUpperCase(), key, width: 20 }));
            worksheet.getRow(1).font = { bold: true };

            rows.forEach(r => worksheet.addRow(r));

            worksheet.columns.forEach(col => {
                let max = 10;
                col.eachCell({ includeEmpty: true }, cell => {
                    const len = (cell.value ? String(cell.value) : '').length;
                    if (len > max) max = len;
                });
                col.width = Math.min(Math.max(max + 2, 10), 80);
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=emisores_${fecha_inicio}_${fecha_fin}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
            return;
        }

        // Paginación
        const p = Math.max(1, parseInt(String(page || '1'), 10));
        const ps = Math.max(1, parseInt(String(pageSize || '50'), 10));
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / ps));
        const start = (p - 1) * ps;
        const items = rows.slice(start, start + ps);

        return res.json({ items, total, page: p, pageSize: ps, totalPages });
    } catch (err: any) {
        console.error('[imprenta] Error obtenerEmisoresPorFechas:', err);
        return res.status(500).json({ error: 'Error en la base de datos', message: err.message || 'Error' });
    }
};

// Endpoint: obtenerAuditoriaPlanesPorFechas
export const obtenerAuditoriaPlanesPorFechas = async (req: Request, res: Response) => {
    const { fecha_inicio, fecha_fin, generarExcel, page, pageSize } = req.body || {};

    console.log('[imprenta] obtenerAuditoriaPlanesPorFechas:', { fecha_inicio, fecha_fin, generarExcel, page, pageSize });

    if (!fecha_inicio || !fecha_fin) {
        return res.status(400).json({ error: 'Debes proporcionar fecha_inicio y fecha_fin.' });
    }

    try {
        // Verificar conexión/entorno
        try {
            const infoRes: any = await connection_imprenta.query(
                'SELECT DATABASE() AS db, @@hostname AS hostname, @@port AS port, USER() AS user',
                { type: QueryTypes.SELECT }
            );
            let row: any = null;
            if (Array.isArray(infoRes)) {
                row = Array.isArray(infoRes[0]) ? infoRes[0][0] : infoRes[0];
            } else {
                row = infoRes;
            }
            console.log(`[IMPRENTA DB verificar] ENV host=${process.env.DB_HOST_3}:${process.env.DB_PORT_3} user=${process.env.DB_USER_3} db=${process.env.DB_NAME_3} | SERVER db=${row?.db} hostname=${row?.hostname} port=${row?.port} user=${row?.user}`);
        } catch (e: any) {
            console.warn('[IMPRENTA DB verificar] No se pudo obtener info DB:', e?.message || e);
        }

        const schema = process.env.DB_NAME_3 || '';
        const callSql = schema ? `CALL \`${schema}\`.obtenerAuditoriaPlanesPorFechas(?, ?)` : 'CALL obtenerAuditoriaPlanesPorFechas(?, ?)';

        const raw: any = await connection_imprenta.query(callSql, {
            replacements: [fecha_inicio, fecha_fin],
            type: QueryTypes.SELECT,
        });

        const normalized = normalizeResults(raw);
        const rows = parseJsonRows(normalized);

        if (generarExcel) {
            if (!rows || rows.length === 0) {
                return res.status(404).json({ error: 'No hay datos para exportar' });
            }

            const workbook = new ExcelJS.Workbook();
            const worksheet = workbook.addWorksheet('Auditoria Planes');

            const headers = Object.keys(rows[0] || {});
            worksheet.columns = headers.map(key => ({ header: key.toUpperCase(), key, width: 20 }));
            worksheet.getRow(1).font = { bold: true };

            rows.forEach(r => worksheet.addRow(r));

            worksheet.columns.forEach(col => {
                let max = 10;
                col.eachCell({ includeEmpty: true }, cell => {
                    const len = (cell.value ? String(cell.value) : '').length;
                    if (len > max) max = len;
                });
                col.width = Math.min(Math.max(max + 2, 10), 80);
            });

            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename=auditoria_planes_${fecha_inicio}_${fecha_fin}.xlsx`);
            await workbook.xlsx.write(res);
            res.end();
            return;
        }

        // Paginación
        const p = Math.max(1, parseInt(String(page || '1'), 10));
        const ps = Math.max(1, parseInt(String(pageSize || '50'), 10));
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / ps));
        const start = (p - 1) * ps;
        const items = rows.slice(start, start + ps);

        return res.json({ items, total, page: p, pageSize: ps, totalPages });
    } catch (err: any) {
        console.error('[imprenta] Error obtenerAuditoriaPlanesPorFechas:', err);
        return res.status(500).json({ error: 'Error en la base de datos', message: err.message || 'Error' });
    }
};
