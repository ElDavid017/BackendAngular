import { Sequelize } from "sequelize";
import dotenv from "dotenv";

// Cargar variables de entorno desde el archivo .env
dotenv.config();

const { DB_HOST_1, DB_PORT_1, DB_USER_1, DB_PASS_1, DB_NAME_1 } = process.env;

// Crear la instancia de conexión Sequelize
const database = new Sequelize(
  DB_NAME_1 as string,
  DB_USER_1 as string,
  DB_PASS_1 as string,
  {
    host: DB_HOST_1,
    dialect: (process.env.DB_DIALECT_1 as any) || "mysql",
    port: Number(DB_PORT_1),
    logging: false, // Desactiva logs SQL en consola
  }
);

export default database;
