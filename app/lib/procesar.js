import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { soloDigitos } from './catalogo.js';
import { VERSION_REGLAS, normalizar } from './extraer.js';
import { sincronizar } from './escanear.js';
import { estadoIA, textoDeLineas } from './ia.js';
import { leerComprobante } from './lectura.js';

const CARPETA_OCR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ocr');
const FUENTE_OCR = path.join(CARPETA_OCR, 'ocr.swift');
const RUTA_OCR = path.join(CARPETA_OCR, 'ocr');
const OCR_EN_PARALELO = 4;
const CAMPOS_LEIDOS = ['fecha', 'valor', 'referencia'];

// Compila el lector OCR (Swift + Apple Vision) si no existe o si su código cambió.
export function prepararOcr() {
  const desactualizado =
    !fs.existsSync(RUTA_OCR) || fs.statSync(RUTA_OCR).mtimeMs < fs.statSync(FUENTE_OCR).mtimeMs;
  if (!desactualizado) return;
  console.log('Preparando el lector de imágenes (solo la primera vez, tarda ~1 minuto)...');
  try {
    execFileSync('swiftc', ['-O', FUENTE_OCR, '-o', RUTA_OCR], { stdio: 'inherit' });
  } catch {
    throw new Error(
      'No se pudo preparar el lector de imágenes. Instala las herramientas de Apple con: xcode-select --install'
    );
  }
}

function leerImagen(ruta) {
  return new Promise((resolver, rechazar) => {
    execFile(RUTA_OCR, [ruta], { maxBuffer: 50 * 1024 * 1024, timeout: 120_000 }, (error, salida, errores) => {
      if (error) rechazar(new Error((errores || error.message).trim()));
      else resolver(JSON.parse(salida));
    });
  });
}

export const textoDe = (mov) => (mov.ocr || []).map(textoDeLineas).join('\n');

// Solo se aprende una cuenta si en el comprobante aparece junto a algo que no sea
// C. Único, TER, RRN, recibo, NIT… (esos números no identifican al proveedor).
export function cuentaConfiable(mov) {
  const cuenta = soloDigitos(mov.cuentaDestino);
  if (cuenta.length < 6 || mov.convenio) return '';
  const linea = textoDe(mov)
    .split('\n')
    .find((l) => soloDigitos(l).includes(cuenta));
  if (!linea || /(c\.? ?unico|\bter\b|rrn|recibo|apro|\bnit\b|identificacion|telefono|celular|atencion|origen|desde)/.test(normalizar(linea)))
    return '';
  return cuenta;
}

export class Procesador {
  constructor(raiz, almacen, catalogo, obtenerModelo) {
    this.raiz = raiz;
    this.almacen = almacen;
    this.catalogo = catalogo;
    this.obtenerModelo = obtenerModelo;
    this.progreso = { activo: false, fase: '', total: 0, hechos: 0, errores: 0, segundosIA: 0, leidosIA: 0 };
  }

  // Pone en el movimiento lo leído, sin tocar los campos que ya corregiste.
  aplicarLectura(mov, lectura) {
    mov.leido = lectura;
    mov.lector = lectura.lector;
    mov.versionReglas = VERSION_REGLAS;
    for (const campo of ['banco', 'tipo', 'cuentaDestino', 'convenio', 'nombreLeido']) mov[campo] = lectura[campo] || '';
    for (const campo of CAMPOS_LEIDOS) {
      if (mov.editados.includes(campo)) continue;
      mov[campo] = lectura[campo];
      mov.confianza[campo] = lectura.confianza[campo];
    }
    if (!mov.editados.includes('proveedor')) {
      mov.proveedorId = lectura.proveedorId;
      mov.confianza.proveedor = lectura.confianza.proveedor;
    }
    mov.actualizado = new Date().toISOString();
  }

