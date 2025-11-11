// map/assets/js/yandex.js
// Trans-Time / Яндекс.Карты — интеллектуальная карта с умными кнопками и слоями

import { $, $$, toast, fmtDist, fmtTime, escapeHtml } from './core.js';
import { YandexRouter } from './router.js';

let map, multiRoute, viaPoints = [];
let viaMarkers = [];
let activeRouteChangeHandler = null;

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

  viaPoints = [];
  viaMarkers.forEach(removeFromMap);
  viaMarkers = [];

  (r.viaPoints || []).forEach(coords => {
    viaPoints.push(coords);
    if (map) {
      const mark = new ymaps.Placemark(
        coords,
        { hintContent: 'via' },
        { preset: 'islands#darkGreenCircleDotIcon' }
      );
      addToMap(mark);
      viaMarkers.push(mark);
    }
  });

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

  savedRoutes.push({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh });
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

  const link = encodeSharePayload({ from: fromVal, to: toVal, viaPoints: viaPoints.slice(), veh });
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
function updateFramesForRoute(pts) {
  if (!layers.frames?.objects) return;
  if (!Array.isArray(pts) || pts.length === 0) {
    layers.frames.objects.setFilter(null);
    return;
  }
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  pts.forEach(([lon, lat]) => {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  });
  const m = 0.05;
  minLat -= m; maxLat += m; minLon -= m; maxLon += m;

  layers.frames.objects.setFilter(obj => {
    const gc = obj.geometry?.coordinates;
    if (!gc) return false;
    const [lon, lat] = gc;
    return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
  });
}

function refreshFramesForActiveRoute(fallbackPoints) {
  const framesToggle = $('#toggle-frames');
  if (!framesToggle?.checked) return;
  let pts = [];
  try {
    const wps = multiRoute?.getWayPoints?.();
    if (wps?.each) {
      wps.each(wp => {
        const coords = wp.geometry?.getCoordinates?.();
        if (Array.isArray(coords)) pts.push(coords);
      });
    }
  } catch {}
  if (!pts.length && Array.isArray(fallbackPoints) && fallbackPoints.length) {
    pts = fallbackPoints;
  }
  if (!pts.length) {
    pts = viaPoints.slice();
  }
  updateFramesForRoute(pts);
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
      return;
    }
    ensureFeatureIds(fc, name);
    decorateFeatureCollection(fc);
    delete fc.__tt_httpStatus;
    manager.removeAll?.();
    manager.add(fc);
    addToMap(manager);
    if (name === 'frames') refreshFramesForActiveRoute();
  } else {
    removeFromMap(manager);
    if (name === 'frames' && manager.objects?.setFilter) manager.objects.setFilter(null);
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

  loadSavedRoutes();
  renderSavedRoutes();

  saveRouteBtn?.addEventListener('click', saveCurrentRoute);
  shareRouteBtn?.addEventListener('click', shareCurrentRoute);
  openNavBtn?.addEventListener('click', openInNavigator);

  const cFrames = $('#toggle-frames');
  const cHgvA   = $('#toggle-hgv-allowed');
  const cHgvC   = $('#toggle-hgv-conditional');
  const cFed    = $('#toggle-federal');

  function updateUI() {
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
  function updateVehGroup() {
    vehRadios.forEach(r => r.parentElement.classList.toggle('active', r.checked));
  }

  [from, to].forEach(inp => inp?.addEventListener('input', updateUI));
  vehRadios.forEach(radio => radio.addEventListener('change', updateVehGroup));

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
    viaPoints.push(coords);
    const mark = new ymaps.Placemark(
      coords,
      { hintContent: 'via ' + viaPoints.length },
      { preset: 'islands#darkGreenCircleDotIcon' }
    );
    addToMap(mark);
    viaMarkers.push(mark);
    toast(`Добавлена via-точка (${viaPoints.length})`, 1200);
    updateUI();
  });

  buildBtn?.addEventListener('click', onBuild);
  clearVia?.addEventListener('click', () => {
    viaPoints = [];
    viaMarkers.forEach(removeFromMap);
    viaMarkers = [];
    toast('Via-точки очищены', 1200);
    updateUI();
  });

  updateUI();
  updateVehGroup();
}

/** Построение маршрута */
async function onBuild() {
  try {
    const checked = document.querySelector('input[name=veh]:checked');
    const mode = (checked && checked.value) || 'truck40';
    const opts = { mode: 'truck' };
    if (mode === 'car') opts.mode = 'auto';
    if (mode === 'truck40') opts.weight = 40000;
    if (mode === 'truckHeavy') opts.weight = 55000;

    const fromVal = $('#from')?.value.trim();
    const toVal   = $('#to')?.value.trim();
    if (!fromVal || !toVal) throw new Error('Укажите адреса Откуда и Куда');

    const A = await YandexRouter.geocode(fromVal);
    const B = await YandexRouter.geocode(toVal);
    const points = [A, ...viaPoints, B];

    const res = await YandexRouter.build(points, opts);
    const mr = res.multiRoute;
    const routes = res.routes;

    const prevMultiRoute = multiRoute;
    if (prevMultiRoute) {
      if (activeRouteChangeHandler && prevMultiRoute.events?.remove) {
        try { prevMultiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
      }
      removeFromMap(prevMultiRoute);
    }
    multiRoute = mr;
    addToMap(multiRoute);

    if (activeRouteChangeHandler && multiRoute?.events?.remove) {
      try { multiRoute.events.remove('activeroutechange', activeRouteChangeHandler); } catch {}
    }

    renderRouteList(routes);
    highlightActiveRouteItem();
    refreshFramesForActiveRoute(points);

    // Хук для следующего шага: реагируем на смену активного маршрута (bbox-фильтр рамок будет добавлен отдельно)
    if (multiRoute?.events?.add) {
      activeRouteChangeHandler = () => {
        highlightActiveRouteItem();
        refreshFramesForActiveRoute(points);
      };
      multiRoute.events.add('activeroutechange', activeRouteChangeHandler);
    } else {
      activeRouteChangeHandler = null;
    }

    toast('Маршрут успешно построен', 1800);
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
