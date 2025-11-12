// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

let map, multiRoute, viaPoints = [];
let viaMarkers = [];
let activeRouteChangeHandler = null;
let framesToggleStateBeforeCar = null;
let startPoint = null;
let endPoint = null;
let lastBuildOptions = null;
let editMode = false;
let toggleDragControl = null;
let updateUI = () => {};
let waypointHandlerCleanup = [];
let pathEventSubscriptions = [];
let routePathDragCandidate = null;

const ROUTE_DRAG_PIXEL_THRESHOLD = 6;

/* ---------- Хелперы для работы с geoObjects ---------- */
function addToMap(obj) {
  if (obj && map && !isOnMap(obj)) {
    map.geoObjects.add(obj);
    obj.__tt_onMap = true;
  }
}
function removeFromMap(obj) {
  if (obj && map && isOnMap(obj)) {
    map.geoObjects.remove(obj);
    obj.__tt_onMap = false;
  }
}
function isOnMap(obj) {
  return !!(obj && obj.__tt_onMap === true);
}

function normalizeCoordPair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  let [x, y] = pair;
  const absX = Math.abs(Number(x));
  const absY = Math.abs(Number(y));
  if (!Number.isFinite(absX) || !Number.isFinite(absY)) return null;
  // Если первая координата выглядит как широта — меняем порядок
  if (absX <= 90 && absY > 90) {
    [x, y] = [y, x];
  }
  return [Number(x), Number(y)];
}

function normalizeBBox(rawBBox) {
  if (!Array.isArray(rawBBox) || rawBBox.length < 2) return null;
  const p1 = normalizeCoordPair(rawBBox[0]);
  const p2 = normalizeCoordPair(rawBBox[1]);
  if (!p1 || !p2) return null;
  const [lon1, lat1] = p1;
  const [lon2, lat2] = p2;
  return [
    [Math.min(lon1, lon2), Math.min(lat1, lat2)],
    [Math.max(lon1, lon2), Math.max(lat1, lat2)]
  ];
}

function expandBBox(bbox, margin = 0) {
  const norm = normalizeBBox(bbox);
  if (!norm) return null;
  const [[minLon, minLat], [maxLon, maxLat]] = norm;
  return [
    [minLon - margin, minLat - margin],
    [maxLon + margin, maxLat + margin]
  ];
}

function bboxFromPoints(points, margin = 0.05) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  points.forEach(pt => {
    const norm = normalizeCoordPair(pt);
    if (!norm) return;
    const [lon, lat] = norm;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon) || !Number.isFinite(maxLat) || !Number.isFinite(maxLon)) {
    return null;
  }
  return [
    [minLon - margin, minLat - margin],
    [maxLon + margin, maxLat + margin]
  ];
}

function getCurrentVehMode() {
  return document.querySelector('input[name=veh]:checked')?.value || 'truck40';
}

function isCarMode() {
  return getCurrentVehMode() === 'car';
}

/* ---------- Маршрутное состояние и правка ---------- */
function copyCoords(pair) {
  const norm = normalizeCoordPair(pair);
  if (!norm) return null;
  return [norm[0], norm[1]];
}

function getReferencePointsArray() {
  const pts = [];
  const start = copyCoords(startPoint);
  const finish = copyCoords(endPoint);
  if (start) pts.push(start);
  viaPoints.forEach(pt => {
    const cp = copyCoords(pt);
    if (cp) pts.push(cp);
  });
  if (finish) pts.push(finish);
  return pts;
}

function computeRoutingOptions() {
  const checked = document.querySelector('input[name=veh]:checked');
  const mode = (checked && checked.value) || 'truck40';
  const opts = { mode: 'truck' };
  if (mode === 'car') opts.mode = 'auto';
  if (mode === 'truck40') opts.weight = 40000;
  if (mode === 'truckHeavy') opts.weight = 55000;
  return opts;
}

function refreshEditToggleState() {
  if (!toggleDragControl) return;
  toggleDragControl.classList.toggle('is-active', !!editMode);
  toggleDragControl.setAttribute('aria-pressed', editMode ? 'true' : 'false');
  toggleDragControl.textContent = editMode ? '🔓' : '🔒';
  toggleDragControl.title = editMode
    ? 'Правка маршрута разблокирована'
    : 'Правка маршрута заблокирована';
}

function clearWaypointHandlers() {
  waypointHandlerCleanup.forEach(fn => {
    try { fn(); } catch {}
  });
  waypointHandlerCleanup = [];
}

