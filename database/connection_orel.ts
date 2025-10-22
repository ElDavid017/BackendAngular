import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const {
  DB_NAME_4,
  DB_USER_4,
  DB_PASS_4,
  DB_HOST_4,
  DB_DIALECT_4,
  DB_PORT_4,
} = process.env;

const connection_orel = new Sequelize(
  DB_NAME_4 as string,
  DB_USER_4 as string,
  DB_PASS_4 as string,
  {
    host: DB_HOST_4,
    port: Number(DB_PORT_4) || 3306,
    dialect: (DB_DIALECT_4 as any) || 'mysql',
    logging: false,
  }
);

export default connection_orel;
