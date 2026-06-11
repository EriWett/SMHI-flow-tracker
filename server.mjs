import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATIC_ROOT = path.join(__dirname, "public");

const PORT = Number(process.env.PORT || 4175);
const HYDRONU_BASE = "https://vattenwebb.smhi.se/hydronu";
const HYDROOBS_BASE = "https://opendata-download-hydroobs.smhi.se/api/version/1.0";
const FAVORITES_FILE = path.join(__dirname, "flow-favorites.json");

const stationCache = {
  loadedAt: 0,
  stations: []
};

const CACHE_TTL_MS = 1000 * 60 * 60;

function send(res, status, payload, headers = {}) {
  const body = payload === null ? "" : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(text);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "smhi-flow-tracker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`SMHI request failed (${response.status})`);
  }

  return response.json();
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readFavorites() {
  try {
    const raw = await fs.readFile(FAVORITES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeFavorites([]);
      return [];
    }
    throw error;
  }
}

async function writeFavorites(favorites) {
  await fs.writeFile(FAVORITES_FILE, `${JSON.stringify(favorites, null, 2)}\n`, "utf8");
}

function cleanSubid(value) {
  const subid = String(value || "").trim();
  if (!/^\d+$/.test(subid)) {
    throw new Error("Station id must be an integer");
  }
  return subid;
}

function normalizeSeries(data) {
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => ({
      time: Number(entry[0]),
      value: Number(entry[1])
    }))
    .filter((entry) => Number.isFinite(entry.time) && Number.isFinite(entry.value));
}

function last(array) {
  return array.length ? array[array.length - 1] : null;
}

function sweref99tmToWgs84(easting, northing) {
  const axis = 6378137.0;
  const flattening = 1.0 / 298.257222101;
  const centralMeridian = 15.0 * Math.PI / 180.0;
  const scale = 0.9996;
  const falseNorthing = 0.0;
  const falseEasting = 500000.0;

  const e2 = flattening * (2.0 - flattening);
  const ePrime2 = e2 / (1.0 - e2);
  const x = easting - falseEasting;
  const y = northing - falseNorthing;
  const m = y / scale;
  const mu = m / (axis * (1.0 - e2 / 4.0 - 3.0 * e2 * e2 / 64.0 - 5.0 * e2 * e2 * e2 / 256.0));
  const e1 = (1.0 - Math.sqrt(1.0 - e2)) / (1.0 + Math.sqrt(1.0 - e2));

  const phi1 =
    mu
    + (3.0 * e1 / 2.0 - 27.0 * e1 ** 3 / 32.0) * Math.sin(2.0 * mu)
    + (21.0 * e1 ** 2 / 16.0 - 55.0 * e1 ** 4 / 32.0) * Math.sin(4.0 * mu)
    + (151.0 * e1 ** 3 / 96.0) * Math.sin(6.0 * mu)
    + (1097.0 * e1 ** 4 / 512.0) * Math.sin(8.0 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const n1 = axis / Math.sqrt(1.0 - e2 * sinPhi1 * sinPhi1);
  const t1 = tanPhi1 * tanPhi1;
  const c1 = ePrime2 * cosPhi1 * cosPhi1;
  const r1 = axis * (1.0 - e2) / Math.pow(1.0 - e2 * sinPhi1 * sinPhi1, 1.5);
  const d = x / (n1 * scale);

  const lat =
    phi1
    - (n1 * tanPhi1 / r1)
      * (
        d * d / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 * c1 - 9.0 * ePrime2) * d ** 4 / 24.0
        + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 * t1 - 252.0 * ePrime2 - 3.0 * c1 * c1) * d ** 6 / 720.0
      );

  const lon =
    centralMeridian
    + (
      d
      - (1.0 + 2.0 * t1 + c1) * d ** 3 / 6.0
      + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 * c1 + 8.0 * ePrime2 + 24.0 * t1 * t1) * d ** 5 / 120.0
    ) / cosPhi1;

  return {
    latitude: lat * 180.0 / Math.PI,
    longitude: lon * 180.0 / Math.PI
  };
}

