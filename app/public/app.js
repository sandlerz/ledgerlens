const $ = (s) => document.querySelector(s);
const CAMPOS = ['fecha', 'valor', 'referencia', 'proveedor'];
// En el formulario, el proveedor se elige de una lista (por id).
const nombreDeCampo = (campo) => (campo === 'proveedor' ? 'proveedorId' : campo);

const estado = {
  movimientos: [],
  proveedores: [], // catálogo: { id, nombre, cuentas, convenios, alias, comprobantes }
  locales: [],
  carpeta: '',
  ia: null,
  seleccionado: null, // id
  detalle: null, // movimiento completo (con texto OCR)
  zoom: 1,
  giro: 0,
  ultimoCampo: null,
  sondeo: null,
  accion: '', // 'procesar' | 'releer' mientras corre
};

// ---------- Formatos ----------

const pesos = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const numero = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const fmtValor = (v) => (v == null ? '' : pesos.format(v));
const fmtFecha = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const esc = (t) =>
  String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function avisar(texto) {
  const aviso = $('#aviso');
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (aviso.hidden = true), 3500);
}

async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: opciones.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res;
}

// ---------- Datos ----------

const json = (ruta, opciones) => api(ruta, opciones).then((r) => r.json());

async function cargar() {
  const [datos, proveedores] = await Promise.all([json('/api/movimientos'), json('/api/proveedores')]);
  estado.movimientos = datos.movimientos;
  estado.proveedores = proveedores;
  pintarFiltros();
  pintarTabla();
}

async function cargarEstado() {
  const datos = await json('/api/estado');
  estado.carpeta = datos.carpeta;
  estado.locales = datos.locales;
  estado.ia = datos.ia;
  const nuevas = $('#nuevas');
  nuevas.hidden = !datos.nuevas;
  nuevas.textContent = datos.nuevas;

  const ia = datos.ia;
  const lista = ia.activa && ia.instalado;
  const chip = $('#estadoIA');
  chip.hidden = false;
  chip.className = `chip-ia ${lista ? 'activa' : 'apagada'}`;
  chip.textContent = lista ? 'IA local lista' : ia.activa ? 'Falta el modelo de IA' : 'IA local apagada';
  chip.title = lista
    ? `Lee con ${ia.modelo} (Ollama), gratis y sin internet.`
    : ia.activa
      ? `Descarga el modelo en la Terminal: ollama pull ${ia.modelo}`
      : 'Abre Ollama para leer con IA. Mientras tanto se usa la lectura básica (menos precisa).';
  $('#releer').hidden = !(lista && datos.pendientesIA > 0) || datos.progreso.activo;
  $('#pendientesIA').textContent = datos.pendientesIA;
  pintarFiltros();
  return datos;
}

function filtrados() {
  const local = $('#fLocal').value;
  const proveedor = $('#fProveedor').value;
  const est = $('#fEstado').value;
  const desde = $('#fDesde').value;
  const hasta = $('#fHasta').value;
  const texto = $('#fTexto').value.trim().toLowerCase();
  return estado.movimientos.filter(
    (m) =>
      (!local || m.local === local) &&
      (!proveedor || (proveedor === '__sin' ? !m.proveedorId : m.proveedorId === proveedor)) &&
      (!est || m.estado === est) &&
      (!desde || (m.fecha && m.fecha >= desde)) &&
      (!hasta || (m.fecha && m.fecha <= hasta)) &&
      (!texto || `${m.referencia} ${m.proveedor} ${m.nombreLeido || ''} ${m.archivo}`.toLowerCase().includes(texto))
  );
}

// ---------- Tabla ----------

function llenarSelect(select, opciones, primera) {
  const actual = select.value;
  select.innerHTML = primera + opciones.map(([valor, texto]) => `<option value="${esc(valor)}">${esc(texto)}</option>`).join('');
  select.value = [...select.options].some((o) => o.value === actual) ? actual : '';
}

function pintarFiltros() {
  const locales = [...new Set([...estado.locales, ...estado.movimientos.map((m) => m.local)])].sort((a, b) =>
    a.localeCompare(b)
  );
  llenarSelect($('#fLocal'), locales.map((l) => [l, l]), '<option value="">Todos los locales</option>');
  llenarSelect(
    $('#fProveedor'),
    [['__sin', 'Sin asignar'], ...estado.proveedores.map((p) => [p.id, p.nombre])],
    '<option value="">Todos los proveedores</option>'
  );
}

