// Servidor local de la app de comprobantes: http://localhost:3000
// Uso: node server.js [--carpeta <ruta de Comprobantes>] [--datos <ruta de datos>] [--puerto 3000]

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import express from 'express';
import { Almacen } from './lib/almacen.js';
import { Catalogo } from './lib/catalogo.js';
import { contarNuevas, listarLocales } from './lib/escanear.js';
import { crearExcel } from './lib/excel.js';
import { normalizar, parseMonto } from './lib/extraer.js';
import { MODELO_POR_DEFECTO, estadoIA } from './lib/ia.js';
import { Procesador, cuentaConfiable, prepararOcr } from './lib/procesar.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const { values: opciones } = parseArgs({
  options: {
    carpeta: { type: 'string', default: path.join(AQUI, '..', 'Comprobantes') },
    datos: { type: 'string', default: path.join(AQUI, 'data') },
    puerto: { type: 'string', default: '3000' },
  },
});
const RAIZ = path.resolve(opciones.carpeta);
const DATOS = path.resolve(opciones.datos);
const PUERTO = Number(opciones.puerto);

fs.mkdirSync(RAIZ, { recursive: true });
prepararOcr();

const ARCHIVO_CONFIG = path.join(DATOS, 'config.json');
const config = { modeloIA: MODELO_POR_DEFECTO, ...(fs.existsSync(ARCHIVO_CONFIG) ? JSON.parse(fs.readFileSync(ARCHIVO_CONFIG, 'utf8')) : {}) };
const almacen = new Almacen(path.join(DATOS, 'movimientos.json'));
const catalogo = new Catalogo(path.join(DATOS, 'proveedores.json'));
const procesador = new Procesador(RAIZ, almacen, catalogo, () => config.modeloIA);

// Movimientos de la versión anterior (proveedor como texto): se pasan al catálogo.
for (const mov of almacen.movimientos) {
  if ('proveedorId' in mov) continue;
  mov.proveedorId = null;
  // Lo que ya confirmaste (revisado o corregido a mano) se conserva tal cual.
  if ((mov.estado === 'revisado' || mov.editados.includes('proveedor')) && mov.proveedor) {
    const r = catalogo.identificar({ nombreLeido: mov.proveedor });
    mov.proveedorId = r.id ?? catalogo.crear(mov.proveedor).id;
  }
}
const actualizados = await procesador.actualizarReglas();
if (actualizados) console.log(`Se volvieron a leer ${actualizados} comprobantes con las reglas nuevas.`);

// ---------- Utilidades ----------

const claveTexto = (t) => normalizar(t).replace(/[^a-z0-9]/g, '');

// Para cada movimiento, los otros que parecen el mismo: misma imagen, o misma referencia y valor.
function duplicados(movimientos) {
  const grupos = new Map();
  const clavesDe = (m) => {
    const claves = [`imagen:${m.hash}`];
    if (m.referencia && m.valor != null) claves.push(`ref:${claveTexto(m.referencia)}|${m.valor}`);
    return claves;
  };
  for (const m of movimientos) for (const c of clavesDe(m)) grupos.set(c, [...(grupos.get(c) || []), m.id]);
  const resultado = new Map();
  for (const m of movimientos) {
    const otros = new Set(clavesDe(m).flatMap((c) => grupos.get(c)));
    otros.delete(m.id);
    resultado.set(m.id, [...otros]);
  }
  return resultado;
}

// Versión liviana para la tabla (sin el texto del OCR). El nombre del proveedor sale del catálogo.
function resumen(m, dups) {
  const { ocr, leido, ...resto } = m;
  return { ...resto, proveedor: catalogo.nombreDe(m.proveedorId), duplicados: dups.get(m.id) || [] };
}

function ordenar(movimientos) {
  return [...movimientos].sort(
    (a, b) =>
      a.local.localeCompare(b.local) ||
      (a.fecha || '9999').localeCompare(b.fecha || '9999') ||
      a.archivo.localeCompare(b.archivo)
  );
}

function rutaSegura(mov) {
  const ruta = path.resolve(RAIZ, mov.archivo);
  if (!ruta.startsWith(RAIZ + path.sep)) throw new Error('Ruta fuera de la carpeta de comprobantes');
  return ruta;
}

function listaProveedores() {
  const cuenta = new Map();
  for (const m of almacen.movimientos) if (m.proveedorId) cuenta.set(m.proveedorId, (cuenta.get(m.proveedorId) || 0) + 1);
  return [...catalogo.proveedores]
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((p) => ({ ...p, comprobantes: cuenta.get(p.id) || 0 }));
}

const intentar = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// ---------- API ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(AQUI, 'public')));

app.get('/api/estado', async (req, res) => {
  const pendientesIA = almacen.movimientos.filter(
    (m) => m.estado === 'por_revisar' && m.ocr && m.existe && m.lector !== config.modeloIA
  ).length;
  res.json({
    carpeta: RAIZ,
    locales: listarLocales(RAIZ),
    nuevas: procesador.progreso.activo ? 0 : contarNuevas(RAIZ, almacen.movimientos),
    progreso: procesador.progreso,
    ia: await estadoIA(config.modeloIA),
    pendientesIA,
  });
});

app.post('/api/procesar', (req, res) => {
  procesador.procesarNuevas().catch((e) => console.error('Error procesando:', e));
  res.json(procesador.progreso);
});

app.post('/api/releer', (req, res) => {
  procesador.releerPendientes().catch((e) => console.error('Error releyendo:', e));
  res.json(procesador.progreso);
});

