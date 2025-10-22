import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const {
  DB_NAME_5,
  DB_USER_5,
  DB_PASS_5,
  DB_HOST_5,
  DB_DIALECT_5,
  DB_PORT_5,
} = process.env;

const connection_plantillas = new Sequelize(
  DB_NAME_5 as string,
  DB_USER_5 as string,
  DB_PASS_5 as string,
  {
    host: DB_HOST_5,
    port: Number(DB_PORT_5) || 3306,
    dialect: (DB_DIALECT_5 as any) || 'mysql',
    logging: false,
  }
);

export default connection_plantillas;
