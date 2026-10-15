import fs from 'node:fs';
import path from 'node:path';

// Guarda los movimientos en un archivo JSON. Escribe a un archivo temporal y lo renombra,
// así un cierre inesperado nunca deja el archivo a medias.
export class Almacen {
  constructor(archivo) {
    this.archivo = archivo;
    this.temporizador = null;
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    if (fs.existsSync(archivo)) {
      this.movimientos = JSON.parse(fs.readFileSync(archivo, 'utf8')).movimientos ?? [];
      // Copia de seguridad de cómo estaba todo al abrir la app.
      fs.copyFileSync(archivo, archivo.replace(/\.json$/, '.respaldo.json'));
    } else {
      this.movimientos = [];
    }
  }

  buscar(id) {
    return this.movimientos.find((m) => m.id === id);
  }

  // Agrupa varias escrituras seguidas en una sola.
  guardar() {
    clearTimeout(this.temporizador);
    this.temporizador = setTimeout(() => this.guardarYa(), 300);
  }

  guardarYa() {
    clearTimeout(this.temporizador);
    const temporal = `${this.archivo}.tmp`;
    fs.writeFileSync(temporal, JSON.stringify({ version: 1, movimientos: this.movimientos }));
    fs.renameSync(temporal, this.archivo);
  }
}
