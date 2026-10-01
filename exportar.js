// Escriba — exportar una transcripción o un acta a otros formatos, sin
// librerías: Word (.docx), subtítulos (.srt), texto plano y HTML para ver o
// pegar en un correo. Lo cargan la biblioteca y los tests; depende de comun.js
// (lineasTranscripcion, formatoTiempo).
//
// Un .docx es un zip con unos pocos XML. Se genera sin comprimir (método
// «store»): Word lo abre igual y así no hace falta ningún compresor.

// t() y LOCALE_UI() los define i18n.js, que la biblioteca carga antes. En Node
// (tests) se traen con require.
if (typeof t !== "function" && typeof require === "function") var { t, LOCALE_UI } = require("./i18n.js");

// --- zip ---------------------------------------------------------------------------
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const aBytes = (x) => (typeof x === "string" ? new TextEncoder().encode(x) : x);

// ficheros: [{ nombre, datos (string o Uint8Array) }] → Uint8Array del .zip
function zip(ficheros) {
  const partes = [], central = [];
  let desplazamiento = 0;
  // Fecha fija (1/1/2026 00:00 en formato DOS): el contenido no depende de la hora.
  const hora = 0, dia = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of ficheros) {
    const nombre = aBytes(f.nombre), datos = aBytes(f.datos), crc = crc32(datos);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // versión necesaria
    local.setUint16(6, 0x0800, true);      // nombres en UTF-8
    local.setUint16(8, 0, true);           // sin comprimir
    local.setUint16(10, hora, true);
    local.setUint16(12, dia, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, datos.length, true);
    local.setUint32(22, datos.length, true);
    local.setUint16(26, nombre.length, true);
    local.setUint16(28, 0, true);
    partes.push(new Uint8Array(local.buffer), nombre, datos);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, hora, true);
    c.setUint16(14, dia, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, datos.length, true);
    c.setUint32(24, datos.length, true);
    c.setUint16(28, nombre.length, true);
    c.setUint32(42, desplazamiento, true);
    central.push(new Uint8Array(c.buffer), nombre);
    desplazamiento += 30 + nombre.length + datos.length;
  }
  const tamCentral = central.reduce((a, p) => a + p.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true);
  fin.setUint16(8, ficheros.length, true);
  fin.setUint16(10, ficheros.length, true);
  fin.setUint32(12, tamCentral, true);
  fin.setUint32(16, desplazamiento, true);
  const todo = [...partes, ...central, new Uint8Array(fin.buffer)];
  const salida = new Uint8Array(todo.reduce((a, p) => a + p.length, 0));
  let p = 0;
  for (const parte of todo) { salida.set(parte, p); p += parte.length; }
  return salida;
}

// --- markdown → bloques ----------------------------------------------------------
// Solo lo que producen Escriba y las actas: títulos, listas, citas, tablas,
// negrita y cursiva. Cada bloque: { tipo, texto } (o { tipo: "tabla", filas }).
function bloquesMd(md) {
  const bloques = [];
  const lineas = String(md || "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];
    if (!l.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(l)) continue;
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const filas = [];
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) {
        const celdas = lineas[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!celdas.every((c) => /^:?-{2,}:?$/.test(c))) filas.push(celdas);
        i++;
      }
      i--;
      bloques.push({ tipo: "tabla", filas });
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) bloques.push({ tipo: "h" + Math.min(3, m[1].length), texto: m[2] });
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) bloques.push({ tipo: "li", texto: m[1] });
    else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(l))) bloques.push({ tipo: "ol", texto: m[2], n: +m[1] });
    else if ((m = /^\s*>\s?(.*)$/.exec(l))) bloques.push({ tipo: "cita", texto: m[1] });
    else bloques.push({ tipo: "p", texto: l });
  }
  return bloques;
}