function celda(m, campo, contenido, clase = '') {
  const conf = m.confianza?.[campo];
  const marca = m.estado === 'por_revisar' && (conf === 'dudoso' || conf === 'vacio') ? ` c-${conf}` : '';
  return `<td class="${clase}${marca}">${contenido || '<span class="falta">—</span>'}</td>`;
}

function pintarTabla() {
  const lista = filtrados();
  $('#filas').innerHTML = lista
    .map((m) => {
      const alertas = [
        m.duplicados.length && '<span class="etiqueta alerta" title="Hay otro comprobante igual">Duplicado</span>',
        !m.existe && '<span class="etiqueta alerta" title="La imagen ya no está en la carpeta">Sin archivo</span>',
        m.error && `<span class="etiqueta alerta" title="${esc(m.error)}">Error al leer</span>`,
        !m.procesado && !m.error && '<span class="etiqueta por_revisar">Leyendo…</span>',
      ]
        .filter(Boolean)
        .join('');
      const etiqueta = m.estado === 'revisado' ? 'Revisado' : 'Por revisar';
      const proveedor = m.proveedorId
        ? esc(m.proveedor)
        : `<span class="sin-asignar">Sin asignar</span>${m.nombreLeido ? ` <small class="leido">${esc(m.nombreLeido)}</small>` : ''}`;
      return `<tr data-id="${m.id}" class="${m.id === estado.seleccionado ? 'activa' : ''}">
        <td>${esc(m.local)}</td>
        ${celda(m, 'fecha', fmtFecha(m.fecha))}
        ${celda(m, 'valor', esc(fmtValor(m.valor)), 'num')}
        ${celda(m, 'referencia', esc(m.referencia))}
        ${celda(m, 'proveedor', proveedor, 'proveedor')}
        <td><span class="etiqueta ${m.estado}">${etiqueta}</span>${alertas}</td>
      </tr>`;
    })
    .join('');

  const total = lista.reduce((s, m) => s + (m.valor || 0), 0);
  const pendientes = lista.filter((m) => m.estado === 'por_revisar').length;
  $('#resumen').innerHTML = lista.length
    ? `<strong>${lista.length}</strong> movimientos · <strong>${pendientes}</strong> por revisar · Total <strong>${esc(fmtValor(total))}</strong>`
    : '';

  const vacio = $('#vacio');
  vacio.hidden = lista.length > 0;
  if (!estado.movimientos.length) {
    vacio.innerHTML = `<h2>Aún no hay comprobantes</h2>
      <p>Crea una carpeta por cada local dentro de <code>Comprobantes</code> y pon ahí las imágenes.
      Luego pulsa <strong>Procesar nuevas</strong>.</p>
      <p><button class="primario" id="abrirCarpeta2">Abrir la carpeta Comprobantes</button></p>`;
    $('#abrirCarpeta2').onclick = abrirCarpeta;
  } else {
    vacio.innerHTML = '<p>Ningún movimiento coincide con los filtros.</p>';
  }
  $('#exportar').disabled = lista.length === 0;
}

// ---------- Detalle ----------

