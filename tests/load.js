// Carga un fichero REAL de la extensión dentro de un contexto aislado, con los
// stubs del navegador inyectados como globales. Nada de reimplementar la
// lógica en el test: se ejecuta el mismo código que se instala en Chrome.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const RAIZ = path.join(__dirname, "..");

function cargar(fichero, globales = {}) {
  const contexto = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
    Promise, JSON, Math, Object, Array, String, Number, Boolean, Error, Date,
    Float32Array, Uint8Array, ArrayBuffer, Set, Map, RegExp, isNaN, parseInt, parseFloat,
    URL, TextEncoder, TextDecoder, encodeURIComponent, decodeURIComponent,
    ...globales,
  };
  contexto.globalThis = contexto;
  contexto.self = contexto;

  // El service worker carga sus dependencias con importScripts: se evalúan en
  // ESTE mismo contexto, igual que hace Chrome.
  contexto.importScripts = (...ficheros) => {
    for (const f of ficheros) {
      vm.runInContext(fs.readFileSync(path.join(RAIZ, f), "utf8"), contexto, { filename: f });
    }
  };

  const ctx = vm.createContext(contexto);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, fichero), "utf8"), ctx, { filename: fichero });
  return contexto;
}

// Envuelve el listener de mensajes en algo que se pueda esperar con await.
function mensajero(chrome) {
  return (msg) => new Promise((resolve, reject) => {
    const oyentes = chrome._oyentes.mensaje;
    if (!oyentes.length) return reject(new Error("nadie registró onMessage"));
    let respondido = false;
    for (const oyente of oyentes) {
      const asincrono = oyente(msg, {}, (r) => { respondido = true; resolve(r); });
      if (asincrono === true) return; // responderá luego
    }
    if (!respondido) resolve(undefined);
  });
}

module.exports = { cargar, mensajero, RAIZ };
