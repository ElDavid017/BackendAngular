import express, { Application } from 'express';
import reportesRoutes from '../routes/reportes';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import database from '../database/connection_firmas';

class Server {
  private app: Application;
  private port: string;
  private paths = {
    reportes: '/api/reportes',
  };

  constructor() {
    this.app = express();
    this.port = process.env.PORT || '8000';

    // Inicializaciones
    this.middlewares();
    this.routes();
  }

  /**
   * Conexión a la base de datos
   */
  async dbConnection(): Promise<void> {
    try {
      await database.authenticate();
      console.log('✅ Database online');
    } catch (error: any) {
      console.error('❌ Error al conectar a la base de datos:', error);
      throw new Error(error);
    }
  }

  /**
   * Middlewares globales
   */
  private middlewares(): void {
    // CORS
    this.app.use(cors({
      origin: 'https://begroupec-tech.com',
      credentials: true,
    }));

    // Parseo del cuerpo de las peticiones
    this.app.use(express.json());

    // Carpeta pública
    this.app.use(express.static('public'));
  }

  /**
   * Definición de rutas
   */
  private routes(): void {
    this.app.use(this.paths.reportes, reportesRoutes);
  }

  /**
   * Inicializar el servidor HTTPS
   */
  listen(): void {
    const options = {
      key: fs.readFileSync('/etc/private/key/server_orel.key'),
      cert: fs.readFileSync('/etc/private/key/begroupec_tech_com.crt'),
    };

    https.createServer(options, this.app).listen(this.port, () => {
      console.log(`🚀 Servidor corriendo en puerto ${this.port} usando HTTPS`);
    });
  }
}

export default Server;
