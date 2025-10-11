import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const { DB_HOST_2, DB_PORT_2, DB_USER_2, DB_PASS_2, DB_NAME_2, DB_DIALECT_2 } = process.env;

const database2 = new Sequelize(
  DB_NAME_2 as string,
  DB_USER_2 as string,
  DB_PASS_2 as string,
  {
    host: DB_HOST_2,
    dialect: (DB_DIALECT_2 as any) || 'mysql',
    port: Number(DB_PORT_2) || 3306,
    logging: false,
  }
);

export default database2;