function syncWaypointDraggability() {
  clearWaypointHandlers();
  if (!multiRoute) return;
  const enable = !!editMode;
  try {
    multiRoute.options?.set?.('wayPointDraggable', enable);
    multiRoute.options?.set?.('viaPointDraggable', enable);
  } catch {}

  const collections = [];
  const wps = multiRoute.getWayPoints?.();
  const vias = multiRoute.getViaPoints?.();
  if (wps) collections.push(wps);
  if (vias) collections.push(vias);

  collections.forEach(col => {
    col.each(point => {
      try { point.options?.set?.('draggable', enable); } catch {}
      if (!point?.events || !enable) return;
      const handler = () => {
        captureReferencePointsFromMultiRoute();
        refreshFramesForActiveRoute(getReferencePointsArray());
        setupRoutePolylineEditing();
        updateUI();
      };
      point.events.add('dragend', handler);
      waypointHandlerCleanup.push(() => {
        try { point.events.remove('dragend', handler); } catch {}
      });
    });
  });
}

function clearRoutePathSubscriptions() {
  pathEventSubscriptions.forEach(sub => {
    const { path, handlers } = sub;
    handlers.forEach(({ type, fn }) => {
      try { path.events.remove(type, fn); } catch {}
    });
  });
  pathEventSubscriptions = [];
}

function projectToPixels(coords) {
  const projection = map?.options?.get?.('projection') || ymaps.projection.wgs84Mercator;
  const zoom = map?.getZoom?.() ?? 10;
  try {
    return projection.toGlobalPixels(coords, zoom);
  } catch {
    return null;
  }
}

function pixelsToCoords(px) {
  const projection = map?.options?.get?.('projection') || ymaps.projection.wgs84Mercator;
  const zoom = map?.getZoom?.() ?? 10;
  try {
    return projection.fromGlobalPixels(px, zoom);
  } catch {
    return null;
  }
}