  // Tras cambiar el catálogo, vuelve a reconocer el proveedor de los pendientes.
  reidentificarProveedores() {
    for (const mov of this.almacen.movimientos) {
      if (mov.estado !== 'por_revisar' || mov.editados.includes('proveedor') || !mov.ocr) continue;
      const r = this.catalogo.identificar({
        cuentaDestino: mov.cuentaDestino,
        convenio: mov.convenio,
        nombreLeido: mov.nombreLeido,
        texto: textoDe(mov),
      });
      mov.proveedorId = r.id;
      mov.confianza.proveedor = r.conf;
    }
    this.almacen.guardar();
  }

  // Si mejoraron las reglas, vuelve a sacar los campos de los pendientes leídos solo con reglas.
  async actualizarReglas() {
    let cambiados = 0;
    for (const mov of this.almacen.movimientos) {
      if (!mov.procesado || !mov.ocr || mov.estado !== 'por_revisar' || mov.versionReglas === VERSION_REGLAS) continue;
      if (mov.lector && mov.lector !== 'reglas') continue;
      const lectura = await leerComprobante({ ocr: mov.ocr, giro: mov.giro }, { modelo: null, catalogo: this.catalogo });
      this.aplicarLectura(mov, lectura);
      cambiados++;
    }
    if (cambiados) this.almacen.guardarYa();
    return cambiados;
  }

  async procesarNuevas() {
    if (this.progreso.activo) return;
    this.progreso = { activo: true, fase: 'ocr', total: 0, hechos: 0, errores: 0, segundosIA: 0, leidosIA: 0 };
    try {
      const pendientes = sincronizar(this.raiz, this.almacen);
      this.progreso.total = pendientes.length;
      this.almacen.guardar();

      // 1) OCR de Apple, 4 a la vez (rápido). Las filas aparecen ya con la lectura por reglas.
      let siguiente = 0;
      const listos = [];
      const trabajador = async () => {
        while (siguiente < pendientes.length) {
          const mov = pendientes[siguiente++];
          try {
            const lectura = await leerImagen(path.join(this.raiz, mov.archivo));
            Object.assign(mov, { ocr: lectura.pasadas, giro: lectura.giro, procesado: true, error: '' });
            this.aplicarLectura(mov, await leerComprobante({ ocr: mov.ocr, giro: mov.giro }, { modelo: null, catalogo: this.catalogo }));
            listos.push(mov);
          } catch (error) {
            mov.error = error.message || 'No se pudo leer la imagen';
            this.progreso.errores++;
          }
          this.progreso.hechos++;
          this.almacen.guardar();
        }
      };
      await Promise.all(Array.from({ length: OCR_EN_PARALELO }, trabajador));

      // 2) IA local, una imagen a la vez.
      await this.leerConIA(listos);
    } finally {
      this.progreso.activo = false;
      this.almacen.guardarYa();
    }
  }

  // Vuelve a leer con la IA los comprobantes pendientes (sin tocar lo que corregiste).
  async releerPendientes() {
    if (this.progreso.activo) return;
    const modelo = this.obtenerModelo();
    const pendientes = this.almacen.movimientos.filter(
      (m) => m.estado === 'por_revisar' && m.ocr && m.existe && m.lector !== modelo
    );
    this.progreso = { activo: true, fase: 'ia', total: 0, hechos: 0, errores: 0, segundosIA: 0, leidosIA: 0 };
    try {
      await this.leerConIA(pendientes);
    } finally {
      this.progreso.activo = false;
      this.almacen.guardarYa();
    }
  }

  async leerConIA(movimientos) {
    const modelo = this.obtenerModelo();
    const ia = await estadoIA(modelo);
    if (!ia.activa || !ia.instalado || !movimientos.length) return;
    Object.assign(this.progreso, { fase: 'ia', total: movimientos.length, hechos: 0 });
    for (const mov of movimientos) {
      const inicio = Date.now();
      const lectura = await leerComprobante(
        { ruta: path.join(this.raiz, mov.archivo), ocr: mov.ocr, giro: mov.giro },
        { modelo, catalogo: this.catalogo }
      );
      if (lectura.errorIA) this.progreso.errores++;
      else this.aplicarLectura(mov, lectura);
      this.progreso.hechos++;
      this.progreso.leidosIA++;
      this.progreso.segundosIA += (Date.now() - inicio) / 1000;
      this.almacen.guardar();
    }
  }
}