async function seleccionar(id) {
  if (!id) return cerrarDetalle();
  estado.seleccionado = id;
  document.querySelectorAll('#filas tr').forEach((tr) => tr.classList.toggle('activa', tr.dataset.id === id));
  document.querySelector(`#filas tr[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  const detalle = await (await api(`/api/movimientos/${id}`)).json();
  if (estado.seleccionado !== id) return;
  estado.detalle = detalle;
  estado.zoom = 1;
  estado.giro = detalle.giro || 0;
  pintarDetalle();
}

function cerrarDetalle() {
  estado.seleccionado = null;
  estado.detalle = null;
  $('#detalle').hidden = true;
  document.querySelectorAll('#filas tr.activa').forEach((tr) => tr.classList.remove('activa'));
}

function pintarDetalle() {
  const m = estado.detalle;
  $('#detalle').hidden = false;
  $('#meta').innerHTML = `<strong>${esc(m.local)}</strong> · ${esc(m.archivo)}${m.banco ? ` · ${esc(m.banco)}` : ''}`;

  const img = $('#imagen');
  img.onload = acomodarImagen;
  img.src = `/api/imagen/${m.id}?v=${m.hash.slice(0, 8)}`;

  const formulario = $('#formulario');
  formulario.fecha.value = m.fecha || '';
  formulario.valor.value = m.valor == null ? '' : numero.format(m.valor);
  formulario.referencia.value = m.referencia || '';
  pintarOpcionesProveedor(m.proveedorId || '');
  const pista = [
    m.nombreLeido && `En el comprobante: “${m.nombreLeido}”`,
    m.cuentaDestino && `cuenta ${m.cuentaDestino}`,
    m.convenio && `convenio ${m.convenio}`,
    m.lector && m.lector !== 'reglas' ? 'leído con IA' : 'lectura básica (sin IA)',
  ].filter(Boolean);
  $('#pistaProveedor').textContent = pista.join(' · ');
  for (const campo of CAMPOS) {
    const label = document.querySelector(`label[data-campo="${campo}"]`);
    const conf = m.estado === 'por_revisar' ? m.confianza?.[campo] : '';
    label.classList.toggle('dudoso', conf === 'dudoso');
    label.classList.toggle('vacio', conf === 'vacio');
  }
  $('#pendiente').hidden = m.estado !== 'revisado';

  const avisos = [];
  for (const otroId of m.duplicados) {
    const otro = estado.movimientos.find((x) => x.id === otroId);
    if (otro)
      avisos.push(
        `<div class="aviso-linea">Posible duplicado: ${esc(otro.local)} · ${esc(otro.archivo)}
        <button type="button" data-ir="${otro.id}">Ver</button></div>`
      );
  }
  if (!m.existe) avisos.push('<div class="aviso-linea">La imagen ya no está en la carpeta.</div>');
  if (m.error) avisos.push(`<div class="aviso-linea">No se pudo leer la imagen: ${esc(m.error)}</div>`);
  $('#avisos').innerHTML = avisos.join('');

  const lineas = [...(m.ocr?.[0] || [])].sort((a, b) => a.y - b.y || a.x - b.x);
  $('#textoOcr').innerHTML = lineas.length
    ? lineas.map((l) => `<div>${esc(l.texto)}</div>`).join('')
    : '<em>Sin texto</em>';

  // Si la imagen trae datos dudosos o vacíos, empezar por el primero de ellos.
  const primero = CAMPOS.find((c) => ['dudoso', 'vacio'].includes(m.estado === 'por_revisar' && m.confianza?.[c]));
  (primero ? formulario[nombreDeCampo(primero)] : formulario.fecha).focus({ preventScroll: true });
}

function pintarOpcionesProveedor(valor) {
  const select = $('#formulario').proveedorId;
  select.innerHTML =
    '<option value="">— Sin asignar —</option>' +
    estado.proveedores.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)}</option>`).join('') +
    '<option value="__nuevo">+ Nuevo proveedor…</option>';
  select.value = valor;
}

// Ajusta el tamaño de la imagen al visor, con zoom y giro.
function acomodarImagen() {
  const img = $('#imagen');
  const visor = $('#visor');
  if (!img.naturalWidth) return;
  const giro = ((estado.giro % 360) + 360) % 360;
  const acostada = giro % 180 !== 0;
  const [w, h] = [img.naturalWidth, img.naturalHeight];
  const [dw, dh] = acostada ? [h, w] : [w, h];
  const escala = Math.min((visor.clientWidth - 8) / dw, (visor.clientHeight - 8) / dh) * estado.zoom;
  Object.assign($('#lienzo').style, { width: `${dw * escala}px`, height: `${dh * escala}px` });
  Object.assign(img.style, {
    width: `${w * escala}px`,
    height: `${h * escala}px`,
    transform: `translate(-50%, -50%) rotate(${giro}deg)`,
  });
  visor.classList.toggle('acercado', estado.zoom > 1);
  $('#zoomTexto').textContent = `${Math.round(estado.zoom * 100)}%`;
}

function cambiarZoom(nuevo, centroX = 0.5, centroY = 0.5) {
  const visor = $('#visor');
  estado.zoom = Math.min(6, Math.max(1, nuevo));
  acomodarImagen();
  visor.scrollLeft = visor.scrollWidth * centroX - visor.clientWidth / 2;
  visor.scrollTop = visor.scrollHeight * centroY - visor.clientHeight / 2;
}

