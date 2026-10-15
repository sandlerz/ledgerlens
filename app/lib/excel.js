import ExcelJS from 'exceljs';

const COLUMNAS = [
  { header: 'Local', key: 'local', width: 20 },
  { header: 'Fecha', key: 'fecha', width: 12 },
  { header: 'Valor', key: 'valor', width: 18 },
  { header: 'Referencia', key: 'referencia', width: 22 },
  { header: 'Proveedor/Destinatario', key: 'proveedor', width: 36 },
  { header: 'Estado', key: 'estado', width: 13 },
  { header: 'Archivo', key: 'archivo', width: 40 },
];

// Una sola hoja "Movimientos", con filtros, encabezado fijo y total al final.
// La fecha es fecha real de Excel, el valor es número y la referencia es texto (no pierde ceros).
export async function crearExcel(movimientos) {
  const libro = new ExcelJS.Workbook();
  libro.creator = 'Comprobantes';
  const hoja = libro.addWorksheet('Movimientos', { views: [{ state: 'frozen', ySplit: 1 }] });
  hoja.columns = COLUMNAS;

  const conCentavos = movimientos.some((m) => m.valor != null && !Number.isInteger(m.valor));
  const formatoValor = conCentavos ? '"$" #,##0.00' : '"$" #,##0';

  for (const m of movimientos) {
    const [y, mes, d] = (m.fecha || '').split('-').map(Number);
    const fila = hoja.addRow({
      local: m.local,
      fecha: m.fecha ? new Date(Date.UTC(y, mes - 1, d)) : null,
      valor: m.valor,
      referencia: m.referencia || '',
      proveedor: m.proveedor || '',
      estado: m.estado === 'revisado' ? 'Revisado' : 'Por revisar',
      archivo: m.archivo,
    });
    fila.getCell('fecha').numFmt = 'dd/mm/yyyy';
    fila.getCell('valor').numFmt = formatoValor;
    fila.getCell('referencia').numFmt = '@';
  }

  const ultima = movimientos.length + 1;
  const encabezado = hoja.getRow(1);
  encabezado.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  encabezado.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5D50' } };
  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: ultima, column: COLUMNAS.length } };

  // SUBTOTAL suma solo las filas visibles: el total se actualiza al filtrar en Excel.
  const total = movimientos.reduce((s, m) => s + (m.valor || 0), 0);
  const filaTotal = hoja.addRow({ local: 'TOTAL' });
  filaTotal.getCell('valor').value = movimientos.length
    ? { formula: `SUBTOTAL(9,C2:C${ultima})`, result: total }
    : 0;
  filaTotal.getCell('valor').numFmt = formatoValor;
  filaTotal.font = { bold: true };

  return libro.xlsx.writeBuffer();
}
