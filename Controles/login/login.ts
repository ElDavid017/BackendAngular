import { Request, Response } from 'express';
import crypto from 'crypto';
import connection from '../../database/connection_firmas';
import { QueryTypes } from 'sequelize';

/**
 * validateUser: consulta la base de datos para validar usuario y clave
 * - Ajusta el SQL/tabla según tu esquema real de usuarios.
 * - Usa replacements para evitar inyección SQL.
 */
async function validateUser(Usuario: string, Clave: string) {
  // Intentamos primero la tabla conocida. Si no existe, hacemos detección dinámica.
  const defaultSql = `SELECT USUIDENTIFICACION, USUNOMBRE, USUCLAVE, USUAPELLIDO, COMCODIGO, USUPERFIL, telefono, correo FROM SEG_MAEUSUARIO WHERE USUIDENTIFICACION = ? LIMIT 1`;

  async function tryQuery(sql: string, replacements: any[]) {
    const results: any = await connection.query(sql, {
      replacements,
      type: QueryTypes.SELECT,
    });
    // Normalizar distintos formatos que puede devolver Sequelize/CALL
    let user: any = null;
    if (Array.isArray(results)) {
      if (results.length > 0) {
        user = Array.isArray(results[0]) ? results[0][0] : results[0];
      }
    } else {
      user = results;
    }
    return user || null;
  }

  try {
    // 1) Intento directo a la tabla esperada
    const user = await tryQuery(defaultSql, [Usuario]);
    if (user) {
      console.log('[validateUser] user row (default):', user);
      const provided = (Clave || '').toString().trim();
      const storedName = (user.USUNOMBRE || '').toString().trim();
      if (storedName === provided) return user;
      return null;
    }
    // Si no hubo resultado pero tampoco error de tabla inexistente, retornar null
  } catch (err: any) {
    // Si la tabla no existe, seguimos con detección; en caso contrario, relanzamos
    if (!(err && err.parent && err.parent.code === 'ER_NO_SUCH_TABLE')) {
      console.error('validateUser error (unexpected):', err);
      throw err; // error inesperado
    }
    console.log('[validateUser] tabla SEG_MAEUSUARIO no existe, intentando detección en information_schema...');
  }

  // 2) Detección dinámica: buscar una tabla que contenga 'usu' o 'user' en el esquema configurado
  const dbName = (process.env.DB_NAME_1 || process.env.DB_NAME || '').toString();
  if (!dbName) {
    console.warn('[validateUser] no se encontró DB_NAME_1 ni DB_NAME en el entorno');
    return null;
  }

  try {
    const findTableSql = `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND (TABLE_NAME LIKE '%usu%' OR TABLE_NAME LIKE '%user%') LIMIT 5`;
    const tables: any = await connection.query(findTableSql, {
      replacements: [dbName],
      type: QueryTypes.SELECT,
    });
    // `tables` puede venir como array de objetos o array anidado según la versión; normalizamos
    const tableNames = Array.isArray(tables)
      ? tables.map((t: any) => (t.TABLE_NAME ? t.TABLE_NAME : Object.values(t)[0])).filter(Boolean)
      : [];

    if (!tableNames || tableNames.length === 0) {
      console.warn('[validateUser] no se encontraron tablas candidatas de usuario');
      return null;
    }

    // Posibles patrones de columnas
    const idPatterns = [/ident/i, /cedu/i, /ced/i, /dni/i, /id$/i];
    const namePatterns = [/nombre/i, /name/i, /usuario/i, /user/i];
    const passPatterns = [/clave/i, /pass/i, /password/i];

    for (const tname of tableNames) {
      try {
        const descSql = `DESCRIBE \`${tname}\``;
        const cols: any = await connection.query(descSql, { type: QueryTypes.DESCRIBE });
        // cols puede venir como array o como objeto; extraemos los nombres
        const colNames = Array.isArray(cols) ? cols.map((c: any) => (c.Field ? c.Field : c)) : Object.keys(cols || {});

        // Buscar columnas candidatas
        const idCol = colNames.find((c: string) => idPatterns.some((p) => p.test(c))) || colNames.find((c: string) => /id/i.test(c));
        const nameCol = colNames.find((c: string) => namePatterns.some((p) => p.test(c)));
        const passCol = colNames.find((c: string) => passPatterns.some((p) => p.test(c)));

        // Construir lista de columnas a seleccionar
        const selectCols = new Set<string>();
        if (idCol) selectCols.add(idCol);
        if (nameCol) selectCols.add(nameCol);
        if (passCol) selectCols.add(passCol);
        if (colNames.includes('telefono')) selectCols.add('telefono');
        if (colNames.includes('correo')) selectCols.add('correo');

        // Si no identificamos columnas mínimas, intentamos seleccionar * (último recurso)
        const colsToSelect = selectCols.size > 0 ? Array.from(selectCols).join(', ') : '*';
        const dynamicSql = `SELECT ${colsToSelect} FROM \`${tname}\` WHERE ${idCol ? `\`${idCol}\`` : '1=0'} = ? LIMIT 1`;

        // Si no tenemos idCol, saltamos esta tabla
        if (!idCol) continue;

        const row: any = await connection.query(dynamicSql, {
          replacements: [Usuario],
          type: QueryTypes.SELECT,
        });

        // Normalizar resultado
        let userRow: any = null;
        if (Array.isArray(row)) {
          if (row.length > 0) {
            userRow = Array.isArray(row[0]) ? row[0][0] : row[0];
          }
        } else {
          userRow = row;
        }
        if (!userRow) continue;

        // Mapear a las claves esperadas por el resto del código
        const mapped: any = {};
        mapped.USUIDENTIFICACION = userRow[idCol];
        mapped.USUNOMBRE = nameCol ? userRow[nameCol] : (userRow[passCol] || userRow[idCol]);
        mapped.USUCLAVE = passCol ? userRow[passCol] : null;
        mapped.telefono = userRow.telefono || null;
        mapped.correo = userRow.correo || null;

        console.log(`[validateUser] usuario detectado en tabla ${tname}:`, mapped);

        const provided = (Clave || '').toString().trim();
        const storedName = (mapped.USUNOMBRE || '').toString().trim();
        if (storedName === provided) return mapped;
        // opción: comparar con clave si existe
        if (mapped.USUCLAVE && (mapped.USUCLAVE || '').toString().trim() === provided) return mapped;
        return null;
      } catch (e) {
        console.warn('[validateUser] fallo al inspeccionar tabla', tname, e?.message || e);
        continue; // probar siguiente tabla candidata
      }
    }

    return null;
  } catch (err) {
    console.error('validateUser detection error:', err);
    return null;
  }
}

export const login = async (req: Request, res: Response) => {
  const { Usuario, Clave } = req.body || {};
    console.log('[login] body received:', req.body);
  if (!Usuario || !Clave) {
    return res.status(400).json({ message: 'Usuario and Clave are required' });
  }

  try {
    const user = await validateUser(Usuario, Clave);
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Devuelve solo campos públicos
    const publicUser = {
      USUIDENTIFICACION: user.USUIDENTIFICACION,
      USUNOMBRE: user.USUNOMBRE,
      telefono: user.telefono || null,
      correo: user.correo || null,
    };

    // Generar un token simple para el frontend (no es una implementación JWT completa)
    const token = crypto.randomBytes(32).toString('hex');

    return res.json({ token, user: publicUser });
  } catch (err) {
    console.error('Login error', err);
    return res.status(500).json({ message: 'Server error' });
  }
};
  