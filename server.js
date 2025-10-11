// server.js
const express = require('express');
const app = express();
const PORT = 3000;

// Middleware para manejar JSON
app.use(express.json());

// Middleware para evitar error 400 en recargas SPA: redirigir GET HTML al frontend
// IMPORTANTE: debe estar ANTES de todas las rutas para interceptar peticiones de navegador
app.use((req, res, next) => {
  // Si es GET y acepta HTML (navegador recargando ruta SPA), redirigir al frontend
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.indexOf('html') !== -1) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    console.log('Redirigiendo petición HTML GET', req.url, '->', frontendUrl + req.originalUrl);
    return res.redirect(302, frontendUrl + req.originalUrl);
  }
  next();
});

// registrar routes (cargar directamente el archivo TypeScript; ts-node debe estar registrado al arrancar)
const reportesRouter = require('./routes/reportes.ts').default || require('./routes/reportes.ts');
app.use('/', reportesRouter);

// Ruta de prueba (después de las rutas de API)
app.get('/', (req, res) => {
  res.send('Servidor backend funcionando ');
});

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});