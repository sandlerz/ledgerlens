// Lee el texto de una imagen con Apple Vision (gratis, local, sin internet).
// Uso: ocr <ruta-imagen>
// Imprime un JSON con dos "pasadas" de lectura (imagen original y otra a distinta escala;
// si no coinciden, el campo se marca para revisar), el giro detectado y cada línea con
// su confianza y posición (coordenadas 0–1, origen arriba a la izquierda, ya enderezadas).

import CoreGraphics
import Foundation
import ImageIO
import Vision

struct Linea: Codable {
    let texto: String
    let confianza: Float
    let x: Double
    let y: Double
    let ancho: Double
    let alto: Double
}

struct Resultado: Codable {
    let ancho: Int
    let alto: Int
    let giro: Int // grados (sentido horario) para mostrar la imagen derecha
    let pasadas: [[Linea]]
}

func fallar(_ mensaje: String) -> Never {
    FileHandle.standardError.write((mensaje + "\n").data(using: .utf8)!)
    exit(1)
}

struct Lectura {
    let lineas: [Linea]
    let dx: Double // dirección promedio de lectura (primera → última letra), en píxeles
    let dy: Double
    // El texto corre de izquierda a derecha: la imagen está derecha.
    var derecha: Bool { dx > 0 && abs(dx) > abs(dy) }
}

func reconocer(_ imagen: CGImage, _ orientacion: CGImagePropertyOrientation) -> Lectura {
    let pedido = VNRecognizeTextRequest()
    pedido.recognitionLevel = .accurate
    pedido.recognitionLanguages = ["es-ES", "en-US"]
    // Sin corrección de idioma: así no "corrige" referencias como M1234567.
    pedido.usesLanguageCorrection = false
    do {
        try VNImageRequestHandler(cgImage: imagen, orientation: orientacion, options: [:]).perform([pedido])
    } catch {
        fallar("Error de OCR: \(error.localizedDescription)")
    }
    let (w, h) = girada(orientacion) ? (Double(imagen.height), Double(imagen.width)) : (Double(imagen.width), Double(imagen.height))
    var dx = 0.0, dy = 0.0
    let lineas: [Linea] = (pedido.results ?? []).compactMap { observacion in
        guard let candidato = observacion.topCandidates(1).first else { return nil }
        let texto = candidato.string
        if texto.count >= 4,
           let a = try? candidato.boundingBox(for: texto.startIndex..<texto.index(after: texto.startIndex)),
           let b = try? candidato.boundingBox(for: texto.index(before: texto.endIndex)..<texto.endIndex) {
            let vx = (b.boundingBox.midX - a.boundingBox.midX) * w
            let vy = (b.boundingBox.midY - a.boundingBox.midY) * h
            let largo = max((vx * vx + vy * vy).squareRoot(), 1)
            dx += vx / largo
            dy += vy / largo
        }
        let caja = observacion.boundingBox
        return Linea(texto: texto, confianza: candidato.confidence,
                     x: caja.minX, y: 1 - caja.maxY, ancho: caja.width, alto: caja.height)
    }
    return Lectura(lineas: lineas, dx: dx, dy: dy)
}

func escalar(_ imagen: CGImage, _ factor: Double) -> CGImage {
    let ancho = Int(Double(imagen.width) * factor)
    let alto = Int(Double(imagen.height) * factor)
    guard let contexto = CGContext(data: nil, width: ancho, height: alto, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return imagen }
    contexto.interpolationQuality = .high
    contexto.setFillColor(CGColor(gray: 1, alpha: 1))
    contexto.fill(CGRect(x: 0, y: 0, width: ancho, height: alto))
    contexto.draw(imagen, in: CGRect(x: 0, y: 0, width: ancho, height: alto))
    return contexto.makeImage() ?? imagen
}

func girada(_ o: CGImagePropertyOrientation) -> Bool {
    [.left, .right, .leftMirrored, .rightMirrored].contains(o)
}


guard CommandLine.arguments.count == 2 else { fallar("Uso: ocr <ruta-imagen>") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])

guard let fuente = CGImageSourceCreateWithURL(url as CFURL, nil),
      let imagen = CGImageSourceCreateImageAtIndex(fuente, 0, nil)
else { fallar("No se pudo abrir la imagen") }

// Respeta la rotación guardada por la cámara (fotos de celular).
let propiedades = CGImageSourceCopyPropertiesAtIndex(fuente, 0, nil) as? [CFString: Any]
let orientacionExif = (propiedades?[kCGImagePropertyOrientation] as? UInt32)
    .flatMap { CGImagePropertyOrientation(rawValue: $0) } ?? .up

var orientacion = orientacionExif
var giro = 0
var primera = reconocer(imagen, orientacion)

// Foto acostada o de cabeza (sin datos de rotación): se prueba girándola hasta que
// el texto corra de izquierda a derecha. Vision a veces lee texto girado, pero las
// posiciones quedan giradas y eso confunde qué valor va con qué etiqueta.
if orientacionExif == .up && !primera.lineas.isEmpty && !primera.derecha {
    let intentos: [(CGImagePropertyOrientation, Int)] =
        abs(primera.dy) > abs(primera.dx) ? [(.right, 90), (.left, 270)] : [(.down, 180)]
    for (o, grados) in intentos {
        let lectura = reconocer(imagen, o)
        if lectura.derecha {
            primera = lectura
            orientacion = o
            giro = grados
            break
        }
    }
}

// Segunda lectura a otra escala: imágenes pequeñas se amplían, las muy grandes se reducen.
let ladoMayor = max(imagen.width, imagen.height)
let segunda = reconocer(escalar(imagen, ladoMayor < 1500 ? 2 : 0.5), orientacion)

let resultado = Resultado(
    ancho: girada(orientacion) ? imagen.height : imagen.width,
    alto: girada(orientacion) ? imagen.width : imagen.height,
    giro: giro,
    pasadas: [primera.lineas, segunda.lineas]
)
FileHandle.standardOutput.write(try! JSONEncoder().encode(resultado))
