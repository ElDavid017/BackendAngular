import { Router } from 'express';
import {
  obtenerRegistrosPorFechas,
  obtenerRegistrosFirmasFactura,
  obtenerReporteDistribuidores,
  obtenerFirmasEstado,
  filtroDistribuidoresPorFecha,
  cantidadFirmasPorDistribuidor,
  facturaPorFechas,
  obtenerFirmasGeneradasConFactura,
  FirmasVendidas,
  obtenerFirmasPorEnganchador,
} from '../Controles/firmas/rep_firmas';
import { ComplementoCaducar } from '../Controles/orel/rep_orel';
import { PlantillasCaducar } from '../Controles/plantillas/rep_plantillas';
import { login } from '../Controles/login/login';
import { obtenerPagosFacturadores } from '../Controles/imprenta/rep_imprenta';
import { obtenerEmisoresPorFechas } from '../Controles/imprenta/rep_imprenta';
import { obtenerAuditoriaPlanesPorFechas } from '../Controles/imprenta/rep_imprenta';



const router = Router();
///login 
router.post('/login', login);

/**
 * Reportes de Firmas esto es un edpoint 
 */
router.post('/obtener-registros', obtenerRegistrosPorFechas);
router.post('/factura-por-fechas', facturaPorFechas);
router.post('/firmas-generadas-factura', obtenerFirmasGeneradasConFactura);
router.post('/filtro-distribuidores', filtroDistribuidoresPorFecha);
router.post('/firmas-por-enganchador', obtenerFirmasPorEnganchador);

//esto es de la vista 
router.post('/firmas-vendidas', FirmasVendidas);


router.post('/obtener-firmas-factura', obtenerRegistrosFirmasFactura);
router.post('/obtener-distribuidores', obtenerReporteDistribuidores);

//este no vale 
router.post('/cantidad-firmas-distribuidor', cantidadFirmasPorDistribuidor);


// Orel - Complemento

router.post('/orel/complemento-caducar', ComplementoCaducar);
// Plantillas - Caducar
router.post('/plantillas/por-caducar', PlantillasCaducar);
///esto es prueba David
router.post('/firmas-estado', obtenerFirmasEstado);


// Imprenta
router.post('/imprenta/pagos-facturadores', obtenerPagosFacturadores);
router.post('/imprenta/auditoria-planes-por-fechas', obtenerAuditoriaPlanesPorFechas);
router.post('/imprenta/emisores-por-fechas', obtenerEmisoresPorFechas);



export default router;
// en en controldador o en el servicio despues llamar a esa ruta en el
//por cada application 