// Trozos de una línea con su formato: [{ texto, b, i }]
function trozosEnLinea(texto) {
  const trozos = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let ult = 0, m;
  while ((m = re.exec(texto))) {
    if (m.index > ult) trozos.push({ texto: texto.slice(ult, m.index) });
    const s = m[0];
    if (s.startsWith("**") || s.startsWith("__")) trozos.push({ texto: s.slice(2, -2), b: true });
    else trozos.push({ texto: s.slice(1, -1), i: true });
    ult = m.index + s.length;
  }
  if (ult < texto.length) trozos.push({ texto: texto.slice(ult) });
  return trozos.map((t) => ({ ...t, texto: t.texto.replace(/`/g, "") }));
}

// --- Word ---------------------------------------------------------------------------
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function runsXml(texto) {
  return trozosEnLinea(texto).map((t) =>
    `<w:r>${t.b || t.i ? `<w:rPr>${t.b ? "<w:b/>" : ""}${t.i ? "<w:i/>" : ""}</w:rPr>` : ""}<w:t xml:space="preserve">${escXml(t.texto)}</w:t></w:r>`).join("");
}
const parrafoXml = (estilo, texto) => `<w:p>${estilo ? `<w:pPr><w:pStyle w:val="${estilo}"/></w:pPr>` : ""}${runsXml(texto)}</w:p>`;

function tablaXml(filas) {
  const borde = '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>';
  const cuerpo = filas.map((f, n) => `<w:tr>${f.map((c) =>
    `<w:tc><w:p>${n === 0 ? runsXml("**" + c.replace(/\*\*/g, "") + "**") : runsXml(c)}</w:p></w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borde}</w:tblBorders></w:tblPr>${cuerpo}</w:tbl><w:p/>`;
}

const ESTILOS_DOCX = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="es-ES"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="5D2A42"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="5D2A42"/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="5D2A42"/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="357" w:hanging="357"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="6D5F66"/></w:rPr></w:style>
</w:styles>`;

// titulo: texto; md: cuerpo en markdown → Uint8Array del .docx
function docx(titulo, md) {
  const cuerpo = [parrafoXml("Title", titulo || t("com.reunion"))];
  for (const b of bloquesMd(md)) {
    if (b.tipo === "tabla") cuerpo.push(tablaXml(b.filas));
    else if (b.tipo === "h1") cuerpo.push(parrafoXml("Heading1", b.texto));
    else if (b.tipo === "h2") cuerpo.push(parrafoXml("Heading2", b.texto));
    else if (b.tipo === "h3") cuerpo.push(parrafoXml("Heading3", b.texto));
    else if (b.tipo === "li") cuerpo.push(parrafoXml("ListBullet", "• " + b.texto));
    else if (b.tipo === "ol") cuerpo.push(parrafoXml("ListBullet", b.n + ". " + b.texto));
    else if (b.tipo === "cita") cuerpo.push(parrafoXml("Quote", b.texto));
    else cuerpo.push(parrafoXml("", b.texto));
  }
  const documento = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${cuerpo.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    { nombre: "[Content_Types].xml", datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { nombre: "_rels/.rels", datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { nombre: "word/_rels/document.xml.rels", datos: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { nombre: "word/document.xml", datos: documento },
    { nombre: "word/styles.xml", datos: ESTILOS_DOCX },
  ]);
}

// --- subtítulos ----------------------------------------------------------------------
// Una entrada por intervención con marca de tiempo; las líneas sin marca se
// pegan a la anterior. Cada una dura hasta la siguiente (la última, 6 s).
function srt(texto) {
  const entradas = [];
  for (const l of lineasTranscripcion(texto)) {
    if (l.t !== null) entradas.push({ t: l.t, texto: (l.hablante ? l.hablante + ": " : "") + l.texto });
    else if (entradas.length) entradas[entradas.length - 1].texto += " " + l.texto;
  }
  if (!entradas.length) return "";
  const hms = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), seg = Math.floor(s % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(seg).padStart(2, "0")},000`;
  };
  return entradas.map((e, i) => {
    const fin = i + 1 < entradas.length ? Math.max(entradas[i + 1].t, e.t + 1) : e.t + 6;
    return `${i + 1}\n${hms(e.t)} --> ${hms(fin)}\n${e.texto}\n`;
  }).join("\n");
}

// --- texto plano y HTML -------------------------------------------------------------
function textoPlano(md) {
  return bloquesMd(md).map((b) => {
    if (b.tipo === "tabla") return b.filas.map((f) => f.join("\t")).join("\n");
    const t = trozosEnLinea(b.texto).map((x) => x.texto).join("");
    if (b.tipo === "li") return "• " + t;
    if (b.tipo === "ol") return b.n + ". " + t;
    return t;
  }).join("\n");
}

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lineaHtml = (texto) => trozosEnLinea(texto).map((t) =>
  t.b ? `<b>${escHtml(t.texto)}</b>` : t.i ? `<i>${escHtml(t.texto)}</i>` : escHtml(t.texto)).join("");

// Todo el texto pasa por escHtml: lo que venga del modelo nunca se ejecuta.
function mdAHtml(md) {
  const out = [];
  let lista = null;
  const cierraLista = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
  for (const b of bloquesMd(md)) {
    if (b.tipo === "li" || b.tipo === "ol") {
      const tag = b.tipo === "li" ? "ul" : "ol";
      if (lista !== tag) { cierraLista(); out.push(`<${tag}>`); lista = tag; }
      out.push(`<li>${lineaHtml(b.texto)}</li>`);
      continue;
    }
    cierraLista();
    if (b.tipo === "tabla") {
      const [cab, ...resto] = b.filas;
      out.push("<table>" + (cab ? `<tr>${cab.map((c) => `<th>${lineaHtml(c)}</th>`).join("")}</tr>` : "") +
        resto.map((f) => `<tr>${f.map((c) => `<td>${lineaHtml(c)}</td>`).join("")}</tr>`).join("") + "</table>");
    } else if (/^h\d$/.test(b.tipo)) out.push(`<${b.tipo}>${lineaHtml(b.texto)}</${b.tipo}>`);
    else if (b.tipo === "cita") out.push(`<blockquote>${lineaHtml(b.texto)}</blockquote>`);
    else out.push(`<p>${lineaHtml(b.texto)}</p>`);
  }
  cierraLista();
  return out.join("\n");
}

if (typeof module !== "undefined" && module.exports) {
  // En Node (tests) las funciones de comun.js no son globales: se traen.
  if (typeof lineasTranscripcion === "undefined") global.lineasTranscripcion = require("./comun.js").lineasTranscripcion;
  module.exports = { crc32, zip, docx, srt, textoPlano, mdAHtml, bloquesMd };
}