function siguientePendiente(desdeId, lista) {
  const i = lista.findIndex((m) => m.id === desdeId);
  const orden = [...lista.slice(i + 1), ...lista.slice(0, Math.max(i, 0))];
  return orden.find((m) => m.estado === 'por_revisar' && m.id !== desdeId);
}

async function guardar(nuevoEstado) {
  const m = estado.detalle;
  const formulario = $('#formulario');
  const listaAntes = filtrados();
  const cambios = { estado: nuevoEstado };
  for (const campo of CAMPOS) cambios[nombreDeCampo(campo)] = formulario[nombreDeCampo(campo)].value;
  if (cambios.proveedorId === '__nuevo') delete cambios.proveedorId;
  // El valor solo se envía si cambió (así no se marca como corregido por cambiar el formato).
  if (cambios.valor === (m.valor == null ? '' : numero.format(m.valor))) delete cambios.valor;
  await api(`/api/movimientos/${m.id}`, { method: 'PATCH', body: JSON.stringify(cambios) });
  await cargar();
  if (nuevoEstado !== 'revisado') return seleccionar(m.id);
  const siguiente = siguientePendiente(m.id, listaAntes);
  if (siguiente) seleccionar(siguiente.id);
  else {
    cerrarDetalle();
    avisar('¡Listo! No quedan comprobantes por revisar en esta vista.');
  }
}

// ---------- Procesar y exportar ----------

async function procesar() {
  estado.accion = 'procesar';
  $('#procesar').disabled = true;
  await api('/api/procesar', { method: 'POST' });
  sondear();
}

async function releer() {
  estado.accion = 'releer';
  $('#releer').disabled = true;
  $('#procesar').disabled = true;
  await api('/api/releer', { method: 'POST' });
  sondear();
}

function textoProgreso(p) {
  if (!p.total) return 'Buscando imágenes nuevas…';
  if (p.fase !== 'ia') return `Leyendo imágenes ${p.hechos} de ${p.total}…`;
  const promedio = p.leidosIA ? p.segundosIA / p.leidosIA : 0;
  const faltan = Math.ceil(((p.total - p.hechos) * promedio) / 60);
  const eta = promedio ? ` · faltan ~${faltan} min` : '';
  return `Leyendo con IA ${p.hechos} de ${p.total}${eta} (puedes ir revisando los que ya están)`;
}

async function sondear() {
  clearTimeout(estado.sondeo);
  const datos = await cargarEstado();
  const p = datos.progreso;
  $('#progreso').hidden = !p.activo;
  if (p.activo) {
    $('#procesar').disabled = true;
    $('#releer').disabled = true;
    $('#progresoBarra').style.width = p.total ? `${(p.hechos / p.total) * 100}%` : '0';
    $('#progresoTexto').textContent = textoProgreso(p);
    await cargar();
    estado.sondeo = setTimeout(sondear, 1500);
  } else if (estado.accion) {
    const accion = estado.accion;
    estado.accion = '';
    $('#procesar').disabled = false;
    $('#releer').disabled = false;
    await cargar();
    const leidas = p.hechos - p.errores;
    const errores = p.errores ? ` (${p.errores} con error)` : '';
    if (accion === 'releer')
      avisar(`${leidas === 1 ? 'Se releyó 1 comprobante' : `Se releyeron ${leidas} comprobantes`} con IA${errores}.`);
    else avisar(p.total ? `Se leyeron ${p.total - p.errores} comprobantes nuevos${errores}.` : 'No hay imágenes nuevas.');
  }
}

// ---------- Proveedores ----------

async function recargarProveedores() {
  estado.proveedores = await json('/api/proveedores');
  pintarProveedores();
}

function chips(p, lista, etiqueta) {
  return p[lista]
    .map(
      (v, i) =>
        `<span class="chip">${etiqueta} <strong>${esc(v)}</strong><button type="button" data-quitar="${lista}" data-i="${i}" title="Quitar" aria-label="Quitar">×</button></span>`
    )
    .join('');
}