function distance2d(a, b) {
  if (!a || !b) return Infinity;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function closestPointOnSegment(a, b, p) {
  if (!a || !b || !p) return a;
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const abLenSq = abx * abx + aby * aby;
  if (abLenSq === 0) return a;
  let t = (apx * abx + apy * aby) / abLenSq;
  if (t < 0) t = 0;
  if (t > 1) t = 1;
  return [a[0] + abx * t, a[1] + aby * t];
}

function findClosestPointOnRoute(targetCoords) {
  const activeRoute = multiRoute?.getActiveRoute?.();
  const paths = activeRoute?.getPaths?.();
  if (!paths) return null;
  const targetPx = projectToPixels(targetCoords);
  if (!targetPx) return null;
  let best = null;
  paths.each((path, pathIndex) => {
    const coords = [];
    path.getSegments?.().each(segment => {
      const segCoords = segment.getCoordinates?.();
      if (Array.isArray(segCoords)) {
        segCoords.forEach(c => coords.push(c));
      }
    });
    for (let i = 1; i < coords.length; i++) {
      const aPx = projectToPixels(coords[i - 1]);
      const bPx = projectToPixels(coords[i]);
      if (!aPx || !bPx) continue;
      const candidatePx = closestPointOnSegment(aPx, bPx, targetPx);
      const dist = distance2d(candidatePx, targetPx);
      if (!best || dist < best.dist) {
        const geo = pixelsToCoords(candidatePx);
        if (geo) best = { dist, coord: geo, pathIndex };
      }
    }
  });
  return best;
}

function captureReferencePointsFromMultiRoute() {
  if (!multiRoute) return;
  try {
    const wps = multiRoute.getWayPoints?.();
    if (wps?.getLength) {
      let idx = 0;
      let first = null;
      let last = null;
      wps.each(wp => {
        const coords = copyCoords(wp.geometry?.getCoordinates?.());
        if (coords) {
          if (idx === 0) first = coords;
          last = coords;
        }
        idx += 1;
      });
      if (first) startPoint = first;
      if (last) endPoint = last;
    }
    const newVia = [];
    const viaCollection = multiRoute.getViaPoints?.();
    viaCollection?.each(vp => {
      const coords = copyCoords(vp.geometry?.getCoordinates?.());
      if (coords) newVia.push(coords);
    });
    viaPoints = newVia;
    syncViaMarkers();
    updateUI();
  } catch {}
}

function detachViaMarkerHandlers(marker) {
  if (!marker) return;
  if (marker.__tt_dragHandler && marker.events?.remove) {
    try { marker.events.remove('dragend', marker.__tt_dragHandler); } catch {}
  }
  delete marker.__tt_dragHandler;
}

function attachViaMarkerHandlers(marker) {
  if (!marker) return;
  detachViaMarkerHandlers(marker);
  const handler = () => {
    const idx = viaMarkers.indexOf(marker);
    if (idx === -1) return;
    if (!editMode) {
      const original = viaPoints[idx];
      if (original && marker.geometry?.setCoordinates) marker.geometry.setCoordinates(original);
      return;
    }
    const prev = copyCoords(viaPoints[idx]);
    const next = copyCoords(marker.geometry?.getCoordinates?.());
    if (!next) return;
    viaPoints[idx] = next;
    buildRouteWithCoords(null, { silent: true }).catch(err => {
      if (prev) {
        viaPoints[idx] = prev;
        try { marker.geometry?.setCoordinates?.(prev); } catch {}
      }
      toast(typeof err === 'string' ? err : (err?.message || 'Ошибка перестроения маршрута'));
    }).finally(() => updateUI());
  };
  marker.events?.add('dragend', handler);
  marker.__tt_dragHandler = handler;
}

function syncViaMarkers() {
  for (let i = viaMarkers.length - 1; i >= viaPoints.length; i--) {
    const marker = viaMarkers[i];
    detachViaMarkerHandlers(marker);
    removeFromMap(marker);
    viaMarkers.pop();
  }

  viaPoints.forEach((coords, idx) => {
    let marker = viaMarkers[idx];
    if (!marker) {
      marker = new ymaps.Placemark(
        coords,
        { hintContent: 'via ' + (idx + 1) },
        { preset: 'islands#darkGreenCircleDotIcon', draggable: editMode }
      );
      viaMarkers[idx] = marker;
      addToMap(marker);
    } else {
      try { marker.geometry?.setCoordinates?.(coords); } catch {}
      marker.properties?.set?.('hintContent', 'via ' + (idx + 1));
      marker.options?.set?.('draggable', editMode);
    }
    attachViaMarkerHandlers(marker);
  });
}

function clearViaPoints() {
  const prev = viaPoints.map(copyCoords).filter(Boolean);
  viaPoints = [];
  syncViaMarkers();
  updateUI();
  if (!multiRoute) return Promise.resolve();
  return buildRouteWithCoords(null, { silent: true }).catch(err => {
    viaPoints = prev;
    syncViaMarkers();
    updateUI();
    throw err;
  });
}

function insertViaPoint(coords, index = viaPoints.length, { toastMessage = null } = {}) {
  const point = copyCoords(coords);
  if (!point) return Promise.resolve();
  const insertAt = Math.max(0, Math.min(index, viaPoints.length));
  viaPoints.splice(insertAt, 0, point);
  syncViaMarkers();
  updateUI();
  if (toastMessage) {
    const message = typeof toastMessage === 'function' ? toastMessage(viaPoints.length, insertAt) : toastMessage;
    toast(message, 1400);
  }
  if (!multiRoute) return Promise.resolve();
  return buildRouteWithCoords(null, { silent: true }).catch(err => {
    viaPoints.splice(insertAt, 1);
    syncViaMarkers();
    updateUI();
    throw err;
  });
}

function setEditMode(on) {
  editMode = !!on;
  refreshEditToggleState();
  syncViaMarkers();
  syncWaypointDraggability();
  setupRoutePolylineEditing();
}

function setupRoutePolylineEditing() {
  clearRoutePathSubscriptions();
  routePathDragCandidate = null;
  if (!editMode || !multiRoute) return;
  const activeRoute = multiRoute.getActiveRoute?.();
  const paths = activeRoute?.getPaths?.();
  if (!paths) return;
  paths.each((path, pathIndex) => {
    if (!path?.events) return;
    const down = (e) => {
      if (!editMode) return;
      const coords = e.get('coords');
      if (!coords) return;
      routePathDragCandidate = {
        pathIndex,
        downPixels: projectToPixels(coords)
      };
    };
    const up = (e) => {
      if (!editMode) return;
      const coords = e.get('coords');
      if (!coords || !routePathDragCandidate || routePathDragCandidate.pathIndex !== pathIndex) {
        routePathDragCandidate = null;
        return;
      }
      const upPixels = projectToPixels(coords);
      const downPixels = routePathDragCandidate.downPixels;
      routePathDragCandidate = null;
      if (downPixels && upPixels && distance2d(downPixels, upPixels) < ROUTE_DRAG_PIXEL_THRESHOLD) return;
      const snap = findClosestPointOnRoute(coords);
      if (!snap) return;
      const insertAt = Math.min(snap.pathIndex, viaPoints.length);
      insertViaPoint(snap.coord, insertAt, { toastMessage: 'Via-точка добавлена на маршрут' }).catch(err => {
        toast(typeof err === 'string' ? err : (err?.message || 'Ошибка перестроения маршрута'));
      });
    };
    const leave = () => { routePathDragCandidate = null; };
    path.events.add('mousedown', down);
    path.events.add('mouseup', up);
    path.events.add('mouseleave', leave);
    pathEventSubscriptions.push({
      path,
      handlers: [
        { type: 'mousedown', fn: down },
        { type: 'mouseup', fn: up },
        { type: 'mouseleave', fn: leave }
      ]
    });
  });
}

async function buildRouteWithCoords(opts, { silent = true, toastMessage = null } = {}) {
  const start = copyCoords(startPoint);
  const finish = copyCoords(endPoint);
  if (!start || !finish) throw new Error('Маршрут не задан');
  const options = opts ? { ...opts } : (lastBuildOptions ? { ...lastBuildOptions } : computeRoutingOptions());
  lastBuildOptions = { ...options };
  const referencePoints = [start];
  viaPoints.forEach(pt => {
    const c = copyCoords(pt);
    if (c) referencePoints.push(c);
  });
  referencePoints.push(finish);

  const res = await YandexRouter.build(referencePoints, options);
  applyRouteResult(res, referencePoints);
  if (!silent) {
    toast(toastMessage || 'Маршрут обновлён', 1600);
  }
}

function applyRouteResult(res, referencePoints) {
  const prevMultiRoute = multiRoute;
  if (prevMultiRoute) {
    if (activeRouteChangeHandler && prevMultiRoute.events?.remove) {
      try { prevMultiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
    }
    removeFromMap(prevMultiRoute);
  }
  clearWaypointHandlers();
  clearRoutePathSubscriptions();

  multiRoute = res.multiRoute;
  addToMap(multiRoute);

  if (activeRouteChangeHandler && multiRoute?.events?.remove) {
    try { multiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
  }

  renderRouteList(res.routes);
  highlightActiveRouteItem();
  refreshFramesForActiveRoute(referencePoints);
  captureReferencePointsFromMultiRoute();
  syncWaypointDraggability();
  setupRoutePolylineEditing();
  refreshEditToggleState();
  updateUI();

  if (multiRoute?.events?.add) {
    activeRouteChangeHandler = () => {
      captureReferencePointsFromMultiRoute();
      highlightActiveRouteItem();
      refreshFramesForActiveRoute(getReferencePointsArray());
      setupRoutePolylineEditing();
    };
    multiRoute.events.add('activeroutechange', activeRouteChangeHandler);
  } else {
    activeRouteChangeHandler = null;
  }
}

const LAYERS_BASE = window.TRANSTIME_CONFIG?.layersBase || (location.pathname.replace(/\/[^/]*$/, '') + '/data');
function urlFromBase(name) {
  return `${LAYERS_BASE}/${name}`;
}

async function loadGeoJSON(filename, friendlyName) {
  const url = urlFromBase(filename);
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) {
      toast(`Нет данных слоя: ${friendlyName || filename}`);
      return { type: 'FeatureCollection', features: [], __tt_httpStatus: 404 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && typeof data === 'object') data.__tt_httpStatus = res.status;
    return data;
  } catch (e) {
    toast(`Ошибка загрузки ${friendlyName || filename}: ${e.message}`);
    return { type: 'FeatureCollection', features: [], __tt_httpStatus: -1 };
  }
}

/** Список сохранённых маршрутов. Загружается из localStorage при инициализации */
let savedRoutes = [];

/** Загрузка сохранённых маршрутов */
function loadSavedRoutes() {
  try {
    const data = localStorage.getItem('TT_SAVED_ROUTES');
    savedRoutes = data ? JSON.parse(data) : [];
  } catch {
    savedRoutes = [];
  }
}

/** Запись сохранённых маршрутов */
function writeSavedRoutes() {
  try { localStorage.setItem('TT_SAVED_ROUTES', JSON.stringify(savedRoutes)); } catch {}
}

/** Рендер списка сохранённых маршрутов */
function renderSavedRoutes() {
  const listEl = document.getElementById('savedRoutesList');
  if (!listEl) return;
  listEl.innerHTML = '';
  savedRoutes.forEach((r, index) => {
    const li = document.createElement('li');
    const meta = document.createElement('div');
    meta.className = 'tt-saved-meta';
    const fromTxt = (r.from || '').trim();
    const toTxt = (r.to || '').trim();
    meta.textContent = `${fromTxt} → ${toTxt} (via: ${(r.viaPoints && r.viaPoints.length) || 0})`;

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Загрузить';
    loadBtn.addEventListener('click', () => loadSavedRoute(index));

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Удалить';
    delBtn.classList.add('delete');
    delBtn.addEventListener('click', () => deleteSavedRoute(index));

    li.appendChild(meta);
    li.appendChild(loadBtn);
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
}

/** Загрузка сохранённого маршрута */
async function loadSavedRoute(index) {
  const r = savedRoutes[index];
  if (!r) return;
  const fromEl = document.getElementById('from');
  const toEl   = document.getElementById('to');
  if (fromEl) fromEl.value = r.from || '';
  if (toEl)   toEl.value   = r.to   || '';

  if (r.veh) {
    $$('input[name=veh]').forEach(inp => {
      inp.checked = inp.value === r.veh;
      inp.dispatchEvent(new Event('change'));
    });
  }

  viaPoints = (r.viaPoints || []).map(copyCoords).filter(Boolean);
  syncViaMarkers();
  updateUI();

  fromEl?.dispatchEvent(new Event('input'));
  toEl?.dispatchEvent(new Event('input'));
  await onBuild();
}

/** Удаление маршрута из списка */
function deleteSavedRoute(index) {
  savedRoutes.splice(index, 1);
  writeSavedRoutes();
  renderSavedRoutes();
}

/** Сохранение текущего маршрута */
function saveCurrentRoute() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
  if (!fromVal || !toVal) return toast('Заполните адреса для сохранения', 2000);

  const vehChecked = document.querySelector('input[name=veh]:checked');
  const veh = (vehChecked && vehChecked.value) || 'truck40';

  savedRoutes.push({ from: fromVal, to: toVal, viaPoints: viaPoints.map(copyCoords), veh });
  writeSavedRoutes();
  renderSavedRoutes();
  toast('Маршрут сохранён', 1600);
}

/** Кодирование share-пэйлоада */
function encodeSharePayload(data) {
  try {
    const json = JSON.stringify(data);
    const b64  = btoa(unescape(encodeURIComponent(json)));
    return window.location.href.split('#')[0] + '#share=' + b64;
  } catch {
    return '';
  }
}

/** Поделиться текущим маршрутом */
async function shareCurrentRoute() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
  if (!fromVal || !toVal) return toast('Нет маршрута для создания ссылки', 2000);

  const vehChecked = document.querySelector('input[name=veh]:checked');
  const veh = (vehChecked && vehChecked.value) || 'truck40';

  const link = encodeSharePayload({ from: fromVal, to: toVal, viaPoints: viaPoints.map(copyCoords), veh });
  if (!link) return toast('Не удалось создать ссылку', 2000);

  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована в буфер обмена', 2000); }
    catch { toast('Ссылка: ' + link, 4000); }
  } else {
    toast('Ссылка: ' + link, 4000);
  }
}

/** Открыть в Яндекс.Навигаторе */
function openInNavigator() {
  const fromVal = document.getElementById('from')?.value.trim();
  const toVal   = document.getElementById('to')?.value.trim();
  if (!fromVal || !toVal) return toast('Нет маршрута для открытия', 2000);

  const pts = [];
  if (multiRoute?.getWayPoints) {
    const wps = multiRoute.getWayPoints();
    wps.each(wp => {
      const c = wp.geometry.getCoordinates();
      if (Array.isArray(c)) pts.push(c[1] + ',' + c[0]);
    });
  }
  viaPoints.forEach(v => { if (Array.isArray(v)) pts.splice(pts.length - 1, 0, v[1] + ',' + v[0]); });

  const url = 'https://yandex.ru/navi/?rtext=' + encodeURIComponent(pts.join('~')) + '&rtt=auto';
  window.open(url, '_blank');
}

/** Фильтрация весовых рамок по bbox активного маршрута */
function applyFramesBBox(bbox) {
  if (!layers.frames?.objects) return;
  if (!bbox) {
    layers.frames.objects.setFilter?.(null);
    return;
  }
  const expanded = expandBBox(bbox, 0.02);
  if (!expanded) {
    layers.frames.objects.setFilter?.(null);
    return;
  }
  const [[minLon, minLat], [maxLon, maxLat]] = expanded;
  layers.frames.objects.setFilter(obj => {
    const coords = normalizeCoordPair(obj.geometry?.coordinates);
    if (!coords) return false;
    const [lon, lat] = coords;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  });
}

function collectRouteGeometryPoints(route) {
  const pts = [];
  if (!route) return pts;
  try {
    route.getPaths?.().each(path => {
      path.getSegments?.().each(segment => {
        const coords = segment.getCoordinates?.();
        if (Array.isArray(coords)) {
          coords.forEach(c => { if (Array.isArray(c)) pts.push(c); });
        }
      });
    });
  } catch {}
  return pts;
}

function refreshFramesForActiveRoute(fallbackPoints) {
  if (isCarMode()) {
    removeFromMap(layers.frames);
    layers.frames?.objects?.setFilter?.(null);
    return;
  }
  const framesToggle = $('#toggle-frames');
  if (!framesToggle?.checked) return;

  let bbox = null;
  const activeRoute = multiRoute?.getActiveRoute?.();
  if (activeRoute) {
    bbox = normalizeBBox(activeRoute.properties?.get?.('boundedBy'));
    if (!bbox && activeRoute.model?.getBounds) bbox = normalizeBBox(activeRoute.model.getBounds());
    if (!bbox && activeRoute.getBounds) bbox = normalizeBBox(activeRoute.getBounds());
    if (!bbox) {
      const geomPts = collectRouteGeometryPoints(activeRoute);
      bbox = bboxFromPoints(geomPts);
    }
  }

  if (!bbox && Array.isArray(fallbackPoints) && fallbackPoints.length) {
    bbox = bboxFromPoints(fallbackPoints);
  }

  if (!bbox) {
    const wpPts = [];
    try {
      const wps = multiRoute?.getWayPoints?.();
      wps?.each(wp => {
        const coords = wp.geometry?.getCoordinates?.();
        if (Array.isArray(coords)) wpPts.push(coords);
      });
    } catch {}
    if (!wpPts.length) {
      wpPts.push(...viaPoints);
    }
    bbox = bboxFromPoints(wpPts);
  }

  applyFramesBBox(bbox);
}

function syncFramesLayerVisibility() {
  const manager = layers.frames;
  const framesToggle = $('#toggle-frames');
  if (!framesToggle || !manager) return;
  const car = isCarMode();
  framesToggle.disabled = car;
  if (car) {
    if (framesToggleStateBeforeCar === null) {
      framesToggleStateBeforeCar = framesToggle.checked;
    }
    framesToggle.checked = false;
    removeFromMap(manager);
    manager.objects?.setFilter?.(null);
    return;
  }

  if (framesToggleStateBeforeCar !== null) {
    framesToggle.checked = framesToggleStateBeforeCar;
    framesToggleStateBeforeCar = null;
  }

  if (framesToggle.checked) {
    addToMap(manager);
    refreshFramesForActiveRoute();
  } else {
    removeFromMap(manager);
    manager.objects?.setFilter?.(null);
  }
}

/** Отрисовка списка альтернатив */
function renderRouteList(routes) {
  const listEl = document.getElementById('routeList');
  if (!listEl) return;
  if (!routes || routes.getLength() <= 1) {
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }
  listEl.innerHTML = '';
  const arr = [];
  routes.each(r => arr.push(r));
  arr.forEach((route, index) => {
    const distObj = route.properties.get('distance') || {};
    const durObj  = route.properties.get('duration') || {};
    const distTxt = distObj.text || fmtDist(distObj.value || 0);
    const durTxt  = durObj.text  || fmtTime(durObj.value || 0);
    const div = document.createElement('div');
    div.className = 'tt-route-item';
    div.dataset.index = index;
    div.innerHTML = `<div><strong>Маршрут ${index + 1}</strong></div><div>${distTxt}, ${durTxt}</div>`;
    div.addEventListener('click', () => { try { multiRoute.setActiveRoute(route); } catch {} });
    listEl.appendChild(div);
  });
  listEl.style.display = 'block';
  highlightActiveRouteItem();
}

/** Подсветка активного маршрута */
function highlightActiveRouteItem() {
  const listEl = document.getElementById('routeList');
  if (!listEl || !multiRoute?.getActiveRoute) return;
  const active = multiRoute.getActiveRoute();
  const routes = multiRoute.getRoutes && multiRoute.getRoutes();
  let activeIndex = -1;
  if (routes?.getLength) routes.each((r, idx) => { if (r === active) activeIndex = idx; });
  Array.from(listEl.children).forEach((el, idx) => el.classList.toggle('active', idx === activeIndex));
}

/** Регистр слоёв */
const layers = {
  frames: null,
  hgvAllowed: null,
  hgvConditional: null,
  federal: null
};

const layerConfigs = {
  frames: {
    filename: 'frames_ready.geojson',
    friendlyName: 'Весовые рамки',
    options: { preset: 'islands#blueCircleDotIcon', zIndex: 220 }
  },
  hgvAllowed: {
    filename: 'hgv_allowed.geojson',
    friendlyName: 'Разрешённый проезд ТС >3,5т',
    options: { preset: 'islands#darkGreenCircleDotIcon', zIndex: 210 }
  },
  hgvConditional: {
    filename: 'hgv_conditional.geojson',
    friendlyName: 'Условно разрешённый проезд ТС >3,5т',
    options: { preset: 'islands#yellowCircleDotIcon', zIndex: 205 }
  },
  federal: {
    filename: 'federal.geojson',
    friendlyName: 'Федеральные трассы',
    options: { preset: 'islands#grayCircleDotIcon', zIndex: 200 }
  }
};

function applyLayerOptions(manager, options = {}) {
  if (!manager?.objects?.options) return;
  Object.entries(options).forEach(([key, value]) => {
    manager.objects.options.set(key, value);
  });
  manager.objects.options.set({
    strokeColor: '#60a5fa',
    strokeWidth: 3,
    strokeOpacity: 0.9,
    fillOpacity: 0.3
  });
}

function decorateFeatureCollection(fc) {
  if (!fc?.features) return;
  fc.features.forEach(f => {
    const p = f.properties || {};
    f.properties = {
      hintContent: p.name || p.title || 'Объект',
      balloonContent:
        `<b>${escapeHtml(p.name || p.title || 'Объект')}</b>` +
        (p.comment ? `<div class="mt6">${escapeHtml(p.comment)}</div>` : '') +
        (p.date ? `<div class="small mt6">Дата: ${escapeHtml(p.date)}</div>` : '')
    };
  });
}

// Гарантия уникальных feature.id для ObjectManager
function ensureFeatureIds(fc, prefix = 'fc') {
  if (!fc?.features) return;
  let i = 0;
  fc.features.forEach(f => {
    if (f && (f.id === undefined || f.id === null)) {
      f.id = `${prefix}_${i++}`;
    }
  });
}

/** Точка входа — загрузка SDK */
export function init() {
  const cfg = (window.TRANSTIME_CONFIG && window.TRANSTIME_CONFIG.yandex) || null;
  if (!cfg?.apiKey) return toast('Ошибка конфигурации: нет API-ключа');

  if (window.__TT_YA_LOADING__) return;
  window.__TT_YA_LOADING__ = true;

  const script = document.createElement('script');
  script.src =
    'https://api-maps.yandex.ru/2.1/?apikey=' + encodeURIComponent(cfg.apiKey) +
    '&lang=' + encodeURIComponent(cfg.lang || 'ru_RU') +
    '&csp=true&coordorder=longlat' +
    '&load=package.standard,package.search,multiRouter.MultiRoute,package.geoObjects,ObjectManager';

  script.onload = () => (window.ymaps && typeof ymaps.ready === 'function')
    ? ymaps.ready(setup)
    : toast('Yandex API не инициализировался');

  script.onerror = () => toast('Не удалось загрузить Yandex Maps');
  document.head.appendChild(script);
}

async function toggleLayer(name, on, checkbox) {
  if (!map) return;
  const cfg = layerConfigs[name];
  const manager = layers[name];
  if (!cfg || !manager) return;

  if (on) {
    const fc = await loadGeoJSON(cfg.filename, cfg.friendlyName);
    if (!Array.isArray(fc.features) || fc.features.length === 0) {
      if (fc.__tt_httpStatus !== 404) {
        toast(`Нет данных слоя: ${cfg.friendlyName}`);
      }
      checkbox && (checkbox.checked = false);
      manager.removeAll?.();
      removeFromMap(manager);
      if (name === 'frames') syncFramesLayerVisibility();
      return;
    }
    ensureFeatureIds(fc, name);
    decorateFeatureCollection(fc);
    delete fc.__tt_httpStatus;
    manager.removeAll?.();
    manager.add(fc);
    addToMap(manager);
    if (name === 'frames') {
      refreshFramesForActiveRoute();
      syncFramesLayerVisibility();
    }
  } else {
    removeFromMap(manager);
    if (name === 'frames' && manager.objects?.setFilter) manager.objects.setFilter(null);
    if (name === 'frames') syncFramesLayerVisibility();
  }
}

/** Инициализация карты и UI */
function setup() {
  const cfg = window.TRANSTIME_CONFIG || {};
  const center = (cfg.map && cfg.map.center) || [55.751244, 37.618423];
  const zoom   = (cfg.map && cfg.map.zoom)   || 8;

  if (!document.getElementById('map')) return toast('Не найден контейнер #map', 2500);

  map = new ymaps.Map('map', { center, zoom, controls: ['zoomControl', 'typeSelector'] }, { suppressMapOpenBlock: true });

  Object.entries(layerConfigs).forEach(([name, cfg]) => {
    const manager = new ymaps.ObjectManager({ clusterize: false });
    layers[name] = manager;
    applyLayerOptions(manager, cfg.options);
  });

  const from = $('#from');
  const to   = $('#to');
  const buildBtn = $('#buildBtn');
  const clearVia = $('#clearVia');
  const vehRadios = $$('input[name=veh]');

  const saveRouteBtn   = $('#saveRouteBtn');
  const shareRouteBtn  = $('#shareRouteBtn');
  const openNavBtn     = $('#openNavBtn');
  toggleDragControl = $('#toggle-drag');
  toggleDragControl?.addEventListener('click', () => setEditMode(!editMode));
  refreshEditToggleState();

  loadSavedRoutes();
  renderSavedRoutes();

  saveRouteBtn?.addEventListener('click', saveCurrentRoute);
  shareRouteBtn?.addEventListener('click', shareCurrentRoute);
  openNavBtn?.addEventListener('click', openInNavigator);

  const cFrames = $('#toggle-frames');
  const cHgvA   = $('#toggle-hgv-allowed');
  const cHgvC   = $('#toggle-hgv-conditional');
  const cFed    = $('#toggle-federal');

  function updateUIInner() {
    const hasFrom = !!from?.value.trim();
    const hasTo   = !!to?.value.trim();

    if (buildBtn) {
      buildBtn.disabled = !(hasFrom && hasTo);
      buildBtn.title = buildBtn.disabled ? 'Укажите пункты A и B' : '';
      buildBtn.classList.toggle('highlight', !buildBtn.disabled);
    }
    if (clearVia) {
      clearVia.disabled = viaPoints.length === 0;
      clearVia.title = clearVia.disabled ? 'Нет промежуточных точек для сброса' : '';
    }
  }
  updateUI = updateUIInner;
  function updateVehGroup() {
    vehRadios.forEach(r => r.parentElement.classList.toggle('active', r.checked));
  }
  function handleVehicleChange() {
    updateVehGroup();
    syncFramesLayerVisibility();
  }

  [from, to].forEach(inp => inp?.addEventListener('input', updateUI));
  vehRadios.forEach(radio => radio.addEventListener('change', handleVehicleChange));

  cFrames?.addEventListener('change', e => toggleLayer('frames', e.target.checked, cFrames));
  cHgvA?.addEventListener('change', e => toggleLayer('hgvAllowed', e.target.checked, cHgvA));
  cHgvC?.addEventListener('change', e => toggleLayer('hgvConditional', e.target.checked, cHgvC));
  cFed ?.addEventListener('change', e => toggleLayer('federal', e.target.checked, cFed));

  if (cHgvA?.checked) toggleLayer('hgvAllowed', true, cHgvA);
  if (cFrames?.checked) toggleLayer('frames', true, cFrames);
  if (cHgvC?.checked) toggleLayer('hgvConditional', true, cHgvC);
  if (cFed ?.checked) toggleLayer('federal', true, cFed);

  map.events.add('click', (e) => {
    const coords = e.get('coords');
    if (!coords) return;
    if (multiRoute && !editMode) return;
    insertViaPoint(coords, viaPoints.length, {
      toastMessage: count => `Добавлена via-точка (${count})`
    }).catch(err => {
      toast(typeof err === 'string' ? err : (err?.message || 'Ошибка перестроения маршрута'));
    });
  });

  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
    clearViaPoints()
      .then(() => toast('Via-точки очищены', 1200))
      .catch(err => toast(typeof err === 'string' ? err : (err?.message || 'Ошибка перестроения маршрута')));
  });

  updateUI();
  updateVehGroup();
  syncFramesLayerVisibility();
}

/** Построение маршрута */
async function onBuild() {
  try {
    const fromVal = $('#from')?.value.trim();
    const toVal   = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите адреса Откуда и Куда');

    const opts = computeRoutingOptions();
    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);

    const start = copyCoords(A);
    const finish = copyCoords(B);
    if (!start || !finish) throw new Error('Не удалось определить координаты точек');

    startPoint = start;
    endPoint = finish;

    await buildRouteWithCoords(opts, { silent: false, toastMessage: 'Маршрут успешно построен' });
  } catch (e) {
    toast(typeof e === 'string' ? e : (e.message || 'Ошибка построения маршрута'));
  }
}

/** Авто-инициализация */
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { try { init(); } catch (e) { console.error(e); } });
  } else {
    try { init(); } catch (e) { console.error(e); }
  }
}
