/**
 * Service worker de Fut Starzz. Es lo que convierte la web en una app instalable que anda sin
 * internet.
 *
 * ---------------------------------------------------------------------------------------------
 * POR QUE ESTA ESTRATEGIA Y NO OTRA
 * ---------------------------------------------------------------------------------------------
 *
 * El juego corre ENTERO en el cliente: no hay servidor propio, las partidas van a localStorage y lo
 * unico externo son los GIFs del feed, que ya fallan en silencio sin conexion. Osea que para andar
 * offline alcanza con tener guardados los archivos del build.
 *
 * Se usan DOS politicas distintas, y la diferencia importa:
 *
 *   . /assets/* -> CACHE PRIMERO. Vite le pone un hash al nombre segun el contenido, asi que un
 *     archivo con ese nombre nunca cambia: si esta guardado, sirve. Cambio de contenido = nombre
 *     nuevo = descarga nueva. Cachearlos para siempre es correcto por construccion.
 *
 *   . index.html -> RED PRIMERO, cache como respaldo. Ese SI cambia en cada build y es el que dice
 *     que archivos con hash cargar. Servirlo desde cache sin preguntar es exactamente como se llega
 *     a la pantalla en blanco: el html viejo pide un JS que ya no existe. Es el mismo problema que
 *     documentan netlify.toml y public/_headers, resuelto acá para el caso offline.
 *
 * VERSION: al subirla, el `activate` borra los caches viejos. Hay que subirla en cada deploy que
 * cambie algo, o el service worker seguiria sirviendo el build anterior para siempre.
 */
const VERSION = 'futstarzz-v2';
const CACHE_ESTATICO = `${VERSION}-estatico`;

/**
 * LOS ESCUDOS VIVEN EN SU PROPIO DEPÓSITO, y ese NO se borra al cambiar de VERSION.
 *
 * Pedido: *"hay manera de descargar los escudos para que cuando se juegue offline sigan
 * apareciendo?"*. Son 1.090 archivos (unos 26 MB): bajarlos otra vez en cada deploy sería gastarle
 * los datos al jugador por nada, porque casi nunca cambian. Cuando uno cambia, lo dice su huella en
 * badges/lista.json (ver listaDeEscudos en vite.config.ts) y se baja sólo ese.
 */
const CACHE_ESCUDOS = 'futstarzz-escudos';
const LISTA_DE_ESCUDOS = 'badges/lista.json';
const esEscudo = url => url.pathname.includes('/badges/') && !url.pathname.endsWith('.json');

// Al instalar no se precachea nada mas que el arranque: el build son 34 MB (casi todo escudos y
// fotos de la tienda) y bajarlos de golpe en la instalacion haria que la app tarde un minuto en
// quedar lista. Se van guardando a medida que se usan, que para un juego de un solo jugador es
// suficiente: despues del primer partido ya esta todo lo que hace falta.
self.addEventListener('install', evento => {
  self.skipWaiting();
  evento.waitUntil(caches.open(CACHE_ESTATICO));
});

