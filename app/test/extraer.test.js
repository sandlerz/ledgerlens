import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extraer, parseMonto, fechasEn } from '../lib/extraer.js';

// Línea de OCR de mentira: texto en la posición (x, y), coordenadas 0–1.
const L = (texto, y, x = 0.05, alto = 0.03, confianza = 1) => ({
  texto,
  y,
  x,
  alto,
  ancho: Math.min(0.9, texto.length * 0.02),
  confianza,
});

test('parseMonto entiende formatos colombianos e internacionales', () => {
  assert.equal(parseMonto('$ 1.250.000,00'), 1250000);
  assert.equal(parseMonto('$1.250.000'), 1250000);
  assert.equal(parseMonto('1,250,000.50'), 1250000.5);
  assert.equal(parseMonto('$ 2.350'), 2350);
  assert.equal(parseMonto('12,50'), 12.5);
  assert.equal(parseMonto('80000'), 80000);
  assert.equal(parseMonto('sin número'), null);
});

test('fechasEn reconoce formatos comunes', () => {
  assert.equal(fechasEn('14 de octubre de 2026 a las 03:45 p.m.')[0].iso, '2026-10-14');
  assert.equal(fechasEn('14 oct 2026 - 10:22')[0].iso, '2026-10-14');
  assert.equal(fechasEn('fecha: 13/10/2026')[0].iso, '2026-10-13');
  assert.equal(fechasEn('2026-10-01 08:00')[0].iso, '2026-10-01');
  assert.equal(fechasEn('octubre 5, 2026')[0].iso, '2026-10-05');
  assert.equal(fechasEn('5-sept-2026')[0].iso, '2026-09-05');
  assert.equal(fechasEn('10/25/2026')[0].iso, '2026-10-25'); // mes/día al revés
  assert.equal(fechasEn('nit 900.123.456-7').length, 0);
});

test('Nequi: etiqueta arriba y valor abajo', () => {
  const r = extraer([
    L('¡Listo! Envío exitoso', 0.05, 0.05, 0.04),
    L('Para', 0.16),
    L('CARLOS ANDRES PEREZ', 0.19),
    L('¿Cuánto?', 0.25),
    L('$ 125.000,00', 0.28, 0.05, 0.04),
    L('Número Nequi', 0.35),
    L('300 123 4567', 0.38),
    L('Fecha', 0.45),
    L('14 de octubre de 2026 a las 03:45 p. m.', 0.48),
    L('Referencia', 0.54),
    L('M12345678', 0.57),
  ]);
  assert.equal(r.banco, 'Nequi');
  assert.equal(r.valor, 125000);
  assert.equal(r.fecha, '2026-10-14');
  assert.equal(r.referencia, 'M12345678');
  assert.equal(r.proveedor, 'CARLOS ANDRES PEREZ');
  assert.deepEqual(Object.values(r.confianza), ['seguro', 'seguro', 'seguro', 'seguro']);
});

test('Bancolombia: etiqueta a la izquierda, valor a la derecha; ignora el costo', () => {
  const r = extraer([
    L('Bancolombia', 0.05),
    L('Comprobante No. 0000482913', 0.19),
    L('14 Oct 2026 - 10:22 a.m.', 0.24),
    L('Destinatario', 0.4),
    L('DISTRIBUIDORA LA ESPERANZA SAS', 0.4, 0.45),
    L('Costo de la transferencia', 0.47),
    L('$ 0,00', 0.47, 0.85),
    L('Valor enviado', 0.53),
    L('$ 2.350.000,00', 0.53, 0.74),
  ]);
  assert.equal(r.valor, 2350000);
  assert.equal(r.referencia, '0000482913');
  assert.equal(r.fecha, '2026-10-14');
  assert.equal(r.proveedor, 'DISTRIBUIDORA LA ESPERANZA SAS');
});

test('Daviplata: etiqueta y valor en la misma línea; no confunde el saldo', () => {
  const r = extraer([
    L('DaviPlata', 0.06),
    L('Saldo disponible: $ 1.204.500', 0.2),
    L('Valor: $ 80.000', 0.25),
    L('A: JUAN DAVID GOMEZ', 0.31),
    L('Fecha: 13/10/2026 Hora: 18:05', 0.37),
    L('Número de aprobación: 058213', 0.43),
  ]);
  assert.equal(r.banco, 'Daviplata');
  assert.equal(r.valor, 80000);
  assert.equal(r.fecha, '2026-10-13');
  assert.equal(r.referencia, '058213');
  assert.equal(r.proveedor, 'JUAN DAVID GOMEZ');
});

test('Recibo impreso: TOTAL gana sobre SUBTOTAL y el negocio sale del encabezado', () => {
  const r = extraer([
    L('DISTRIBUIDORA EL TRIUNFO', 0.05, 0.12, 0.05),
    L('NIT 900.123.456-7', 0.11, 0.26),
    L('FECHA: 12/10/2026 HORA: 11:32', 0.24),
    L('SUBTOTAL', 0.41),
    L('$ 45.000', 0.406, 0.31),
    L('TOTAL', 0.464),
    L('$ 45.900', 0.452, 0.33, 0.037),
    L('No. TRANSACCION: 778812', 0.53),
  ]);
  assert.equal(r.valor, 45900);
  assert.equal(r.fecha, '2026-10-12');
  assert.equal(r.referencia, '778812');
  assert.equal(r.proveedor, 'DISTRIBUIDORA EL TRIUNFO');
  assert.equal(r.confianza.proveedor, 'dudoso');
});

