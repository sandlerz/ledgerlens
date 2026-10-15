// Contrasta lo que leyó la IA con el texto del OCR y con las reglas.
// Un dato es "seguro" solo si sus números aparecen tal cual en el texto del comprobante;
// así, si la IA se inventa un dígito, el campo queda marcado para revisar.

import { fechasEn, normalizar, parseMonto } from './extraer.js';

// Montos que aparecen en el texto ("$ 1.460.000,00" → 1460000). "claros" son los que
// llevan "$" o separadores de miles: así un RRN o una cédula no cuentan como monto.
function montosDelTexto(texto) {
  const todos = new Set();
  const claros = new Set();
  for (const m of texto.matchAll(/\d[\d.,]*\d|\d/g)) {
    const valor = parseMonto(m[0]);
    if (!valor) continue;
    todos.add(valor);
    if (/\$\s*$/.test(texto.slice(0, m.index)) || /^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(m[0])) claros.add(valor);
  }
  return { todos, claros };
}

const compacto = (t) => normalizar(String(t ?? '')).replace(/[^a-z0-9]/g, '');

export function crearVerificador(texto) {
  const montos = montosDelTexto(texto);
  const textoCompacto = compacto(texto);
  const fechas = new Set(fechasEn(normalizar(texto)).map((f) => f.iso));
  // Pedazos alfanuméricos de cada renglón: un número largo puede venir partido en dos.
  const pedazos = new Set(normalizar(texto).match(/[a-z0-9]+/g) || []);
  const enPedazos = (r) =>
    pedazos.has(r) || [...Array(r.length - 1).keys()].some((i) => pedazos.has(r.slice(0, i + 1)) && pedazos.has(r.slice(i + 1)));
  return {
    valor: (v) => v != null && montos.todos.has(v),
    montoClaro: (v) => v != null && montos.claros.has(v),
    referencia: (r) => compacto(r).length >= 4 && (textoCompacto.includes(compacto(r)) || enPedazos(compacto(r))),
    fecha: (f) => Boolean(f) && fechas.has(f),
  };
}

const iguales = (campo, a, b) => (campo === 'valor' ? a === b : compacto(a) === compacto(b));
const vacio = (v) => v == null || v === '';

// ia: { fecha, valor, referencia } · reglas: resultado de extraerVarias (con .confianza).
// Devuelve { fecha, valor, referencia, confianza } con el valor elegido para cada campo.
// Para la referencia mandan las reglas (buscan la etiqueta exacta de cada formato: Aprob,
// Comprobante No., Registro de Operación…); la IA la completa cuando las reglas no la hallan.
// Para fecha y valor manda la IA, que entiende mejor el formato.
export function combinarLecturas(ia, reglas, texto) {
  const enTexto = crearVerificador(texto);
  const final = { confianza: {} };
  for (const campo of ['fecha', 'valor', 'referencia']) {
    const a = ia?.[campo];
    const b = reglas?.[campo];
    const confReglas = reglas?.confianza?.[campo] ?? 'vacio';
    let valor;
    let conf;
    if (vacio(a) && vacio(b)) [valor, conf] = [campo === 'valor' ? null : '', 'vacio'];
    else if (!vacio(a) && !vacio(b) && iguales(campo, a, b)) [valor, conf] = [a, enTexto[campo](a) ? 'seguro' : 'dudoso'];
    else if (campo === 'referencia' && !vacio(b) && enTexto.referencia(b))
      // Las reglas hallaron la etiqueta exacta del formato; su confianza manda
      // (la IA suele tomar otro número del ticket, como el REF o el Recibo).
      [valor, conf] = [b, confReglas];
    else if (!vacio(a) && enTexto[campo](a))
      // La IA lo vio y está en el texto. Si las reglas leyeron otra cosa que también está
      // en el texto (o estaban seguras de ella), hay dos candidatos: revisar.
      [valor, conf] = [a, !vacio(b) && (confReglas === 'seguro' || (campo === 'valor' ? enTexto.montoClaro(b) : enTexto[campo](b))) ? 'dudoso' : 'seguro'];
    else if (!vacio(b) && enTexto[campo](b)) [valor, conf] = [b, 'dudoso'];
    else [valor, conf] = [vacio(a) ? b : a, 'dudoso'];
    final[campo] = valor;
    final.confianza[campo] = conf;
  }
  return final;
}
