import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXTENSIONES = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.tif', '.tiff', '.bmp', '.gif']);
export const SIN_LOCAL = '(sin local)';

// Todas las imágenes dentro de la carpeta raíz. El local es la primera subcarpeta.
export function listarImagenes(raiz) {
  const imagenes = [];
  const recorrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entrada.name.startsWith('.')) continue;
      const ruta = path.join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(ruta);
      else if (entrada.isFile() && EXTENSIONES.has(path.extname(entrada.name).toLowerCase())) {
        const archivo = path.relative(raiz, ruta).split(path.sep).join('/');
        const partes = archivo.split('/');
        const info = fs.statSync(ruta);
        imagenes.push({
          archivo,
          ruta,
          local: partes.length > 1 ? partes[0] : SIN_LOCAL,
          tam: info.size,
          mtime: Math.round(info.mtimeMs),
        });
      }
    }
  };
  if (fs.existsSync(raiz)) recorrer(raiz);
  return imagenes.sort((a, b) => a.archivo.localeCompare(b.archivo));
}

export function listarLocales(raiz) {
  if (!fs.existsSync(raiz)) return [];
  return fs
    .readdirSync(raiz, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

const hashDe = (ruta) => crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');

// Archivos que no se han leído todavía (o que cambiaron), sin calcular hashes: es rápido.
export function contarNuevas(raiz, movimientos) {
  const porArchivo = new Map(movimientos.map((m) => [m.archivo, m]));
  return listarImagenes(raiz).filter((a) => {
    const mov = porArchivo.get(a.archivo);
    return !mov || !mov.procesado || mov.tam !== a.tam || mov.mtime !== a.mtime;
  }).length;
}

function nuevoMovimiento(imagen, hash) {
  const ahora = new Date().toISOString();
  return {
    id: crypto.randomBytes(6).toString('hex'),
    local: imagen.local,
    archivo: imagen.archivo,
    tam: imagen.tam,
    mtime: imagen.mtime,
    hash,
    existe: true,
    procesado: false,
    error: '',
    giro: 0,
    ocr: null,
    leido: null,
    banco: '',
    fecha: '',
    valor: null,
    referencia: '',
    proveedor: '',
    confianza: {},
    editados: [],
    estado: 'por_revisar',
    creado: ahora,
    actualizado: ahora,
  };
}

// Compara las carpetas con lo guardado y devuelve los movimientos que necesitan OCR.
// - Archivo ya leído y sin cambios: se deja igual (tus correcciones nunca se pierden).
// - Archivo movido a otra carpeta: se actualiza su local.
// - Copia exacta de una imagen ya leída: se crea el movimiento copiando lo leído.
// - Archivo borrado: el movimiento se conserva marcado como "archivo no encontrado".
export function sincronizar(raiz, almacen) {
  const imagenes = listarImagenes(raiz);
  const enDisco = new Set(imagenes.map((a) => a.archivo));
  const porArchivo = new Map(almacen.movimientos.map((m) => [m.archivo, m]));
  const pendientes = [];

  for (const imagen of imagenes) {
    const mov = porArchivo.get(imagen.archivo);
    if (mov && mov.tam === imagen.tam && mov.mtime === imagen.mtime) {
      mov.existe = true;
      mov.local = imagen.local;
      if (!mov.procesado) pendientes.push(mov);
      continue;
    }

    const hash = hashDe(imagen.ruta);
    if (mov) {
      Object.assign(mov, { existe: true, local: imagen.local, tam: imagen.tam, mtime: imagen.mtime });
      if (mov.hash !== hash) {
        // Reemplazaron la imagen por otra: se lee de nuevo desde cero.
        Object.assign(mov, { hash, procesado: false, editados: [], estado: 'por_revisar' });
      }
      if (!mov.procesado) pendientes.push(mov);
      continue;
    }

    const mismaImagen = almacen.movimientos.filter((m) => m.hash === hash);
    const movida = mismaImagen.find((m) => !enDisco.has(m.archivo));
    if (movida) {
      porArchivo.delete(movida.archivo);
      Object.assign(movida, { archivo: imagen.archivo, local: imagen.local, tam: imagen.tam, mtime: imagen.mtime, existe: true });
      porArchivo.set(movida.archivo, movida);
      if (!movida.procesado) pendientes.push(movida);
      continue;
    }

    const nuevo = nuevoMovimiento(imagen, hash);
    const original = mismaImagen.find((m) => m.procesado);
    if (original) {
      for (const campo of ['ocr', 'leido', 'giro', 'banco', 'fecha', 'valor', 'referencia', 'proveedor', 'confianza', 'versionReglas'])
        nuevo[campo] = structuredClone(original[campo]);
      nuevo.procesado = true;
    } else {
      pendientes.push(nuevo);
    }
    almacen.movimientos.push(nuevo);
    porArchivo.set(nuevo.archivo, nuevo);
  }

  for (const mov of almacen.movimientos) if (!enDisco.has(mov.archivo)) mov.existe = false;
  return pendientes;
}
