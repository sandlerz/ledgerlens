import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizar } from './extraer.js';

// Catálogo de proveedores. Cada proveedor se reconoce, en este orden, por:
// su cuenta o llave destino, su código de convenio, o su nombre (aunque venga
// cortado "DISTRIBUIDORA DEL N" o enmascarado "Dis*** Del*** Nor***").

export const soloDigitos = (texto) => String(texto ?? '').replace(/\D/g, '');
const sinCerosIzquierda = (d) => d.replace(/^0+/, '');

// Letras y números que el OCR confunde entre sí se tratan como iguales.
const CONFUSIONES = { 5: 's', 0: 'o', 1: 'l', i: 'l', 8: 'b', 2: 'z', 6: 'g' };
const clave = (texto) =>
  normalizar(String(texto ?? ''))
    .replace(/[^a-z0-9]/g, '')
    .replace(/[501i826]/g, (c) => CONFUSIONES[c]);
const palabras = (texto) =>
  normalizar(String(texto ?? ''))
    .replace(/[^a-z0-9* ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function distancia(a, b) {
  let previa = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const actual = [i];
    for (let j = 1; j <= b.length; j++)
      actual[j] = Math.min(previa[j] + 1, actual[j - 1] + 1, previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previa = actual;
  }
  return previa[b.length];
}

const mismaCuenta = (a, b) => a.length >= 6 && b.length >= 6 && sinCerosIzquierda(a) === sinCerosIzquierda(b);

// "Dis*** Del*** Nor***" contra "DISTRIBUIDORA DEL NORTE SAS": cada palabra enmascarada
// debe ser el comienzo de la palabra correspondiente del nombre conocido.
function coincideEnmascarado(leido, conocido) {
  const l = palabras(leido);
  if (!l.some((p) => p.includes('*'))) return false;
  const c = palabras(conocido);
  if (l.length > c.length) return false;
  return l.every((p, i) => {
    const prefijo = p.replace(/\*+/g, '');
    return prefijo.length > 0 && (p.includes('*') ? c[i].startsWith(prefijo) : c[i] === prefijo);
  });
}

// Cómo se parece un nombre leído a un nombre conocido: 'igual', 'cortado', 'enmascarado', 'parecido' o null.
function compararNombre(leido, conocido) {
  if (coincideEnmascarado(leido, conocido)) return 'enmascarado';
  const l = clave(leido);
  const k = clave(conocido);
  if (!l || !k) return null;
  if (l === k) return 'igual';
  if (k.startsWith(l) && l.length >= Math.max(8, k.length * 0.5)) return 'cortado';
  if (l.length >= 15 && k.length >= 15 && distancia(l, k) <= 2) return 'parecido';
  return null;
}

// Números largos que aparecen en el texto (sin espacios ni guiones): "123 - 456789 - 01" → 12345678901.
function numerosDelTexto(texto) {
  const numeros = new Set();
  for (const linea of String(texto ?? '').split('\n')) {
    for (const m of linea.replace(/(\d)[\s.-]+(?=\d)/g, '$1').matchAll(/\d{8,}/g)) numeros.add(m[0]);
  }
  return [...numeros];
}

function conveniosDelTexto(texto) {
  return [...normalizar(String(texto ?? '')).matchAll(/convenio\W{0,3}(\d{4,6})\b/g)].map((m) => m[1]);
}

// Devuelve { id, conf: 'seguro'|'dudoso'|'vacio', motivo }.
export function identificarProveedor({ cuentaDestino, convenio, nombreLeido, texto } = {}, proveedores) {
  const unico = (lista, conf, motivo) =>
    lista.length === 1 ? { id: lista[0].id, conf, motivo } : null;

  const cuenta = soloDigitos(cuentaDestino);
  if (cuenta.length >= 6) {
    const r = unico(proveedores.filter((p) => p.cuentas.some((c) => mismaCuenta(soloDigitos(c), cuenta))), 'seguro', `cuenta ${cuenta}`);
    if (r) return r;
  }
  const conv = soloDigitos(convenio);
  if (conv.length >= 4) {
    const r = unico(proveedores.filter((p) => p.convenios.includes(conv)), 'seguro', `convenio ${conv}`);
    if (r) return r;
  }

  // Red de seguridad: una cuenta o convenio conocido aparece en el texto del comprobante.
  const numeros = numerosDelTexto(texto);
  const porCuenta = proveedores.filter((p) => p.cuentas.some((c) => numeros.some((n) => mismaCuenta(soloDigitos(c), n))));
  const r1 = unico(porCuenta, 'seguro', 'cuenta en el texto');
  if (r1) return r1;
  const convenios = conveniosDelTexto(texto);
  const r2 = unico(proveedores.filter((p) => p.convenios.some((c) => convenios.includes(c))), 'seguro', 'convenio en el texto');
  if (r2) return r2;

  if (nombreLeido) {
    const parecidos = [];
    for (const p of proveedores) {
      const tipos = [p.nombre, ...p.alias].map((n) => compararNombre(nombreLeido, n)).filter(Boolean);
      if (tipos.length) parecidos.push({ p, fuerte: tipos.some((t) => t !== 'parecido') });
    }
    const fuertes = parecidos.filter((x) => x.fuerte);
    if (fuertes.length === 1) return { id: fuertes[0].p.id, conf: 'seguro', motivo: 'nombre' };
    if (!fuertes.length && parecidos.length === 1) return { id: parecidos[0].p.id, conf: 'dudoso', motivo: 'nombre parecido' };
  }

  // El nombre (o un alias) de un proveedor conocido aparece tal cual en el texto del comprobante.
  const textoClave = clave(texto);
  if (textoClave) {
    const enTexto = proveedores.filter((p) =>
      [p.nombre, ...p.alias].some((n) => clave(n).length >= 10 && textoClave.includes(clave(n)))
    );
    const r = unico(enTexto, 'seguro', 'nombre en el texto');
    if (r) return r;
  }

  // Cuenta enmascarada (****3552): si solo una cuenta conocida termina así, es una pista.
  if (cuenta.length >= 4 && cuenta.length < 6) {
    const r = unico(proveedores.filter((p) => p.cuentas.some((c) => soloDigitos(c).endsWith(cuenta))), 'dudoso', `cuenta terminada en ${cuenta}`);
    if (r) return r;
  }
  return { id: null, conf: 'vacio', motivo: '' };
}

export class Catalogo {
  constructor(archivo) {
    this.archivo = archivo;
    this.proveedores = fs.existsSync(archivo) ? JSON.parse(fs.readFileSync(archivo, 'utf8')).proveedores ?? [] : [];
  }

  buscar(id) {
    return this.proveedores.find((p) => p.id === id);
  }

  nombreDe(id) {
    return this.buscar(id)?.nombre ?? '';
  }

  guardar() {
    fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
    const temporal = `${this.archivo}.tmp`;
    const orden = [...this.proveedores].sort((a, b) => a.nombre.localeCompare(b.nombre));
    fs.writeFileSync(temporal, JSON.stringify({ version: 1, proveedores: orden }, null, 2));
    fs.renameSync(temporal, this.archivo);
  }

  crear(nombre) {
    const limpio = String(nombre ?? '').trim();
    if (!limpio) throw new Error('El proveedor necesita un nombre');
    const existente = this.proveedores.find((p) => clave(p.nombre) === clave(limpio));
    if (existente) return existente;
    const nuevo = { id: crypto.randomBytes(5).toString('hex'), nombre: limpio, cuentas: [], convenios: [], alias: [] };
    this.proveedores.push(nuevo);
    this.guardar();
    return nuevo;
  }

  actualizar(id, cambios) {
    const p = this.buscar(id);
    if (!p) throw new Error('No existe el proveedor');
    if (typeof cambios.nombre === 'string' && cambios.nombre.trim()) p.nombre = cambios.nombre.trim();
    for (const lista of ['cuentas', 'convenios', 'alias']) {
      if (Array.isArray(cambios[lista])) p[lista] = [...new Set(cambios[lista].map((x) => String(x).trim()).filter(Boolean))];
    }
    this.guardar();
    return p;
  }

  // Fusiona dos fichas del mismo proveedor; devuelve el id que se conserva.
  unir(origenId, destinoId) {
    const origen = this.buscar(origenId);
    const destino = this.buscar(destinoId);
    if (!origen || !destino || origen === destino) throw new Error('Proveedores inválidos');
    for (const lista of ['cuentas', 'convenios', 'alias'])
      destino[lista] = [...new Set([...destino[lista], ...origen[lista]])];
    if (clave(origen.nombre) !== clave(destino.nombre) && !destino.alias.includes(origen.nombre)) destino.alias.push(origen.nombre);
    this.proveedores = this.proveedores.filter((p) => p !== origen);
    this.guardar();
    return destino.id;
  }

  eliminar(id) {
    this.proveedores = this.proveedores.filter((p) => p.id !== id);
    this.guardar();
  }

  // Cuando asignas un proveedor a mano, guarda la cuenta, el convenio y el nombre de ese comprobante.
  aprender(id, { cuentaDestino, convenio, nombreLeido } = {}) {
    const p = this.buscar(id);
    if (!p) return;
    const otros = this.proveedores.filter((x) => x !== p);
    const cuenta = soloDigitos(cuentaDestino);
    if (cuenta.length >= 6 && !otros.some((o) => o.cuentas.some((c) => mismaCuenta(soloDigitos(c), cuenta))) && !p.cuentas.some((c) => mismaCuenta(soloDigitos(c), cuenta)))
      p.cuentas.push(cuenta);
    const conv = soloDigitos(convenio);
    if (conv.length >= 4 && !otros.some((o) => o.convenios.includes(conv)) && !p.convenios.includes(conv)) p.convenios.push(conv);
    const nombre = String(nombreLeido ?? '').trim();
    if (nombre && clave(nombre).length >= 3 && ![p.nombre, ...p.alias].some((n) => clave(n) === clave(nombre))) p.alias.push(nombre);
    this.guardar();
  }

  identificar(datos) {
    return identificarProveedor(datos, this.proveedores);
  }
}