function haversineKm(a, b) {
  const radius = 6371;
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

async function getObservedStations() {
  const now = Date.now();
  if (stationCache.stations.length && now - stationCache.loadedAt < CACHE_TTL_MS) {
    return stationCache.stations;
  }

  const payload = await fetchJson(`${HYDROOBS_BASE}/parameter/2.json`);
  stationCache.stations = (payload.station || [])
    .filter((station) => station.active && Number.isFinite(station.latitude) && Number.isFinite(station.longitude))
    .map((station) => ({
      key: String(station.key || station.id),
      id: station.id,
      name: station.name,
      owner: station.owner,
      latitude: station.latitude,
      longitude: station.longitude,
      catchmentName: station.catchmentName,
      catchmentNumber: station.catchmentNumber
    }));
  stationCache.loadedAt = now;
  return stationCache.stations;
}

async function findNearestObservedStation(position) {
  const stations = await getObservedStations();
  let best = null;
  let bestDistance = Infinity;

  for (const station of stations) {
    const distance = haversineKm(position, station);
    if (distance < bestDistance) {
      best = station;
      bestDistance = distance;
    }
  }

  if (!best) {
    return null;
  }

  return {
    ...best,
    distanceKm: bestDistance
  };
}

async function fetchLatestObserved(stationKey) {
  const attempts = [
    `${HYDROOBS_BASE}/parameter/2/station/${encodeURIComponent(stationKey)}/period/latest-hour/data.json`,
    `${HYDROOBS_BASE}/parameter/1/station/${encodeURIComponent(stationKey)}/period/latest-day/data.json`
  ];

  for (const url of attempts) {
    try {
      const payload = await fetchJson(url);
      const values = (payload.value || [])
        .map((entry) => ({
          time: Number(entry.date),
          value: Number(entry.value),
          quality: entry.quality || ""
        }))
        .filter((entry) => Number.isFinite(entry.time) && Number.isFinite(entry.value));

      return {
        parameter: payload.parameter || null,
        updated: payload.updated || null,
        values,
        latest: last(values)
      };
    } catch (error) {
      // Try the next period/parameter.
    }
  }

  return {
    parameter: null,
    updated: null,
    values: [],
    latest: null
  };
}

async function getStationPayload(subid) {
  const hydronu = await fetchJson(`${HYDRONU_BASE}/data/point?subid=${encodeURIComponent(subid)}`);
  const chart = hydronu.chartData || {};
  const stationId = String(hydronu.nearestDownstreamStation || hydronu.poi || subid);
  const hydroStation = hydronu.stations && (hydronu.stations[stationId] || hydronu.stations[subid]);
  const sweref = hydroStation && Array.isArray(hydroStation.pos) ? hydroStation.pos : hydronu.poiCenter;
  const position = Array.isArray(sweref) ? sweref99tmToWgs84(Number(sweref[0]), Number(sweref[1])) : null;
  const observedStation = position ? await findNearestObservedStation(position) : null;
  const observed = observedStation ? await fetchLatestObserved(observedStation.key) : null;

  const modelHistory = normalizeSeries(chart.coutHindcast && chart.coutHindcast.data);
  const forecast = normalizeSeries(chart.coutForecast && chart.coutForecast.data);
  const latestObserved = observed && observed.latest ? observed.latest : null;

  return {
    subid,
    label: `Station ${subid}`,
    productionTime: hydronu.productionTime || null,
    position,
    upstreamArea: Number(hydronu.upstreamArea) || null,
    subbasinArea: Number(hydronu.subbasinArea) || null,
    normalFlow: Number(hydronu.maxNormalQ || chart.mq || (hydroStation && hydroStation.normalQ)),
    modelHistory,
    forecast,
    latestModel: last(modelHistory) || forecast[0] || null,
    observedStation,
    observedParameter: observed && observed.parameter ? observed.parameter : null,
    observedSeries: observed ? observed.values : [],
    latestObserved
  };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/search") {
    const query = cleanSubid(url.searchParams.get("q") || "");
    const payload = await fetchJson(`${HYDRONU_BASE}/data/search?query=${encodeURIComponent(query)}`);
    send(res, 200, payload);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/station/")) {
    const subid = cleanSubid(decodeURIComponent(url.pathname.split("/").pop()));
    const payload = await getStationPayload(subid);
    send(res, 200, payload);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/favorites") {
    send(res, 200, await readFavorites());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/favorites") {
    const body = await readBody(req);
    const subid = cleanSubid(body.subid);
    const favorites = await readFavorites();
    let favorite = favorites.find((item) => item.subid === subid);
    if (!favorite) {
      favorite = {
        subid,
        label: `Station ${subid}`,
        addedAt: new Date().toISOString()
      };
      favorites.push(favorite);
      await writeFavorites(favorites);
    }
    send(res, 200, favorite);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/favorites/")) {
    const subid = cleanSubid(decodeURIComponent(url.pathname.split("/").pop()));
    const favorites = await readFavorites();
    await writeFavorites(favorites.filter((item) => item.subid !== subid));
    send(res, 204, null);
    return;
  }

  send(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const absolute = path.join(STATIC_ROOT, safePath);

  if (!absolute.startsWith(STATIC_ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(absolute);
    const extension = path.extname(absolute).toLowerCase();
    const contentType = extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".js"
        ? "text/javascript; charset=utf-8"
        : "text/plain; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch (error) {
    sendText(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`SMHI Flow Tracker running at http://localhost:${PORT}`);
});
