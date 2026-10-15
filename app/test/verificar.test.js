import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combinarLecturas } from '../lib/verificar.js';

const TEXTO = `Wompi
Monto: $1.234.000,00
SEP 10 2026 - 10:20:30
Referencia: 11223344
RRN: 990011223344 Aprob: 445566`;

test('IA y reglas coinciden y está en el texto: seguro', () => {
  const r = combinarLecturas(
    { fecha: '2026-09-10', valor: 1234000, referencia: '445566' },
    { fecha: '2026-09-10', valor: 1234000, referencia: '445566', confianza: { fecha: 'seguro', valor: 'seguro', referencia: 'seguro' } },
    TEXTO
  );
  assert.deepEqual(r.confianza, { fecha: 'seguro', valor: 'seguro', referencia: 'seguro' });
});

test('Un número que la IA inventó (no está en el texto) queda dudoso', () => {
  const r = combinarLecturas({ fecha: '2026-09-10', valor: 1243000, referencia: '445565' }, null, TEXTO);
  assert.equal(r.confianza.valor, 'dudoso');
  assert.equal(r.confianza.referencia, 'dudoso');
});

test('Si difieren, gana el que está en el texto', () => {
  const r = combinarLecturas(
    { valor: 1234000, referencia: '445566', fecha: '' },
    { valor: 990011223344, referencia: '11223344', fecha: '2026-09-10', confianza: { valor: 'dudoso', referencia: 'seguro', fecha: 'seguro' } },
    TEXTO
  );
  assert.equal(r.valor, 1234000);
  assert.equal(r.confianza.valor, 'seguro');
  // En la referencia mandan las reglas (etiqueta exacta del formato) y su confianza.
  assert.equal(r.referencia, '11223344');
  assert.equal(r.confianza.referencia, 'seguro');
  // La IA no dio fecha: se usa la de las reglas, marcada para revisar.
  assert.equal(r.fecha, '2026-09-10');
  assert.equal(r.confianza.fecha, 'dudoso');
});

test('Número largo partido en dos renglones cuenta como presente en el texto', () => {
  const r = combinarLecturas(
    { referencia: '12345678901234567890123456789012345' },
    null,
    'Número de operación\n1234567890123456789012\nTipo\n3456789012345'
  );
  assert.equal(r.confianza.referencia, 'seguro');
});

test('Sin datos: vacío', () => {
  const r = combinarLecturas({ referencia: '' }, { referencia: '', confianza: {} }, TEXTO);
  assert.equal(r.confianza.referencia, 'vacio');
});

test('Dos montos distintos en el texto (OCR dudoso): queda para revisar aunque la IA elija uno', () => {
  const r = combinarLecturas(
    { valor: 4323500 },
    { valor: 4321500, confianza: { valor: 'dudoso' } },
    'Valor Total: $ 4.321.500.00\n(alor Efectivo: $ 4,323,500.00'
  );
  assert.equal(r.confianza.valor, 'dudoso');
});