app.get('/api/movimientos', (req, res) => {
  const dups = duplicados(almacen.movimientos);
  res.json({ movimientos: ordenar(almacen.movimientos).map((m) => resumen(m, dups)) });
});

app.get('/api/movimientos/:id', (req, res) => {
  const mov = almacen.buscar(req.params.id);
  if (!mov) return res.status(404).json({ error: 'No existe' });
  res.json({ ...resumen(mov, duplicados(almacen.movimientos)), ocr: mov.ocr });
});

app.patch('/api/movimientos/:id', (req, res) => {
  const mov = almacen.buscar(req.params.id);
  if (!mov) return res.status(404).json({ error: 'No existe' });
  const cambios = req.body || {};
  const marcar = (campo) => {
    mov.confianza[campo] = 'manual';
    if (!mov.editados.includes(campo)) mov.editados.push(campo);
  };
  for (const campo of ['fecha', 'valor', 'referencia']) {
    if (!(campo in cambios)) continue;
    let valor = cambios[campo];
    if (campo === 'valor') valor = valor === '' || valor == null ? null : parseMonto(valor);
    else if (campo === 'fecha') valor = /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor : '';
    else valor = String(valor ?? '').trim();
    if (valor === mov[campo]) continue;
    mov[campo] = valor;
    marcar(campo);
  }
  if ('proveedorId' in cambios) {
    const id = cambios.proveedorId || null;
    if (id && !catalogo.buscar(id)) return res.status(400).json({ error: 'Proveedor desconocido' });
    if (id !== mov.proveedorId) {
      mov.proveedorId = id;
      marcar('proveedor');
    }
    // Aprende de esta asignación: la próxima vez lo reconoce solo.
    if (id) catalogo.aprender(id, { cuentaDestino: cuentaConfiable(mov), convenio: mov.convenio, nombreLeido: mov.nombreLeido });
  }
  if (cambios.estado === 'revisado' || cambios.estado === 'por_revisar') mov.estado = cambios.estado;
  mov.actualizado = new Date().toISOString();
  procesador.reidentificarProveedores();
  almacen.guardar();
  res.json(resumen(mov, duplicados(almacen.movimientos)));
});

// ---------- Proveedores ----------

app.get('/api/proveedores', (req, res) => res.json(listaProveedores()));

app.post(
  '/api/proveedores',
  intentar((req, res) => {
    const nuevo = catalogo.crear(req.body?.nombre);
    procesador.reidentificarProveedores();
    res.json(nuevo);
  })
);

app.patch(
  '/api/proveedores/:id',
  intentar((req, res) => {
    const p = catalogo.actualizar(req.params.id, req.body || {});
    procesador.reidentificarProveedores();
    res.json(p);
  })
);

app.post(
  '/api/proveedores/:id/unir',
  intentar((req, res) => {
    const destino = catalogo.unir(req.params.id, req.body?.destino);
    for (const m of almacen.movimientos) if (m.proveedorId === req.params.id) m.proveedorId = destino;
    procesador.reidentificarProveedores();
    res.json({ id: destino });
  })
);

app.delete(
  '/api/proveedores/:id',
  intentar((req, res) => {
    catalogo.eliminar(req.params.id);
    for (const m of almacen.movimientos) {
      if (m.proveedorId !== req.params.id) continue;
      m.proveedorId = null;
      m.editados = m.editados.filter((c) => c !== 'proveedor');
    }
    procesador.reidentificarProveedores();
    res.json({ ok: true });
  })
);

// ---------- Imagen, Excel, carpeta ----------

// Imagen original; las HEIC/TIFF se convierten a JPEG (con sips, de macOS) para que el navegador las muestre.
app.get('/api/imagen/:id', (req, res) => {
  const mov = almacen.buscar(req.params.id);
  if (!mov) return res.status(404).end();
  const ruta = rutaSegura(mov);
  if (!fs.existsSync(ruta)) return res.status(404).end();
  if (!/\.(heic|heif|tiff?)$/i.test(ruta)) return res.sendFile(ruta);
  const vista = path.join(DATOS, 'vistas', `${mov.hash.slice(0, 16)}.jpg`);
  if (fs.existsSync(vista)) return res.sendFile(vista);
  fs.mkdirSync(path.dirname(vista), { recursive: true });
  execFile('sips', ['-s', 'format', 'jpeg', ruta, '--out', vista], (error) =>
    error ? res.status(500).end() : res.sendFile(vista)
  );
});

app.post('/api/exportar', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const movimientos = ids
    .map((id) => almacen.buscar(id))
    .filter(Boolean)
    .map((m) => ({ ...m, proveedor: catalogo.nombreDe(m.proveedorId) }));
  const archivo = await crearExcel(movimientos);
  const hoy = new Date().toLocaleDateString('en-CA');
  res
    .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .set('Content-Disposition', `attachment; filename="Movimientos ${hoy}.xlsx"`)
    .send(Buffer.from(archivo));
});

app.post('/api/abrir-carpeta', (req, res) => {
  execFile('open', [RAIZ]);
  res.json({ ok: true });
});

const salir = () => {
  almacen.guardarYa();
  process.exit(0);
};
process.on('SIGINT', salir);
process.on('SIGTERM', salir);

app.listen(PUERTO, '127.0.0.1', () => {
  console.log(`\nApp de comprobantes lista en http://localhost:${PUERTO}`);
  console.log(`Carpeta de comprobantes: ${RAIZ}`);
  console.log(`IA local: ${config.modeloIA} (Ollama)`);
  console.log('Para cerrarla: Ctrl + C (o cierra esta ventana).\n');
});
