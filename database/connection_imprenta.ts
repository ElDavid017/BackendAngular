import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const {
  DB_NAME_3,
  DB_USER_3,
  DB_PASS_3,
  DB_HOST_3,
  DB_DIALECT_3,
  DB_PORT_3
} = process.env;

// Log de diagnóstico para verificar variables del entorno usadas por la conexión de imprenta
console.log('[imprenta][env] host:', DB_HOST_3, 'port:', DB_PORT_3, 'user:', DB_USER_3, 'db:', DB_NAME_3, 'dialect:', DB_DIALECT_3);

// Crear la instancia de conexión Sequelize
const database = new Sequelize(
  DB_NAME_3 as string,
  DB_USER_3 as string,
  DB_PASS_3 as string,
  {
    host: DB_HOST_3,
    dialect: (DB_DIALECT_3 as any) || 'mysql',
    port: Number(DB_PORT_3),
    logging: false, // Desactiva logs SQL en consola
  }
);

export default database;
