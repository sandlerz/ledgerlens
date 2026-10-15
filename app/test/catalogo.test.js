import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identificarProveedor } from '../lib/catalogo.js';

// Proveedores, cuentas y convenios inventados.
const P = (id, nombre, cuentas = [], convenios = [], alias = []) => ({ id, nombre, cuentas, convenios, alias });
const catalogo = [
  P('norte', 'Distribuidora del Norte SAS', ['12345678901', '0012345678'], [], ['DISTRIBUIDORA NORTE. 3X']),
  P('caribe', 'Servicios del Caribe SAS', [], ['54321']),
  P('andino', 'Mayorista Andino Central SAS', ['00100023456'], ['11223']),
  P('pedro', 'Pedro Antonio Gomez Rios', ['09876543210']),
  P('juana', 'Juana Perez'),
];
const id = (datos) => identificarProveedor(datos, catalogo);

test('Cuenta destino con o sin guiones y ceros', () => {
  assert.equal(id({ cuentaDestino: '123 - 456789 - 01' }).id, 'norte');
  assert.equal(id({ cuentaDestino: '100023456' }).id, 'andino');
  assert.equal(id({ cuentaDestino: '0012345678' }).id, 'norte'); // llave Bre-B
});

test('Convenio, y convenio o cuenta encontrados en el texto aunque la IA no los dé', () => {
  assert.equal(id({ convenio: '54321' }).id, 'caribe');
  assert.equal(id({ texto: 'RECAUDO\nCONVENIO: 54321\nSERVICIOS DEL C' }).id, 'caribe');
  assert.equal(id({ texto: 'Destino Cuenta Ahorros\n09876543210\nPEDRO GOMEZ R.' }).id, 'pedro');
});

test('Nombre cortado, enmascarado o con confusiones del OCR', () => {
  assert.equal(id({ nombreLeido: 'SERVICIOS DEL C' }).id, 'caribe');
  assert.equal(id({ nombreLeido: 'May*** And*** Cen*** Sas***' }).id, 'andino');
  assert.equal(id({ nombreLeido: 'Ped*** Ant*** GOM*** Rio***' }).id, 'pedro');
  assert.equal(id({ nombreLeido: 'DISTRIBUIDORA NORTE. 3X' }).id, 'norte');
  assert.equal(id({ nombreLeido: 'SERVICI0S DEL CARIBE 5A5' }).id, 'caribe');
});

test('Nombre conocido dentro del texto aunque no se haya extraído', () => {
  assert.equal(id({ texto: 'Compra exitosa\nCompra realizada en\nDISTRIBUIDORA NORTE. 3X\nValor $750.000' }).id, 'norte');
});

test('No confunde nombres distintos ni inventa', () => {
  assert.equal(id({ nombreLeido: 'Juan Perez' }).id, null);
  assert.equal(id({ nombreLeido: 'Nombre' }).id, null);
  assert.equal(id({}).conf, 'vacio');
});

test('Cuenta enmascarada solo da una pista dudosa', () => {
  const r = id({ cuentaDestino: '****8901' });
  assert.equal(r.id, 'norte');
  assert.equal(r.conf, 'dudoso');
});