test('Sin etiquetas: adivina el monto más grande en pantalla y lo marca dudoso', () => {
  const r = extraer([L('Pago exitoso', 0.05), L('$ 50.000', 0.2, 0.3, 0.06), L('$ 1.000', 0.4)]);
  assert.equal(r.valor, 50000);
  assert.equal(r.confianza.valor, 'dudoso');
  assert.equal(r.confianza.referencia, 'vacio');
});

test('Imagen sin texto: todo vacío', () => {
  const r = extraer([]);
  assert.equal(r.valor, null);
  assert.equal(r.fecha, '');
  assert.deepEqual(Object.values(r.confianza), ['vacio', 'vacio', 'vacio', 'vacio']);
});

// Formatos tomados de comprobantes reales (con datos inventados).

test('Recaudo Bancolombia impreso: referencia = Registro de Operación, nombre partido en dos renglones', () => {
  const r = extraer([
    L('Registro de Operación: 123456789', 0.21),
    L('RECAUDOS CONVENIOS MASIVOS', 0.24),
    L('Fecha: 02/10/2026 Hora: 12:08:01', 0.33),
    L('Codigo Convenio: 11111', 0.38),
    L('Nombre Convenio: SERVICIOS DEL NORTE S', 0.41),
    L('A S', 0.44),
    L('Identificación Pagador: 1000000001', 0.5),
    L('Valor Total: $ 6,410,000.00 ***', 0.53),
    L('Valor Efectivo: $ 6,410,000.00 ***', 0.58),
    L('Valor Cheque: $ 0.00 ***', 0.61),
    L('Costo Transaccion: $ 0.00 ***', 0.64),
    L('Referencia 1: 1000000001', 0.67),
  ]);
  assert.equal(r.banco, 'Bancolombia');
  assert.equal(r.fecha, '2026-10-02');
  assert.equal(r.valor, 6410000);
  assert.equal(r.referencia, '123456789');
  assert.equal(r.proveedor, 'SERVICIOS DEL NORTE SAS');
  assert.deepEqual(Object.values(r.confianza), ['seguro', 'seguro', 'seguro', 'seguro']);
});

test('Recaudo con OCR imperfecto: número partido y valores que no cuadran quedan dudosos', () => {
  const r = extraer([
    L('Registro de Operacion: 12/ 3456789', 0.18),
    L('Fecha: 02/10/2026 Hora: 11:58:52', 0.31),
    L('Nombre Convenio: SERVICIOS DEL NORTE 5', 0.39),
    L('Valor Total: $ 4,321,500.00', 0.55),
    L('(alor Efectivo: $ 4,323,500.00 **', 0.62),
  ]);
  assert.equal(r.valor, 4321500);
  assert.equal(r.confianza.valor, 'dudoso');
  assert.equal(r.referencia, '3456789');
  assert.equal(r.confianza.referencia, 'dudoso');
  assert.equal(r.proveedor, 'SERVICIOS DEL NORTE S');
  assert.equal(r.confianza.proveedor, 'dudoso');
});

test('Depósito Davivienda: Vr. Total, No Transaccion y Titular Producto en el renglón de abajo', () => {
  const r = extraer([
    L('BANCO DAVIVIENDA', 0.21, 0.28),
    L('Fecha: 05/10/2026 Hora: 15:01:00', 0.27),
    L('No Cuenta:', 0.44),
    L('0000200000000001', 0.444, 0.47),
    L('Titular Producto:', 0.47),
    L('SERVICIOS DEL NORTE SAS', 0.5, 0.14),
    L('Vr. Efectivo:', 0.53),
    L('$1,875,000.00', 0.534, 0.54),
    L('Vr. Total:', 0.59),
    L('$1,875,000.00', 0.593, 0.54),
    L('Costo transaccion:', 0.615),
    L('$0.00', 0.625, 0.74),
    L('No Transaccion:', 0.641),
    L('246810', 0.655, 0.71),
  ]);
  assert.equal(r.banco, 'Davivienda');
  assert.equal(r.valor, 1875000);
  assert.equal(r.referencia, '246810');
  assert.equal(r.proveedor, 'SERVICIOS DEL NORTE SAS');
});

test('Transferencia app Bancolombia: destinatario bajo "Producto destino", no el de origen', () => {
  const r = extraer([
    L('¡Transferencia exitosa!', 0.09, 0.09, 0.046),
    L('Comprobante No. 0000007300', 0.17, 0.2, 0.024),
    L('13 Oct 2026 - 10:15 a m.', 0.19, 0.25, 0.034),
    L('Valor de la transferencia', 0.38, 0.04, 0.022),
    L('$ 1.200.000', 0.4, 0.03, 0.036),
    L('Producto destino', 0.51, 0.03, 0.032),
    L('Comercial Ejemplo Sas', 0.59, 0.03, 0.04),
    L('Ahorros', 0.63, 0.03, 0.024),
    L('Producto origen', 0.77, 0.03, 0.032),
    L('Cuenta de Ahorros', 0.84, 0.03, 0.032),
  ]);
  assert.equal(r.valor, 1200000);
  assert.equal(r.fecha, '2026-10-13');
  assert.equal(r.referencia, '0000007300');
  assert.equal(r.proveedor, 'Comercial Ejemplo SAS');
});

test('Wompi: el "Aprob" se reconoce aunque el OCR lo lea mal ("Aprco", con "А" cirílica)', () => {
  const r = extraer([
    L('Wompi', 0.05),
    L('Monto: $3.000.000,00', 0.4),
    L('Recibo: 412233', 0.618),
    L('RRN: 900112412233 Аprco 734512', 0.64),
  ]);
  assert.equal(r.referencia, '734512');
});
