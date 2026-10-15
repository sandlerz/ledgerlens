// Mide qué tan bien se leen los comprobantes del set de verificación (test/verificacion/esperados.json):
// las reglas solas contra cada modelo de IA local. Uso:
//   npm run comparar                         → reglas + modelo por defecto
//   npm run comparar -- qwen3-vl:8b-instruct minicpm-v4.5

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalogo } from '../lib/catalogo.js';
import { MODELO_POR_DEFECTO } from '../lib/ia.js';
import { leerComprobante } from '../lib/lectura.js';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(AQUI, '..');
const RAIZ = path.join(APP, '..', 'Comprobantes');
// El set real tiene datos de tus comprobantes y no se sube al repositorio (ver .gitignore).
const ARCHIVO_ESPERADOS = path.join(APP, 'test/verificacion/esperados.json');
if (!fs.existsSync(ARCHIVO_ESPERADOS)) {
  console.error(
    'Falta test/verificacion/esperados.json.\n' +
      'Cópialo desde esperados.ejemplo.json y anota los valores correctos de algunos de tus comprobantes.'
  );
  process.exit(1);
}
const { comprobantes } = JSON.parse(fs.readFileSync(ARCHIVO_ESPERADOS, 'utf8'));
const guardados = fs.existsSync(path.join(APP, 'data/movimientos.json'))
  ? JSON.parse(fs.readFileSync(path.join(APP, 'data/movimientos.json'), 'utf8')).movimientos
  : [];
const catalogo = new Catalogo(path.join(APP, 'data/proveedores.json'));
const modelos = process.argv.slice(2).length ? process.argv.slice(2) : [MODELO_POR_DEFECTO];

// OCR de cada imagen: se reutiliza el ya guardado por la app o se hace ahora.
function ocrDe(archivo) {
  const mov = guardados.find((m) => m.archivo === archivo && m.ocr);
  if (mov) return { ocr: mov.ocr, giro: mov.giro || 0 };
  const r = JSON.parse(execFileSync(path.join(APP, 'ocr/ocr'), [path.join(RAIZ, archivo)]));
  return { ocr: r.pasadas, giro: r.giro };
}

const compacto = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CAMPOS = ['fecha', 'valor', 'referencia', 'proveedor'];
function acierta(campo, esperado, leido) {
  if (campo === 'valor') return leido.valor != null && Math.abs(leido.valor - esperado.valor) < 0.5;
  if (campo === 'proveedor') return catalogo.nombreDe(leido.proveedorId) === esperado.proveedor;
  return compacto(leido[campo]) === compacto(esperado[campo]);
}

const metodos = [{ nombre: 'reglas', modelo: null }, ...modelos.map((m) => ({ nombre: m, modelo: m }))];
const resumen = [];

for (const metodo of metodos) {
  if (metodo.modelo) {
    process.stdout.write(`\nCalentando ${metodo.modelo}… `);
    const { ocr, giro } = ocrDe(comprobantes[0].archivo);
    await leerComprobante({ ruta: path.join(RAIZ, comprobantes[0].archivo), ocr, giro }, { modelo: metodo.modelo, catalogo });
    console.log('listo');
  }
  const cuenta = Object.fromEntries(CAMPOS.map((c) => [c, { bien: 0, total: 0, malSeguro: 0, marcados: 0 }]));
  const errores = [];
  let segundos = 0;
  for (const esperado of comprobantes) {
    const { ocr, giro } = ocrDe(esperado.archivo);
    const inicio = Date.now();
    const leido = await leerComprobante({ ruta: path.join(RAIZ, esperado.archivo), ocr, giro }, { modelo: metodo.modelo, catalogo });
    segundos += (Date.now() - inicio) / 1000;
    if (leido.errorIA) errores.push(`  ⚠ ${esperado.archivo}: IA falló (${leido.errorIA})`);
    for (const campo of CAMPOS) {
      if (esperado[campo] === null) continue;
      const c = cuenta[campo];
      const bien = acierta(campo, esperado, leido);
      const conf = leido.confianza[campo];
      c.total++;
      if (bien) c.bien++;
      if (conf !== 'seguro') c.marcados++;
      if (!bien && conf === 'seguro') c.malSeguro++;
      if (!bien) {
        const valorLeido = campo === 'proveedor' ? catalogo.nombreDe(leido.proveedorId) || `(sin asignar: "${leido.nombreLeido}")` : leido[campo];
        errores.push(`  ${conf === 'seguro' ? '✗' : '~'} ${esperado.archivo.replace('TEST/WhatsApp Image ', '')} [${esperado.formato}] ${campo}: esperado ${JSON.stringify(esperado[campo])}, leído ${JSON.stringify(valorLeido)} (${conf})`);
      }
    }
  }
  resumen.push({ metodo: metodo.nombre, cuenta, segundos: segundos / comprobantes.length });
  console.log(`\n=== ${metodo.nombre} ===  (✗ = error marcado como seguro, ~ = error pero marcado para revisar)`);
  console.log(errores.join('\n') || '  sin errores');
}

console.log('\n\nRESUMEN (% de acierto · errores que pasarían como "seguros")');
console.log(['Método'.padEnd(24), ...CAMPOS.map((c) => c.padEnd(18)), 'seg/imagen'].join(''));
for (const r of resumen) {
  const celdas = CAMPOS.map((c) => {
    const x = r.cuenta[c];
    return `${Math.round((100 * x.bien) / x.total)}% · ${x.malSeguro} sin aviso`.padEnd(18);
  });
  console.log([r.metodo.padEnd(24), ...celdas, r.segundos.toFixed(1)].join(''));
}
