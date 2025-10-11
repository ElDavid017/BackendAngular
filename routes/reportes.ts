import { Router } from 'express';
import {
  obtenerRegistrosPorFechas,
  obtenerRegistrosFirmasFactura,
  obtenerReporteDistribuidores,
  obtenerFirmasEstado,
} from '../Controles/firmas/rep_firmas';
import { login } from '../Controles/login/login';


const router = Router();

/**
 * Reportes de Firmas esto es un edpoint 
 */
router.post('/obtener-registros', obtenerRegistrosPorFechas);
router.post('/obtener-firmas-factura', obtenerRegistrosFirmasFactura);
router.post('/obtener-distribuidores', obtenerReporteDistribuidores);
router.post('/login', login);
router.post('/firmas-estado', obtenerFirmasEstado);


export default router;
