// Lectura de comprobantes con un modelo de visión local (Ollama): gratis y sin internet.
// Se le manda la imagen y el texto que ya leyó el OCR de Apple; el modelo entiende el
// formato y el OCR le da los números exactos.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseMonto } from './extraer.js';

const ejecutar = promisify(execFile);
const OLLAMA = 'http://127.0.0.1:11434';
export const MODELO_POR_DEFECTO = 'qwen3-vl:8b-instruct';

export const TIPOS = [
  'transferencia_app',
  'bre_b',
  'nequi',
  'daviplata',
  'davivienda',
  'corresponsal_wompi',
  'corresponsal_redeban',
  'recaudo_impreso',
  'refacil',
  'otro',
];

const ESQUEMA = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: TIPOS },
    banco: { type: 'string' },
    fecha: { type: 'string' },
    valor: { type: 'number' },
    referencia: { type: 'string' },
    nombre_destino: { type: 'string' },
    cuenta_destino: { type: 'string' },
    convenio: { type: 'string' },
  },
  required: ['tipo', 'banco', 'fecha', 'valor', 'referencia', 'nombre_destino', 'cuenta_destino', 'convenio'],
};

const INSTRUCCIONES = `Extraes datos de comprobantes de pago colombianos (fotos o capturas). Responde solo con el JSON pedido.

Campos:
- fecha: fecha de la transacción en formato AAAA-MM-DD. Si no aparece o dice "Invalid Date", usa "".
- valor: el monto pagado o transferido, como número sin separadores. En Colombia "$ 1.250.000,00" = 1250000 y "$ 4,321,500.00" = 4321500. Nunca uses costo, comisión, saldo, IVA, propina ni "Valor cheque $0".
- referencia: el número propio de ESA transacción, según el formato:
  · App Bancolombia "¡Transferencia exitosa!" o "¡Pago exitoso!": "Comprobante No."
  · Transferencia con llave (Bre-B): "Número de operación" completo (puede ocupar dos renglones: únelos sin espacios).
  · Nequi: "Referencia" (empieza por M).
  · Daviplata: "Número de aprobación". Davivienda app: "Número de comprobante". Recibo Davivienda: "No Transacción".
  · Ticket corresponsal Wompi o Redeban: el número de "Aprob" o "APRO". NO uses "REF", "Referencia", "Recibo" ni "RRN".
  · Recaudo impreso Bancolombia: "Registro de Operación". NO uses "Referencia 1".
  · Refácil: "Código".
  · Otro: el número único de la transacción. Si no hay ninguno (por ejemplo, un correo de notificación), usa "".
  Copia los dígitos exactamente como en el texto OCR. Nunca inventes dígitos: si no se lee, usa "".
- nombre_destino: quien RECIBE el dinero, tal como aparece (aunque esté cortado "DISTRIBUIDORA DEL N" o enmascarado "Dis*** Nor***"). En tickets Wompi/Redeban el nombre del encabezado es la tienda corresponsal, NO es el destino: el destino va junto a "Nombre", "Titular" o debajo del convenio.
- cuenta_destino: número de cuenta, llave o código de comercio de quien recibe (por ejemplo "Número de cuenta", "Destino", "Producto destino", "Llave que recibe", "Código del comercio", "Número"). Nunca la cuenta de origen, ni "C. Único", "TER", "RRN", "Recibo", NIT o cédulas. Si no aparece, "".
- convenio: código de "Convenio" o "Código Convenio" si existe; si no, "".
- banco: banco o app del comprobante (Bancolombia, Nequi, Daviplata, Davivienda, Wompi, Redeban, Refácil…).`;

export async function estadoIA(modelo = MODELO_POR_DEFECTO) {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const { models = [] } = await res.json();
    const nombres = models.map((m) => m.name);
    return { activa: true, modelo, instalado: nombres.includes(modelo), modelos: nombres };
  } catch {
    return { activa: false, modelo, instalado: false, modelos: [] };
  }
}

// Endereza la imagen (según el giro que detectó el OCR) y la reduce a 1200 px como JPEG temporal:
// los números exactos ya vienen del OCR, y una imagen más pequeña se lee mucho más rápido.
async function imagenEnBase64(ruta, giro) {
  const temporal = path.join(os.tmpdir(), `comprobante-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const argumentos = ['-s', 'format', 'jpeg', '-Z', '1200'];
  if (giro) argumentos.push('-r', String(giro));
  try {
    await ejecutar('sips', [...argumentos, ruta, '--out', temporal]);
    return fs.readFileSync(temporal).toString('base64');
  } finally {
    fs.rmSync(temporal, { force: true });
  }
}

export function textoDeLineas(lineas) {
  return [...(lineas || [])]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((l) => l.texto)
    .join('\n');
}

const texto = (v) => (typeof v === 'string' ? v.trim() : '');

export async function leerConIA(ruta, lineasOcr, { modelo = MODELO_POR_DEFECTO, giro = 0 } = {}) {
  const inicio = Date.now();
  const imagen = await imagenEnBase64(ruta, giro);
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model: modelo,
      stream: false,
      think: false,
      keep_alive: '15m',
      format: ESQUEMA,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: INSTRUCCIONES },
        {
          role: 'user',
          content: `Texto leído por OCR (los números suelen estar bien; algunas letras pueden fallar):\n${textoDeLineas(lineasOcr)}\n\nExtrae los datos de este comprobante.`,
          images: [imagen],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const datos = await res.json();
  const r = JSON.parse(datos.message.content);
  const valor = typeof r.valor === 'number' ? r.valor : parseMonto(r.valor);
  return {
    tipo: TIPOS.includes(r.tipo) ? r.tipo : 'otro',
    banco: texto(r.banco),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(texto(r.fecha)) ? texto(r.fecha) : '',
    valor: valor > 0 ? valor : null,
    referencia: texto(r.referencia).replace(/\s+/g, ''),
    nombreDestino: texto(r.nombre_destino),
    cuentaDestino: texto(r.cuenta_destino),
    convenio: texto(r.convenio),
    modelo,
    segundos: Math.round((Date.now() - inicio) / 100) / 10,
  };
}