function pintarProveedores() {
  $('#listaProveedores').innerHTML =
    estado.proveedores
      .map((p) => {
        const otros = estado.proveedores
          .filter((o) => o.id !== p.id)
          .map((o) => `<option value="${esc(o.id)}">${esc(o.nombre)}</option>`)
          .join('');
        return `<div class="fila-proveedor" data-id="${esc(p.id)}">
          <div class="fila-proveedor-cabeza">
            <input class="nombre-proveedor" value="${esc(p.nombre)}" aria-label="Nombre del proveedor" />
            <span class="conteo">${p.comprobantes} comprobante${p.comprobantes === 1 ? '' : 's'}</span>
          </div>
          <div class="chips">${chips(p, 'cuentas', 'Cuenta/llave') + chips(p, 'convenios', 'Convenio') + chips(p, 'alias', 'Nombre') || '<span class="ayuda">Sin identificadores aún: asígnalo en un comprobante y aprenderá su cuenta.</span>'}</div>
          <div class="acciones-proveedor">
            <select class="unir" aria-label="Unir con otro proveedor"><option value="">Unir con…</option>${otros}</select>
            <button type="button" class="eliminar">Eliminar</button>
          </div>
        </div>`;
      })
      .join('') || '<p class="ayuda">Aún no hay proveedores.</p>';
}

async function cambiarProveedor(id, accion) {
  try {
    await accion();
  } catch {
    avisar('No se pudo guardar el cambio.');
  }
  await recargarProveedores();
  await cargar();
  if (estado.detalle) pintarOpcionesProveedor($('#formulario').proveedorId.value === '__nuevo' ? '' : $('#formulario').proveedorId.value);
}

async function exportar() {
  const ids = filtrados().map((m) => m.id);
  const res = await api('/api/exportar', { method: 'POST', body: JSON.stringify({ ids }) });
  const nombre = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition'))?.[1] || 'Movimientos.xlsx';
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(await res.blob());
  enlace.download = nombre;
  enlace.click();
  URL.revokeObjectURL(enlace.href);
  const sinRevisar = filtrados().filter((m) => m.estado === 'por_revisar').length;
  avisar(sinRevisar ? `Excel descargado (${sinRevisar} sin revisar).` : 'Excel descargado.');
}

const abrirCarpeta = () => api('/api/abrir-carpeta', { method: 'POST' });

// ---------- Eventos ----------

$('#procesar').onclick = procesar;
$('#releer').onclick = releer;
$('#exportar').onclick = exportar;
$('#abrirCarpeta').onclick = abrirCarpeta;
$('#cerrar').onclick = cerrarDetalle;
for (const id of ['#fLocal', '#fProveedor', '#fEstado', '#fDesde', '#fHasta', '#fTexto'])
  $(id).addEventListener('input', pintarTabla);

// Proveedor nuevo desde la revisión.
$('#formulario').proveedorId.addEventListener('change', async (e) => {
  if (e.target.value !== '__nuevo') return;
  const nombre = prompt('Nombre del nuevo proveedor:', estado.detalle?.nombreLeido || '');
  if (!nombre?.trim()) return pintarOpcionesProveedor(estado.detalle?.proveedorId || '');
  const nuevo = await json('/api/proveedores', { method: 'POST', body: JSON.stringify({ nombre }) });
  estado.proveedores = await json('/api/proveedores');
  pintarFiltros();
  pintarOpcionesProveedor(nuevo.id);
});

