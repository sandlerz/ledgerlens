// Convierte el texto leído por el OCR en los campos del movimiento:
// fecha, valor, referencia, proveedor/destinatario (y el banco, como dato de apoyo).
// Cada campo trae un nivel de confianza: "seguro" (se encontró junto a su etiqueta),
// "dudoso" (se adivinó, o las dos lecturas del OCR no coinciden) o "vacio" (no se encontró).

// Súbelo cuando cambien las reglas: los comprobantes aún "por revisar" se vuelven a leer con las reglas nuevas.
export const VERSION_REGLAS = 4;

export const CAMPOS = ['fecha', 'valor', 'referencia', 'proveedor'];

// Letras cirílicas que el OCR a veces devuelve en lugar de las latinas que se ven iguales.
const PARECIDAS = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x' };

// Minúsculas y sin tildes, conservando la misma longitud que el texto original
// (así podemos recortar el original usando las posiciones del texto normalizado).
export function normalizar(texto) {
  return texto
    .split('')
    .map((c) => {
      const l = c.normalize('NFD')[0].toLowerCase();
      return PARECIDAS[l] ?? l;
    })
    .join('');
}

// "$ 1.250.000,00" → 1250000 · "1,250,000.50" → 1250000.5 · "12,50" → 12.5 · "2.350" → 2350
export function parseMonto(texto) {
  const m = String(texto ?? '').match(/-?\d[\d.,]*/);
  if (!m) return null;
  const t = m[0].replace(/[.,]+$/, '');
  const punto = t.lastIndexOf('.');
  const coma = t.lastIndexOf(',');
  const sep = Math.max(punto, coma);
  let entero = t;
  let decimales = '';
  if (sep >= 0) {
    const cola = t.slice(sep + 1);
    const ambos = punto >= 0 && coma >= 0;
    // Un solo tipo de separador seguido de 3 dígitos = miles (formato colombiano).
    if (ambos || cola.length < 3) {
      entero = t.slice(0, sep);
      decimales = cola;
    }
  }
  const numero = Number(`${entero.replace(/[.,]/g, '')}.${decimales || '0'}`);
  return Number.isFinite(numero) ? numero : null;
}

