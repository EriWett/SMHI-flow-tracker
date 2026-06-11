const HYDRONU_BASE = "https://vattenwebb.smhi.se/hydronu";
const HYDROOBS_BASE = "https://opendata-download-hydroobs.smhi.se/api/version/1.0";

const CACHE_SECONDS = {
  search: 10 * 60,
  hydronuPoint: 5 * 60,
  observedStations: 24 * 60 * 60,
  observedValues: 5 * 60
};

const stationCache = {
  loadedAt: 0,
  stations: []
};

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra
  };
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    })
  });
}

function cleanSubid(value) {
  const subid = String(value || "").trim();
  if (!/^\d+$/.test(subid)) {
    throw new Error("Station id must be an integer");
  }
  return subid;
}

async function fetchJsonCached(url, ttlSeconds, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json"
    },
    cf: {
      cacheEverything: true,
      cacheTtl: ttlSeconds
    }
  });

  if (!response.ok) {
    throw new Error(`SMHI request failed (${response.status})`);
  }

  const text = await response.text();
  const cacheResponse = new Response(text, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${ttlSeconds}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse.clone()));
  return JSON.parse(text);
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

async function getObservedStations(ctx) {
  const now = Date.now();
  if (stationCache.stations.length && now - stationCache.loadedAt < CACHE_SECONDS.observedStations * 1000) {
    return stationCache.stations;
  }

  const payload = await fetchJsonCached(`${HYDROOBS_BASE}/parameter/2.json`, CACHE_SECONDS.observedStations, ctx);
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

async function findNearestObservedStation(position, ctx) {
  const stations = await getObservedStations(ctx);
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

async function fetchLatestObserved(stationKey, ctx) {
  const attempts = [
    `${HYDROOBS_BASE}/parameter/2/station/${encodeURIComponent(stationKey)}/period/latest-hour/data.json`,
    `${HYDROOBS_BASE}/parameter/1/station/${encodeURIComponent(stationKey)}/period/latest-day/data.json`
  ];

  for (const url of attempts) {
    try {
      const payload = await fetchJsonCached(url, CACHE_SECONDS.observedValues, ctx);
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

async function getStationPayload(subid, ctx) {
  const hydronu = await fetchJsonCached(
    `${HYDRONU_BASE}/data/point?subid=${encodeURIComponent(subid)}`,
    CACHE_SECONDS.hydronuPoint,
    ctx
  );
  const chart = hydronu.chartData || {};
  const stationId = String(hydronu.nearestDownstreamStation || hydronu.poi || subid);
  const hydroStation = hydronu.stations && (hydronu.stations[stationId] || hydronu.stations[subid]);
  const sweref = hydroStation && Array.isArray(hydroStation.pos) ? hydroStation.pos : hydronu.poiCenter;
  const position = Array.isArray(sweref) ? sweref99tmToWgs84(Number(sweref[0]), Number(sweref[1])) : null;
  const observedStation = position ? await findNearestObservedStation(position, ctx) : null;
  const observed = observedStation ? await fetchLatestObserved(observedStation.key, ctx) : null;

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

async function handleApi(request, ctx) {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = cleanSubid(url.searchParams.get("q") || "");
    const payload = await fetchJsonCached(
      `${HYDRONU_BASE}/data/search?query=${encodeURIComponent(query)}`,
      CACHE_SECONDS.search,
      ctx
    );
    return jsonResponse(payload);
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/station/")) {
    const subid = cleanSubid(decodeURIComponent(url.pathname.split("/").pop()));
    const payload = await getStationPayload(subid, ctx);
    return jsonResponse(payload);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, ctx);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse({ error: error.message || "Server error" }, 500);
    }
  }
};