// Pantalla de proveedores.
$('#abrirProveedores').onclick = async () => {
  await recargarProveedores();
  $('#dlgProveedores').showModal();
};
$('#cerrarProveedores').onclick = () => $('#dlgProveedores').close();
$('#formNuevoProveedor').onsubmit = (e) => {
  e.preventDefault();
  const nombre = e.target.nombre.value;
  e.target.reset();
  cambiarProveedor(null, () => api('/api/proveedores', { method: 'POST', body: JSON.stringify({ nombre }) }));
};
const proveedorDe = (el) => estado.proveedores.find((p) => p.id === el.closest('.fila-proveedor')?.dataset.id);
$('#listaProveedores').addEventListener('change', (e) => {
  const p = proveedorDe(e.target);
  if (!p) return;
  if (e.target.matches('.nombre-proveedor') && e.target.value.trim())
    cambiarProveedor(p.id, () => api(`/api/proveedores/${p.id}`, { method: 'PATCH', body: JSON.stringify({ nombre: e.target.value }) }));
  if (e.target.matches('.unir') && e.target.value) {
    const destino = estado.proveedores.find((o) => o.id === e.target.value);
    if (!confirm(`¿Unir “${p.nombre}” con “${destino.nombre}”? Sus comprobantes, cuentas y convenios pasan a “${destino.nombre}”.`))
      return (e.target.value = '');
    cambiarProveedor(p.id, () => api(`/api/proveedores/${p.id}/unir`, { method: 'POST', body: JSON.stringify({ destino: destino.id }) }));
  }
});
$('#listaProveedores').addEventListener('click', (e) => {
  const p = proveedorDe(e.target);
  if (!p) return;
  const quitar = e.target.closest('[data-quitar]');
  if (quitar) {
    const lista = quitar.dataset.quitar;
    const valores = p[lista].filter((_, i) => i !== Number(quitar.dataset.i));
    cambiarProveedor(p.id, () => api(`/api/proveedores/${p.id}`, { method: 'PATCH', body: JSON.stringify({ [lista]: valores }) }));
  }
  if (e.target.matches('.eliminar')) {
    const aviso = p.comprobantes ? ` Sus ${p.comprobantes} comprobantes quedarán “Sin asignar”.` : '';
    if (confirm(`¿Eliminar “${p.nombre}”?${aviso}`))
      cambiarProveedor(p.id, () => api(`/api/proveedores/${p.id}`, { method: 'DELETE' }));
  }
});

$('#filas').onclick = (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) seleccionar(tr.dataset.id);
};
$('#avisos').onclick = (e) => {
  const boton = e.target.closest('[data-ir]');
  if (boton) seleccionar(boton.dataset.ir);
};

$('#formulario').onsubmit = (e) => {
  e.preventDefault();
  guardar('revisado');
};
$('#pendiente').onclick = () => guardar('por_revisar');
$('#formulario').addEventListener('focusin', (e) => {
  if (CAMPOS.includes(e.target.name)) estado.ultimoCampo = e.target.name;
});

// Clic en una línea del texto leído: copiarla al último campo usado.
$('#textoOcr').onclick = (e) => {
  const linea = e.target.closest('#textoOcr div');
  if (!linea || !estado.ultimoCampo) return;
  const input = $('#formulario')[estado.ultimoCampo];
  let texto = linea.textContent.trim();
  if (estado.ultimoCampo === 'fecha') {
    const f = texto.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
    if (!f) return avisar('Esa línea no tiene una fecha dd/mm/aaaa.');
    texto = `${f[3]}-${f[2].padStart(2, '0')}-${f[1].padStart(2, '0')}`;
  }
  if (estado.ultimoCampo === 'valor') texto = (texto.match(/\d[\d.,]*/) || [''])[0];
  input.value = texto;
  input.focus();
};

$('#imagen').onclick = (e) => {
  const caja = $('#imagen').getBoundingClientRect();
  const x = (e.clientX - caja.left) / caja.width;
  const y = (e.clientY - caja.top) / caja.height;
  cambiarZoom(estado.zoom > 1 ? 1 : 2.5, x, y);
};
$('#visor').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return; // pellizco en el trackpad
    e.preventDefault();
    cambiarZoom(estado.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  },
  { passive: false }
);
document.querySelectorAll('[data-zoom]').forEach((b) => {
  b.onclick = () => cambiarZoom(estado.zoom + Number(b.dataset.zoom) * 0.5);
});
$('#girar').onclick = () => {
  estado.giro += 90;
  acomodarImagen();
};
$('#ajustar').onclick = () => cambiarZoom(1);
window.addEventListener('resize', acomodarImagen);

document.addEventListener('keydown', (e) => {
  const enCampo = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
  if (e.key === 'Escape') {
    if (enCampo) e.target.blur();
    else cerrarDetalle();
    return;
  }
  if (enCampo || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const lista = filtrados();
  const i = lista.findIndex((m) => m.id === estado.seleccionado);
  const otro = lista[e.key === 'ArrowDown' ? i + 1 : Math.max(i - 1, 0)] || lista[0];
  if (otro) seleccionar(otro.id);
});

// Revisa cada pocos segundos si llegaron imágenes nuevas a las carpetas.
setInterval(() => {
  if (!document.hidden && !$('#procesar').disabled) cargarEstado();
}, 5000);

await cargarEstado();
await cargar();
sondear();