// Números de un texto que pueden ser montos (descarta horas, fechas, cuentas *1234, códigos M123…).
// Primero los que llevan "$" y, entre iguales, el más grande.
function numerosEn(texto) {
  const res = [];
  for (const m of texto.matchAll(/\d[\d.,]*\d|\d/g)) {
    const antes = texto.slice(0, m.index);
    const despues = texto.slice(m.index + m[0].length);
    if (/[/:]\s*$/.test(antes) || /^\s*[/:]/.test(despues)) continue;
    if (/[*#]\s*$/.test(antes) || /^\s*%/.test(despues)) continue;
    if (/[a-z]$/i.test(antes) && !/cop$/i.test(antes)) continue;
    const valor = parseMonto(m[0]);
    if (valor == null || valor <= 0) continue;
    res.push({ valor, conSigno: /(\$|cop)\s*-?\s*$/i.test(antes) });
  }
  return res.sort((a, b) => b.conSigno - a.conSigno || b.valor - a.valor);
}

// ---------- Geometría: qué texto está a la derecha o debajo de una etiqueta ----------

function prepararLineas(lineas) {
  return lineas
    .filter((l) => l.texto && l.texto.trim())
    .map((l) => ({ ...l, n: normalizar(l.texto) }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function mismaFila(a, b) {
  const solape = Math.min(a.y + a.alto, b.y + b.alto) - Math.max(a.y, b.y);
  return solape > 0.5 * Math.min(a.alto, b.alto);
}

function aLaDerecha(lineas, etiqueta) {
  return lineas
    .filter((l) => l !== etiqueta && mismaFila(l, etiqueta) && l.x > etiqueta.x + etiqueta.ancho * 0.5)
    .sort((a, b) => a.x - b.x);
}

function debajo(lineas, etiqueta, distancia = 2.5) {
  const fin = etiqueta.y + etiqueta.alto;
  return lineas
    .filter(
      (l) =>
        l !== etiqueta &&
        l.y > etiqueta.y + etiqueta.alto * 0.5 &&
        !mismaFila(l, etiqueta) &&
        l.y - fin < Math.max(etiqueta.alto, l.alto) * distancia &&
        Math.abs(l.x - etiqueta.x) < 0.15
    )
    .sort((a, b) => a.y - b.y)
    .slice(0, 1);
}

// Textos candidatos para el valor de una etiqueta: resto de la misma línea,
// lo que está a la derecha en la misma fila y la línea justo debajo.
function textosTrasEtiqueta(lineas, linea, finEtiqueta) {
  const resto = linea.texto.slice(finEtiqueta).replace(/^[\s:.\-#=]+/, '').trim();
  return [
    ...(resto ? [{ texto: resto, linea }] : []),
    ...aLaDerecha(lineas, linea).map((l) => ({ texto: l.texto, linea: l })),
    ...debajo(lineas, linea).map((l) => ({ texto: l.texto, linea: l })),
  ];
}

// Busca etiquetas y devuelve los valores encontrados junto a ellas, de mayor a menor puntaje.
// `leer` devuelve el valor, o { valor, dudoso: true } si lo encontró pero no se ve limpio.
function buscarPorEtiqueta(lineas, etiquetas, { excluir, leer, alInicio = false }) {
  const hallazgos = [];
  for (const linea of lineas) {
    if (excluir && excluir.test(linea.n)) continue;
    for (const [regex, puntaje] of etiquetas) {
      const m = linea.n.match(regex);
      if (!m || (alInicio && m.index !== 0)) continue;
      hallazgos.push({ linea, fin: m.index + m[0].length, puntaje });
      break;
    }
  }
  hallazgos.sort((a, b) => b.puntaje - a.puntaje || a.linea.y - b.linea.y);
  const valores = [];
  for (const h of hallazgos) {
    for (const cand of textosTrasEtiqueta(lineas, h.linea, h.fin)) {
      const leido = leer(cand.texto, h, cand);
      const valor = leido && typeof leido === 'object' ? leido.valor : leido;
      if (valor == null || valor === '') continue;
      valores.push({ valor, linea: cand.linea, puntaje: h.puntaje, dudoso: Boolean(leido?.dudoso) });
      break;
    }
  }
  return valores;
}

function resultado(hallazgo, conf = 'seguro') {
  if (!hallazgo) return { valor: null, conf: 'vacio', puntaje: 0 };
  // Si el OCR mismo dudó de la línea, o el valor no se ve limpio, que se revise.
  const nivel = hallazgo.dudoso || (hallazgo.linea && hallazgo.linea.confianza <= 0.3) ? 'dudoso' : conf;
  return { valor: hallazgo.valor, conf: nivel, puntaje: hallazgo.puntaje ?? 0 };
}

// ---------- Banco ----------

const BANCOS = [
  [/\bnequi\b/, 'Nequi'],
  [/\bdaviplata\b/, 'Daviplata'],
  [/\bdavivienda\b/, 'Davivienda'],
  [/\bbancolombia\b/, 'Bancolombia'],
  [/\bbbva\b/, 'BBVA'],
  [/\bbanco de bogota\b/, 'Banco de Bogotá'],
  [/\bbanco de occidente\b/, 'Banco de Occidente'],
  [/\bbanco popular\b/, 'Banco Popular'],
  [/\bav ?villas\b/, 'AV Villas'],
  [/\bcaja social\b/, 'Banco Caja Social'],
  [/\b(scotiabank|colpatria)\b/, 'Scotiabank Colpatria'],
  [/\bitau\b/, 'Itaú'],
  [/\b(nubank|nu colombia)\b/, 'Nu'],
  [/\blulo\b/, 'Lulo Bank'],
  [/\bmovii\b/, 'MOVii'],
  [/\bbanco agrario\b/, 'Banco Agrario'],
  [/\bfalabella\b/, 'Banco Falabella'],
  [/\bpse\b/, 'PSE'],
];

function detectarBanco(lineas) {
  for (const linea of lineas) {
    for (const [regex, nombre] of BANCOS) if (regex.test(linea.n)) return nombre;
  }
  // Recaudos impresos de Bancolombia: el logo no siempre se lee, pero el formato es inconfundible.
  if (lineas.some((l) => /registro de operacion/.test(l.n))) return 'Bancolombia';
  return '';
}

// ---------- Valor ----------

// "vr" = abreviatura de valor en recibos (Vr. Total); "alor"/"yalor" = la V que el OCR a veces pierde.
const VALOR = '(?:[vy]?alor|vr\\.?)';
const ETIQUETAS_VALOR = [
  [new RegExp(`\\b${VALOR} total\\b|\\btotal pagado\\b`), 5],
  [new RegExp(`\\b(${VALOR}|monto|total)( total)? (enviado|transferido|pagado|recibido|consignado|depositado|de la transferencia|del envio|de la transaccion|del pago|de la compra|del deposito|a pagar)\\b`), 4],
  [/\bcuanto\b/, 4],
  [/\btotal( a pagar| compra)?\b/, 3],
  [new RegExp(`\\b${VALOR}( efectivo)?\\b`), 3],
  [/\b(monto|importe)\b/, 2],
];
const EXCLUIR_VALOR =
  /(costo|comision|saldo|cuota|\biva\b|\bgmf\b|4 ?x ?1000|disponible|subtotal|descuento|propina|cambio|base gravable|efectivo recibido|retencion|intereses|cheque)/;

function extraerValor(lineas) {
  const porEtiqueta = buscarPorEtiqueta(lineas, ETIQUETAS_VALOR, {
    excluir: EXCLUIR_VALOR,
    leer: (texto) => numerosEn(texto)[0]?.valor ?? null,
  });
  if (porEtiqueta.length) {
    // Si dos etiquetas de valor (p. ej. "Valor total" y "Valor efectivo") no cuadran, revisar.
    const distintos = new Set(porEtiqueta.filter((v) => v.puntaje >= 3).map((v) => v.valor));
    return resultado(porEtiqueta[0], distintos.size > 1 ? 'dudoso' : 'seguro');
  }

  // Sin etiqueta: el monto con "$" más destacado (letra más grande), ignorando costos y saldos.
  const excluida = (l) =>
    EXCLUIR_VALOR.test(l.n) ||
    lineas.some((o) => o !== l && EXCLUIR_VALOR.test(o.n) && (mismaFila(o, l) || debajo(lineas, o).includes(l)));
  const candidatos = [];
  for (const linea of lineas) {
    if (excluida(linea)) continue;
    for (const num of numerosEn(linea.texto)) if (num.conSigno) candidatos.push({ valor: num.valor, linea });
  }
  candidatos.sort((a, b) => b.linea.alto - a.linea.alto || b.valor - a.valor);
  return candidatos.length ? resultado(candidatos[0], 'dudoso') : resultado(null);
}

// ---------- Fecha ----------

const MESES = {
  ene: 1, enero: 1, jan: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  abr: 4, abril: 4, apr: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  ago: 8, agosto: 8, aug: 8, august: 8,
  sep: 9, sept: 9, set: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dic: 12, diciembre: 12, dec: 12, december: 12,
};

function armarFecha(d, m, y) {
  d = Number(d);
  m = Number(m);
  y = Number(y);
  if (y < 100) y += 2000;
  const hoy = new Date();
  if (y < 2000 || y > hoy.getFullYear() + 1 || m < 1 || m > 12 || d < 1) return null;
  const f = new Date(Date.UTC(y, m - 1, d));
  if (f.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Todas las fechas de un texto normalizado, en orden de aparición.
export function fechasEn(n) {
  const halladas = [];
  const agregar = (indice, iso) => iso && halladas.push({ indice, iso });
  for (const m of n.matchAll(/\b(\d{1,2})\s*(?:de\s+|[-/.]\s*)?([a-z]{3,10})\.?\s*(?:del?\s+|[-/,]\s*)?(\d{4})\b/g))
    if (MESES[m[2]]) agregar(m.index, armarFecha(m[1], MESES[m[2]], m[3]));
  for (const m of n.matchAll(/\b([a-z]{3,10})\.?\s+(\d{1,2})(?:\s+de)?,?\s+(\d{4})\b/g))
    if (MESES[m[1]]) agregar(m.index, armarFecha(m[2], MESES[m[1]], m[3]));
  for (const m of n.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g))
    agregar(m.index, armarFecha(m[3], m[2], m[1]));
  for (const m of n.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/g)) {
    // En Colombia es día/mes/año; si el segundo número no puede ser mes, viene al revés.
    const [d, mes] = Number(m[2]) > 12 && Number(m[1]) <= 12 ? [m[2], m[1]] : [m[1], m[2]];
    agregar(m.index, armarFecha(d, mes, m[3]));
  }
  return halladas.sort((a, b) => a.indice - b.indice);
}

const ETIQUETAS_FECHA = [[/\bf?echa( y hora)?( de (la )?(transaccion|transferencia|pago|operacion|envio))?\b/, 2]];
const EXCLUIR_FECHA = /(venc|expira|nacimiento|limite)/;

function extraerFecha(lineas) {
  const porEtiqueta = buscarPorEtiqueta(lineas, ETIQUETAS_FECHA, {
    excluir: EXCLUIR_FECHA,
    leer: (texto) => fechasEn(normalizar(texto))[0]?.iso ?? null,
  });
  if (porEtiqueta.length) return resultado(porEtiqueta[0]);

  const todas = [];
  for (const linea of lineas) {
    if (EXCLUIR_FECHA.test(linea.n)) continue;
    for (const f of fechasEn(linea.n)) todas.push({ valor: f.iso, linea, puntaje: 1 });
  }
  if (!todas.length) return resultado(null);
  // Una sola fecha en todo el comprobante: casi seguro es la del movimiento.
  const distintas = new Set(todas.map((f) => f.valor));
  return resultado(todas[0], distintas.size === 1 ? 'seguro' : 'dudoso');
}

// ---------- Referencia ----------

const ETIQUETAS_REFERENCIA = [
  // Tickets de corresponsal (Wompi/Redeban) y Daviplata: el número de aprobación.
  // Su "REF" es el código del cliente en el convenio y se repite entre pagos.
  // Tolera lecturas como "Aprco" o "Apreo" si justo después viene el número.
  [/\bapro(b|bacion)?\b|\bapr[a-z]{1,3}\b(?=\W{0,3}\d)/, 7],
  // Recaudos Bancolombia: el número único es el "Registro de Operación".
  [/\b[rk]?egistro de operacion\b/, 6],
  [/\bnumero de operacion\b/, 5],
  // "Referencia 1 / 2" de los recaudos es la cédula o el código del cliente: último recurso.
  [/\br[ae]ferencia ?\d\b/, 1],
  [/\b(numero de |no\.? ?(de )?|nro\.? ?)?r[ae]ferencia\b|\bref\b\.?/, 5],
  [/\b((no|nro|numero)\.? ?(de )?)?comprobante( (no|nro|numero)\.?| #)?/, 4],
  [/\b(numero|codigo|no\.?|nro\.?|#) ?(de )?(aprobacion|autorizacion)\b|\b(aprobacion|autorizacion)\b/, 3],
  [/\bcus\b/, 3],
  // Refácil: la etiqueta "Código" va sola en su renglón.
  [/^codigo:?$/, 4],
  [/\bid del? (reporte|pago|transaccion)\b/, 3],
  [/\b(numero|codigo|id|no\.?|nro\.?) ?(de )?(la )?(transaccion|operacion|transferencia)\b|\btransaccion ?(no\.?|#|nro\.?)/, 2],
  [/\bradicado\b/, 1],
];

// Números largos (Bre-B, Daviplata) se parten en dos renglones: unir el pedazo de abajo.
function conRenglonSiguiente(lineas, linea, codigo) {
  if (!codigo || codigo.valor.replace(/\D/g, '').length < 15) return codigo;
  const fin = linea.x + linea.ancho;
  const abajo = lineas
    .filter((l) => l.y > linea.y + linea.alto * 0.5 && l.y - (linea.y + linea.alto) < linea.alto * 1.5)
    .find((l) => /^\d{4,}$/.test(l.texto.trim()) && (Math.abs(l.x + l.ancho - fin) < 0.05 || Math.abs(l.x - linea.x) < 0.05));
  return abajo ? { ...codigo, valor: codigo.valor + abajo.texto.trim() } : codigo;
}

function codigoEn(texto) {
  for (const m of texto.matchAll(/[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]/g)) {
    const token = m[0];
    const digitos = (token.match(/\d/g) || []).length;
    if (token.length < 4 || digitos < 3) continue;
    if (/\$\s*$/.test(texto.slice(0, m.index))) continue;
    // Si alrededor hay más dígitos sueltos ("89/ 559113"), el OCR partió el número: revisar.
    const fuera = texto.slice(0, m.index) + texto.slice(m.index + token.length);
    return { valor: token, dudoso: /\d/.test(fuera) };
  }
  return null;
}

function extraerReferencia(lineas, banco) {
  const porEtiqueta = buscarPorEtiqueta(lineas, ETIQUETAS_REFERENCIA, {
    leer: (texto, h, cand) => {
      // Una fecha o un monto no son referencia.
      if (fechasEn(normalizar(texto)).length || /\$/.test(texto)) return null;
      // No leer un valor de otra etiqueta (p. ej. la línea de abajo dice "Fecha").
      if (cand.linea !== h.linea && /[a-z]{4,}/.test(normalizar(texto)) && !/\d{3}/.test(texto)) return null;
      return conRenglonSiguiente(lineas, cand.linea, codigoEn(texto));
    },
  });
  if (porEtiqueta.length) return resultado(porEtiqueta[0], porEtiqueta[0].puntaje > 1 ? 'seguro' : 'dudoso');

  // Nequi: las referencias tienen forma M12345678.
  for (const linea of lineas) {
    const m = linea.texto.match(/\bM\d{6,}\b/);
    if (m) return resultado({ valor: m[0], linea }, banco === 'Nequi' ? 'seguro' : 'dudoso');
  }
  return resultado(null);
}

// ---------- Proveedor / destinatario ----------

const ETIQUETAS_PROVEEDOR = [
  [/^(enviaste a|enviado a|envio a|le enviaste a|pago a|pagaste a|le pagaste a|pasaste (plata )?a|transferiste a|se envio a|a nombre de)\b/, 4],
  [/^(nombre (del? )?)?(conv[ae]nio|destinatario|beneficiario|proveedor|comercio|establecimiento|facturador|empresa)\b/, 3],
  [/^(razon social|producto destino|cuenta destino)\b/, 3],
  [/^titular( de la cuenta| del? producto| producto| cuenta)?\b/, 2],
  [/^nombre( del?)?( titular)?\b/, 2],
  // "Para" y "A" solo cuentan como etiqueta si van solas o con dos puntos.
  [/^(para|a)\s*(:|$)/, 2],
];
const NO_ES_NOMBRE =
  /^(fecha|hora|valor|monto|total|referencia|comprobante|cuenta|producto|numero|no\.|nit|cedula|cc\b|telefono|celular|banco|tipo|estado|descripcion|concepto|costo|saldo|ahorros|corriente)/;

// Ordena un nombre: "NORTE 5" → "NORTE S" (el OCR confunde S con 5) y "S A S" / "S.A.S." → "SAS".
export function arreglarNombre(nombre) {
  let t = nombre.replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase()) t = t.replace(/(?<=[A-ZÑ]{2,} )5(?= |$)/g, 'S');
  return t.replace(/\bS\.? ?A\.? ?S\.?$/i, 'SAS').replace(/\bS\.? ?A\.?$/, 'SA');
}

function limpiarNombre(texto) {
  const t = texto.replace(/^[\s:.\-]+/, '').replace(/[\s:.\-]+$/, '').trim();
  const n = normalizar(t);
  const letras = (n.match(/[a-z]/g) || []).length;
  const digitos = (n.match(/\d/g) || []).length;
  if (letras < 3 || digitos > letras || /\$/.test(t) || NO_ES_NOMBRE.test(n)) return null;
  return t;
}

// Nombres largos se parten en dos renglones ("...DEL NORTE S" + "A S"): unir el pedacito de abajo.
function conContinuacion(lineas, linea, nombre) {
  const siguiente = debajo(lineas, linea, 1.2)[0];
  if (siguiente && /^[A-ZÑ][A-ZÑ. ]{0,7}$/.test(siguiente.texto.trim())) return `${nombre} ${siguiente.texto.trim()}`;
  return nombre;
}

const ENCABEZADOS_GENERICOS =
  /(exitos|listo|comprobante|transferencia|recibo|factura|nit\b|fecha|total|gracias|pago|envio|pasaste|transaccion|aprobad|registro|recaudo|deposito|bancolombia|nequi|daviplata|davivienda|banco)/;

function extraerProveedor(lineas) {
  const porEtiqueta = buscarPorEtiqueta(lineas, ETIQUETAS_PROVEEDOR, {
    alInicio: true,
    leer: (texto, h, cand) => {
      const limpio = limpiarNombre(texto);
      if (!limpio) return null;
      const nombre = arreglarNombre(conContinuacion(lineas, cand.linea, limpio));
      // Termina en una letra suelta ("...DEL NORTE S"): seguramente quedó cortado.
      return { valor: nombre, dudoso: /\s\S$/.test(nombre) };
    },
  });
  if (porEtiqueta.length) return resultado(porEtiqueta[0]);

  // Recibos impresos: el nombre del negocio suele ser la primera línea en MAYÚSCULAS.
  for (const linea of lineas.filter((l) => l.y < 0.3)) {
    const letras = linea.texto.match(/\p{L}/gu) || [];
    const mayusculas = letras.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase());
    if (letras.length < 4 || mayusculas.length / letras.length < 0.7) continue;
    if (ENCABEZADOS_GENERICOS.test(linea.n)) continue;
    const nombre = limpiarNombre(linea.texto);
    if (nombre) return resultado({ valor: arreglarNombre(nombre), linea }, 'dudoso');
  }
  return resultado(null);
}

// ---------- Cuenta destino y convenio (para reconocer al proveedor en el catálogo) ----------

const ETIQUETAS_CUENTA = [
  [/\b(numero de cuenta|cuenta destino|producto destino|llave que recibe|codigo del comercio|cuenta)\b/, 2],
  [/^(destino|numero)\b/, 1],
];
// Números que NO son la cuenta de quien recibe.
const NO_ES_CUENTA = /(origen|c\.? ?unico|\bter\b|rrn|recibo|apro|\bnit\b|identificacion|telefono|celular|atencion|desde)/;

function cuentaEn(texto) {
  const m = texto.replace(/(\d)[\s.-]+(?=\d)/g, '$1').match(/\d{8,}/);
  return m ? m[0] : null;
}

function extraerCuenta(lineas) {
  const porEtiqueta = buscarPorEtiqueta(lineas, ETIQUETAS_CUENTA, {
    excluir: NO_ES_CUENTA,
    leer: (texto, h, cand) => (NO_ES_CUENTA.test(cand.linea.n) ? null : cuentaEn(texto)),
  });
  if (porEtiqueta.length) return porEtiqueta[0].valor;
  // "Producto destino" deja la cuenta dos o tres renglones más abajo (nombre, tipo, número).
  const destino = lineas.find((l) => /\bproducto destino\b/.test(l.n));
  if (destino) {
    const siguientes = lineas.filter((l) => l.y > destino.y && l.y < destino.y + 0.2 && Math.abs(l.x - destino.x) < 0.15);
    for (const l of siguientes) {
      if (/\bproducto origen\b/.test(l.n)) break;
      const cuenta = cuentaEn(l.texto);
      if (cuenta) return cuenta;
    }
  }
  return '';
}

function extraerConvenio(lineas) {
  for (const linea of lineas) {
    const m = linea.n.match(/\bconv[ae]nio\W{0,3}(\d{4,6})\b/);
    if (m) return m[1];
  }
  const porEtiqueta = buscarPorEtiqueta(lineas, [[/\b(codigo )?conv[ae]nio\b/, 1]], {
    leer: (texto) => texto.match(/^\D{0,3}(\d{4,6})\b/)?.[1] ?? null,
  });
  return porEtiqueta[0]?.valor ?? '';
}

// ---------- Principal ----------

function extraerDeUnaLectura(lineasOcr) {
  const lineas = prepararLineas(lineasOcr || []);
  const banco = detectarBanco(lineas);
  return {
    banco,
    cuentaDestino: extraerCuenta(lineas),
    convenio: extraerConvenio(lineas),
    campos: {
      fecha: extraerFecha(lineas),
      valor: extraerValor(lineas),
      referencia: extraerReferencia(lineas, banco),
      proveedor: extraerProveedor(lineas),
    },
  };
}

const RANGO = { seguro: 2, dudoso: 1, vacio: 0 };
const clave = (v) => (typeof v === 'string' ? normalizar(v).replace(/[^a-z0-9]/g, '') : String(v));

// Combina varias lecturas del OCR de la misma imagen: se queda con el valor mejor
// respaldado por su etiqueta y, si las lecturas no coinciden, lo marca para revisar.
export function extraerVarias(lecturas) {
  const resultados = lecturas.filter((l) => l && l.length).map(extraerDeUnaLectura);
  if (!resultados.length) resultados.push(extraerDeUnaLectura([]));
  const final = {
    banco: resultados.map((r) => r.banco).find(Boolean) || '',
    cuentaDestino: resultados.map((r) => r.cuentaDestino).find(Boolean) || '',
    convenio: resultados.map((r) => r.convenio).find(Boolean) || '',
    confianza: {},
  };
  for (const campo of CAMPOS) {
    const candidatos = resultados
      .map((r) => r.campos[campo])
      .filter((c) => c.conf !== 'vacio')
      .sort((a, b) => b.puntaje - a.puntaje || RANGO[b.conf] - RANGO[a.conf]);
    const elegido = candidatos[0];
    const distintos = new Set(candidatos.map((c) => clave(c.valor)));
    final[campo] = elegido ? elegido.valor : campo === 'valor' ? null : '';
    final.confianza[campo] = !elegido ? 'vacio' : distintos.size > 1 ? 'dudoso' : elegido.conf;
  }
  return final;
}

export function extraer(lineasOcr) {
  return extraerVarias([lineasOcr]);
}