self.addEventListener('activate', evento => {
  evento.waitUntil((async () => {
    const nombres = await caches.keys();
    // Todo lo de versiones viejas se borra... menos los escudos, que no dependen de la versión.
    await Promise.all(nombres
      .filter(n => !n.startsWith(VERSION) && n !== CACHE_ESCUDOS)
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', evento => {
  const pedido = evento.request;
  if (pedido.method !== 'GET') return;

  const url = new URL(pedido.url);
  // Solo lo de este mismo origen. Los GIFs de Giphy y cualquier otra cosa de afuera pasan derecho:
  // guardarlos no aporta y ensuciaria el cache con respuestas que ni siquiera controlamos.
  if (url.origin !== self.location.origin) return;

  const esDocumento = pedido.mode === 'navigate' || url.pathname.endsWith('.html');

  if (esDocumento) {
    // RED PRIMERO. Si no hay conexion, se sirve la ultima copia buena.
    evento.respondWith((async () => {
      try {
        const respuesta = await fetch(pedido);
        const cache = await caches.open(CACHE_ESTATICO);
        cache.put(pedido, respuesta.clone());
        return respuesta;
      } catch {
        const guardada = await caches.match(pedido);
        return guardada ?? caches.match('index.html') ?? Response.error();
      }
    })());
    return;
  }

  // CACHE PRIMERO para todo lo demas (JS, CSS, imagenes, sonidos).
  evento.respondWith((async () => {
    const guardada = await caches.match(pedido);
    if (guardada) return guardada;
    try {
      const respuesta = await fetch(pedido);
      // Solo se guardan las respuestas completas y validas: una 206 (rango parcial, tipica de los
      // audios) no se puede reusar despues y romperia la reproduccion offline.
      if (respuesta.ok && respuesta.status === 200) {
        // Un escudo va a su depósito propio, que sobrevive a los deploys.
        const cache = await caches.open(esEscudo(url) ? CACHE_ESCUDOS : CACHE_ESTATICO);
        cache.put(pedido, respuesta.clone());
      }
      return respuesta;
    } catch {
      return Response.error();
    }
  })());
});

/**
 * GUARDAR TODOS LOS ESCUDOS, en segundo plano. Lo pide la página un rato después de cargar (ver
 * index.html) y sólo si hay conexión.
 *
 * - Lee la lista nueva y la compara con la que guardó la vez anterior: un escudo cuya huella cambió
 *   se borra y se vuelve a bajar; uno que ya está, no se toca.
 * - Baja de a pocos a la vez, para no competir con el juego por la conexión.
 * - Si el teléfono corta a mitad de camino (iOS duerme el service worker cuando quiere), la próxima
 *   vez sigue desde donde quedó: lo ya guardado cuenta.
 * - La lista se guarda AL FINAL: si se cortó, la próxima vez vuelve a comparar contra la anterior y
 *   no se saltea ningún escudo cambiado.
 */
async function guardarEscudos() {
  const cache = await caches.open(CACHE_ESCUDOS);
  let respuesta;
  try {
    respuesta = await fetch(LISTA_DE_ESCUDOS, { cache: 'no-store' });
  } catch {
    return { guardados: 0, bajados: 0 };   // sin conexión: se intenta la próxima vez
  }
  if (!respuesta.ok) return { guardados: 0, bajados: 0 };
  const lista = await respuesta.clone().json();
  const nueva = new Map(lista.archivos);

  const anteriorGuardada = await cache.match(LISTA_DE_ESCUDOS);
  const anterior = anteriorGuardada ? new Map((await anteriorGuardada.json()).archivos) : new Map();

  // Los que cambiaron de contenido, afuera: se vuelven a bajar abajo.
  for (const [ruta, huella] of nueva) {
    if (anterior.has(ruta) && anterior.get(ruta) !== huella) await cache.delete(ruta);
  }

  const faltan = [];
  for (const ruta of nueva.keys()) {
    if (!(await cache.match(ruta))) faltan.push(ruta);
  }

  let bajados = 0;
  const DE_A = 4;
  for (let i = 0; i < faltan.length; i += DE_A) {
    await Promise.all(faltan.slice(i, i + DE_A).map(async ruta => {
      try {
        const r = await fetch(ruta);
        if (r.ok && r.status === 200) { await cache.put(ruta, r); bajados++; }
      } catch { /* sin conexión a mitad de camino: queda para la próxima */ }
    }));
  }

  await cache.put(LISTA_DE_ESCUDOS, respuesta);
  return { guardados: nueva.size - faltan.length + bajados, bajados };
}

self.addEventListener('message', evento => {
  if (evento.data?.tipo !== 'guardar-escudos') return;
  // waitUntil mantiene vivo al service worker mientras baja: sin esto el navegador lo puede dormir
  // en cuanto termina de atender el mensaje.
  evento.waitUntil(guardarEscudos().then(resultado => {
    evento.source?.postMessage?.({ tipo: 'escudos-guardados', ...resultado });
  }));
});
