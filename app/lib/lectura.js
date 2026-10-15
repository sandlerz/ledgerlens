// Lee un comprobante ya pasado por el OCR: reglas + IA local (si hay modelo) + verificación
// cruzada + proveedor del catálogo. La usan el procesamiento de la app y el comparador.

import { soloDigitos } from './catalogo.js';
import { extraerVarias } from './extraer.js';
import { leerConIA, textoDeLineas } from './ia.js';
import { combinarLecturas } from './verificar.js';

export async function leerComprobante({ ruta, ocr, giro = 0 }, { modelo, catalogo }) {
  const pasadas = ocr || [];
  const reglas = extraerVarias(pasadas);
  const texto = pasadas.map(textoDeLineas).join('\n');

  let ia = null;
  let errorIA = '';
  if (modelo) {
    try {
      ia = await leerConIA(ruta, pasadas[0], { modelo, giro });
      // Una "referencia" que en realidad es la cuenta, la llave o el convenio no sirve.
      const ref = soloDigitos(ia.referencia);
      const cuentas = [ia.cuentaDestino, ia.convenio, reglas.cuentaDestino, reglas.convenio, ...catalogo.proveedores.flatMap((p) => [...p.cuentas, ...p.convenios])];
      if (ref && cuentas.some((c) => soloDigitos(c) === ref)) ia.referencia = '';
    } catch (error) {
      errorIA = error.message || 'Falló la IA local';
    }
  }

  const campos = ia
    ? combinarLecturas(ia, reglas, texto)
    : { fecha: reglas.fecha, valor: reglas.valor, referencia: reglas.referencia, confianza: { ...reglas.confianza } };

  const datosProveedor = {
    cuentaDestino: ia?.cuentaDestino || reglas.cuentaDestino,
    convenio: ia?.convenio || reglas.convenio,
    nombreLeido: ia?.nombreDestino || reglas.proveedor,
  };
  let proveedor = catalogo.identificar({ ...datosProveedor, texto });
  // Si con lo de la IA no se reconoce, se intenta con lo que leyeron las reglas.
  if (!proveedor.id && ia)
    proveedor = catalogo.identificar({
      cuentaDestino: reglas.cuentaDestino,
      convenio: reglas.convenio,
      nombreLeido: reglas.proveedor,
      texto,
    });

  return {
    fecha: campos.fecha,
    valor: campos.valor,
    referencia: campos.referencia,
    confianza: { ...campos.confianza, proveedor: proveedor.conf },
    proveedorId: proveedor.id,
    motivoProveedor: proveedor.motivo,
    ...datosProveedor,
    banco: ia?.banco || reglas.banco,
    tipo: ia?.tipo || '',
    lector: ia ? modelo : 'reglas',
    errorIA,
    segundosIA: ia?.segundos ?? null,
  };
}
