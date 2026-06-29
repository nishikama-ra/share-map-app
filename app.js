const DEFAULT_CENTER = [35.319, 139.546];
const DEFAULT_ZOOM = 12;
const STORAGE_KEY = "map-share-draft";
const ROUTE_ENDPOINT = "https://router.project-osrm.org/route/v1/driving/";

const PIN_TYPES = {
  stop: { label: "立ち寄り", color: "#1f7a68", symbol: "•" },
  start: { label: "出発", color: "#2563eb", symbol: "S" },
  goal: { label: "到着", color: "#dc2626", symbol: "G" },
  parking: { label: "駐車場", color: "#7c3aed", symbol: "P" },
  warning: { label: "注意", color: "#d97706", symbol: "!" },
  food: { label: "食事", color: "#be123c", symbol: "F" },
};

L.Icon.Default.imagePath = "";
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const state = {
  places: [],
  markers: [],
  previewMarker: null,
  selectedIndex: null,
  routeLayer: null,
  routeRequestId: 0,
};

const map = L.map("map", {
  zoomControl: true,
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const els = {
  appShell: document.querySelector("#appShell"),
  searchForm: document.querySelector("#searchForm"),
  searchInput: document.querySelector("#searchInput"),
  selectedPlacePanel: document.querySelector("#selectedPlacePanel"),
  selectedPlaceTitle: document.querySelector("#selectedPlaceTitle"),
  selectedPlaceMeta: document.querySelector("#selectedPlaceMeta"),
  selectedPlaceNote: document.querySelector("#selectedPlaceNote"),
  editSelectedPlace: document.querySelector("#editSelectedPlace"),
  placeForm: document.querySelector("#placeForm"),
  editingIndex: document.querySelector("#editingIndex"),
  placeTitle: document.querySelector("#placeTitle"),
  placeType: document.querySelector("#placeType"),
  placeNote: document.querySelector("#placeNote"),
  placeLat: document.querySelector("#placeLat"),
  placeLng: document.querySelector("#placeLng"),
  savePlace: document.querySelector("#savePlace"),
  newPlace: document.querySelector("#newPlace"),
  editModeStatus: document.querySelector("#editModeStatus"),
  placesList: document.querySelector("#placesList"),
  placeCount: document.querySelector("#placeCount"),
  copyLink: document.querySelector("#copyLink"),
  resetPanel: document.querySelector("#resetPanel"),
  shareStatus: document.querySelector("#shareStatus"),
  showRoute: document.querySelector("#showRoute"),
  routeStatus: document.querySelector("#routeStatus"),
};

function normalizePlace(place) {
  return {
    title: String(place.title || "地点"),
    note: String(place.note || ""),
    type: PIN_TYPES[place.type] ? place.type : "stop",
    lat: Number(place.lat),
    lng: Number(place.lng),
  };
}

function encodePlaces(places) {
  const compact = places.map((place) => ({
    t: place.title,
    n: place.note,
    y: place.type || "stop",
    a: Number(place.lat.toFixed(6)),
    g: Number(place.lng.toFixed(6)),
  }));
  return btoa(unescape(encodeURIComponent(JSON.stringify(compact))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodePlaces(value) {
  const normalized = value
    .replace(/ /g, "+")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
  const json = decodeURIComponent(escape(atob(padded)));
  const decoded = JSON.parse(json);
  if (!Array.isArray(decoded)) {
    return [];
  }
  return decoded
    .map((place) => normalizePlace({
      title: String(place.t || "地点"),
      note: String(place.n || ""),
      type: String(place.y || "stop"),
      lat: Number(place.a),
      lng: Number(place.g),
    }))
    .filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lng));
}

function loadInitialPlaces() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const shared = params.get("places");
  if (shared) {
    try {
      return decodePlaces(shared);
    } catch (error) {
      console.warn("共有URLを読み込めませんでした。", error);
    }
  }

  try {
    const draft = localStorage.getItem(STORAGE_KEY);
    const parsed = draft ? JSON.parse(draft) : [];
    return Array.isArray(parsed) ? parsed.map(normalizePlace) : [];
  } catch (error) {
    console.warn("保存済み下書きを読み込めませんでした。", error);
    return [];
  }
}

function saveDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.places));
}

function shareUrl() {
  const url = new URL(window.location.href);
  url.hash = state.places.length ? `places=${encodePlaces(state.places)}` : "";
  return url.toString();
}

function syncUrl() {
  history.replaceState(null, "", shareUrl());
  els.shareStatus.textContent = state.places.length
    ? `${state.places.length}件の地点を含む共有URLを作成済みです。`
    : "地点を追加するとURLが作成されます。";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[char]));
}

function markerPopup(place, index) {
  const type = PIN_TYPES[place.type] || PIN_TYPES.stop;
  const note = place.note ? `<div class="popup-note">${escapeHtml(place.note)}</div>` : "";
  return `
    <div class="popup-title">${escapeHtml(place.title)}</div>
    <div class="popup-type">${type.label}</div>
    ${note}
    <button class="popup-edit-button" type="button" data-popup-edit="${index}">編集</button>
  `;
}

function markerTooltip(place) {
  const note = place.note ? `<div>${escapeHtml(place.note)}</div>` : "";
  return `<div class="map-label-title">${escapeHtml(place.title)}</div>${note}`;
}

function createPinIcon(place, index) {
  const type = PIN_TYPES[place.type] || PIN_TYPES.stop;
  const selectedClass = index === state.selectedIndex ? " is-selected" : "";
  return L.divIcon({
    className: `custom-pin-wrap${selectedClass}`,
    html: `<span class="custom-pin" style="--pin-color:${type.color}"><span>${escapeHtml(type.symbol)}</span></span>`,
    iconSize: [34, 42],
    iconAnchor: [17, 38],
    popupAnchor: [0, -36],
    tooltipAnchor: [18, -32],
  });
}

function createPreviewIcon(place) {
  const type = PIN_TYPES[place.type] || PIN_TYPES.stop;
  return L.divIcon({
    className: "custom-pin-wrap is-preview",
    html: `<span class="custom-pin" style="--pin-color:${type.color}"><span>+</span></span>`,
    iconSize: [34, 42],
    iconAnchor: [17, 38],
    popupAnchor: [0, -36],
    tooltipAnchor: [18, -32],
  });
}

function setMenuHidden(hidden) {
  state.menuHidden = hidden;
  els.appShell.classList.toggle("menu-hidden", hidden);
  requestAnimationFrame(() => map.invalidateSize());
}

function showMenu() {
  setMenuHidden(false);
}

function hideMenu() {
  setMenuHidden(true);
}

function renderSelectedPanel() {
  const index = state.selectedIndex;
  const place = Number.isInteger(index) ? state.places[index] : null;
  if (!place) {
    els.selectedPlacePanel.hidden = true;
    els.editSelectedPlace.dataset.index = "";
    return;
  }

  const type = PIN_TYPES[place.type] || PIN_TYPES.stop;
  els.selectedPlacePanel.hidden = false;
  els.selectedPlaceTitle.textContent = place.title;
  els.selectedPlaceMeta.textContent = `${type.label} / ${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}`;
  els.selectedPlaceNote.textContent = place.note || "コメントなし";
  els.editSelectedPlace.dataset.index = String(index);
}

function clearPreviewMarker() {
  if (state.previewMarker) {
    state.previewMarker.remove();
    state.previewMarker = null;
  }
  document.querySelectorAll(".custom-pin-wrap.is-preview").forEach((element) => {
    element.remove();
  });
}

function editorHasCoordinates() {
  const latValue = els.placeLat.value.trim();
  const lngValue = els.placeLng.value.trim();
  return latValue !== "" && lngValue !== "" && Number.isFinite(Number(latValue)) && Number.isFinite(Number(lngValue));
}

function updatePreviewMarker() {
  const isNewPlace = els.editingIndex.value === "";
  if (!isNewPlace || !editorHasCoordinates()) {
    clearPreviewMarker();
    return;
  }

  const place = currentEditorPlace({
    lat: Number(els.placeLat.value),
    lng: Number(els.placeLng.value),
  });
  const latLng = [place.lat, place.lng];

  if (!state.previewMarker) {
    state.previewMarker = L.marker(latLng, {
      draggable: true,
      icon: createPreviewIcon(place),
      zIndexOffset: 900,
    }).addTo(map);

    state.previewMarker.on("dragend", () => {
      const position = state.previewMarker.getLatLng();
      els.placeLat.value = position.lat.toFixed(6);
      els.placeLng.value = position.lng.toFixed(6);
      updatePreviewMarker();
    });
  } else {
    state.previewMarker.setLatLng(latLng);
    state.previewMarker.setIcon(createPreviewIcon(place));
  }
}

function selectPlace(index) {
  showMenu();
  state.selectedIndex = index;
  renderMarkers();
  renderList();
  renderSelectedPanel();
}

function renderMarkers() {
  state.markers.forEach((marker) => marker.remove());
  state.markers = state.places.map((place, index) => {
    const marker = L.marker([place.lat, place.lng], {
      draggable: true,
      icon: createPinIcon(place, index),
    })
      .bindPopup(markerPopup(place, index))
      .bindTooltip(markerTooltip(place), {
        permanent: true,
        direction: "right",
        offset: [14, -22],
        className: "map-comment-label",
      })
      .addTo(map);

    marker.on("click", () => {
      selectPlace(index);
    });

    marker.on("popupopen", () => {
      const button = document.querySelector(`[data-popup-edit="${index}"]`);
      button?.addEventListener("click", () => startEditing(index));
    });

    marker.on("dragend", () => {
      const position = marker.getLatLng();
      state.places[index].lat = position.lat;
      state.places[index].lng = position.lng;
      state.selectedIndex = index;
      render();
      fillEditor(state.places[index], index);
    });

    return marker;
  });
}

function fitToPlaces() {
  if (state.places.length) {
    const bounds = L.latLngBounds(state.places.map((place) => [place.lat, place.lng]));
    map.fitBounds(bounds.pad(0.18), { maxZoom: 15 });
  }
}

function renderList() {
  els.placeCount.textContent = `${state.places.length}件`;
  els.placesList.innerHTML = "";

  state.places.forEach((place, index) => {
    const type = PIN_TYPES[place.type] || PIN_TYPES.stop;
    const item = document.createElement("li");
    item.className = `place-item${index === state.selectedIndex ? " is-selected" : ""}`;
    item.innerHTML = `
      <div class="place-title-row">
        <span class="type-dot" style="--pin-color:${type.color}">${escapeHtml(type.symbol)}</span>
        <strong>${escapeHtml(place.title)}</strong>
      </div>
      ${place.note ? `<p>${escapeHtml(place.note)}</p>` : ""}
      <div class="place-meta">${type.label} / ${place.lat.toFixed(6)}, ${place.lng.toFixed(6)}</div>
      <div class="place-actions">
        <button type="button" data-action="focus" data-index="${index}">表示</button>
        <button type="button" data-action="edit" data-index="${index}">編集</button>
        <button type="button" data-action="move-up" data-index="${index}" ${index === 0 ? "disabled" : ""}>上へ</button>
        <button type="button" data-action="move-down" data-index="${index}" ${index === state.places.length - 1 ? "disabled" : ""}>下へ</button>
        <button type="button" class="danger" data-action="delete" data-index="${index}">削除</button>
      </div>
    `;
    els.placesList.appendChild(item);
  });
}

function clearRoute() {
  if (state.routeLayer) {
    state.routeLayer.remove();
    state.routeLayer = null;
  }
}

async function renderRoute() {
  const requestId = ++state.routeRequestId;
  clearRoute();

  if (!els.showRoute.checked) {
    els.routeStatus.textContent = "ルート表示はオフです。";
    return;
  }

  if (state.places.length < 2) {
    els.routeStatus.textContent = "2地点以上でルートを表示できます。";
    return;
  }

  const coordinates = state.places.map((place) => `${place.lng},${place.lat}`).join(";");
  const routeUrl = `${ROUTE_ENDPOINT}${coordinates}?overview=full&geometries=geojson`;
  els.routeStatus.textContent = "道路沿いのルートを取得中です。";

  try {
    const response = await fetch(routeUrl);
    if (!response.ok) {
      throw new Error(`route status ${response.status}`);
    }
    const data = await response.json();
    if (requestId !== state.routeRequestId) {
      return;
    }
    const route = data.routes?.[0];
    if (!route?.geometry?.coordinates?.length) {
      throw new Error("route not found");
    }

    const latLngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    state.routeLayer = L.polyline(latLngs, {
      color: "#0f766e",
      weight: 5,
      opacity: 0.86,
      lineJoin: "round",
    }).addTo(map);

    const distanceKm = route.distance / 1000;
    const durationMin = Math.round(route.duration / 60);
    els.routeStatus.textContent = `ルート: 約${distanceKm.toFixed(1)}km / 約${durationMin}分`;
  } catch (error) {
    if (requestId !== state.routeRequestId) {
      return;
    }
    console.warn("ルートを取得できませんでした。", error);
    els.routeStatus.textContent = "ルートを取得できませんでした。地点が道路から離れているか、通信に失敗しています。";
  }
}

function render() {
  if (state.selectedIndex !== null && !state.places[state.selectedIndex]) {
    state.selectedIndex = null;
  }
  renderMarkers();
  renderList();
  renderSelectedPanel();
  saveDraft();
  syncUrl();
  renderRoute();
  requestAnimationFrame(() => map.invalidateSize());
}

function setEditorMode(index) {
  const isEditing = index !== "";
  els.placeForm.classList.toggle("is-editing", isEditing);
  els.savePlace.textContent = isEditing ? "変更を保存" : "地点を追加";
  els.newPlace.hidden = !isEditing;
  els.editModeStatus.textContent = isEditing
    ? "編集中です。保存後もこの地点の編集を続けられます。"
    : "地図をクリックすると新しい地点の座標を入れられます。";
}

function fillEditor(place, index = "") {
  const normalized = normalizePlace(place);
  els.editingIndex.value = index;
  els.placeTitle.value = normalized.title === "地点" ? "" : normalized.title;
  els.placeType.value = normalized.type;
  els.placeNote.value = normalized.note;
  els.placeLat.value = Number.isFinite(normalized.lat) ? normalized.lat.toFixed(6) : "";
  els.placeLng.value = Number.isFinite(normalized.lng) ? normalized.lng.toFixed(6) : "";
  setEditorMode(index);
  updatePreviewMarker();
}

function currentEditorPlace(overrides = {}) {
  return normalizePlace({
    title: els.placeTitle.value.trim() || "地点",
    note: els.placeNote.value.trim(),
    type: els.placeType.value,
    lat: Number(els.placeLat.value),
    lng: Number(els.placeLng.value),
    ...overrides,
  });
}

function resetEditor() {
  fillEditor({ title: "", note: "", type: "stop", lat: NaN, lng: NaN });
}

function resetPanel() {
  state.selectedIndex = null;
  resetEditor();
  renderMarkers();
  renderList();
  renderSelectedPanel();
}

function movePlace(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.places.length) {
    return;
  }

  const [place] = state.places.splice(index, 1);
  state.places.splice(nextIndex, 0, place);

  if (state.selectedIndex === index) {
    state.selectedIndex = nextIndex;
  } else if (state.selectedIndex === nextIndex) {
    state.selectedIndex = index;
  }

  const editingIndex = els.editingIndex.value === "" ? -1 : Number(els.editingIndex.value);
  let nextEditingIndex = editingIndex;
  if (editingIndex === index) {
    nextEditingIndex = nextIndex;
  } else if (editingIndex === nextIndex) {
    nextEditingIndex = index;
  }

  render();

  if (nextEditingIndex >= 0) {
    fillEditor(state.places[nextEditingIndex], nextEditingIndex);
  }
}

function startEditing(index) {
  showMenu();
  const place = state.places[index];
  if (!place) {
    return;
  }
  state.selectedIndex = index;
  fillEditor(place, index);
  renderMarkers();
  renderList();
  renderSelectedPanel();
}

function upsertPlace(event) {
  event.preventDefault();
  const lat = Number(els.placeLat.value);
  const lng = Number(els.placeLng.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    alert("地図をクリックするか、緯度経度を入力してください。");
    return;
  }

  const index = els.editingIndex.value === "" ? -1 : Number(els.editingIndex.value);
  const place = normalizePlace({
    title: els.placeTitle.value.trim() || `地点${index >= 0 ? index + 1 : state.places.length + 1}`,
    note: els.placeNote.value.trim(),
    type: els.placeType.value,
    lat,
    lng,
  });

  clearPreviewMarker();

  if (index >= 0) {
    state.places[index] = place;
    state.selectedIndex = index;
    render();
    fillEditor(state.places[index], index);
  } else {
    state.places.push(place);
    state.selectedIndex = state.places.length - 1;
    resetEditor();
    render();
    selectPlace(state.selectedIndex);
  }
}

async function searchPlace(event) {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  if (!query) {
    return;
  }

  const endpoint = new URL("https://nominatim.openstreetmap.org/search");
  endpoint.searchParams.set("format", "jsonv2");
  endpoint.searchParams.set("limit", "1");
  endpoint.searchParams.set("q", query);

  els.searchInput.disabled = true;
  try {
    const response = await fetch(endpoint);
    const results = await response.json();
    if (!results.length) {
      alert("場所が見つかりませんでした。");
      return;
    }

    const first = results[0];
    const editingIndex = els.editingIndex.value;
    const place = editingIndex === ""
      ? normalizePlace({
        title: first.display_name.split(",")[0] || query,
        note: "",
        type: els.placeType.value,
        lat: Number(first.lat),
        lng: Number(first.lon),
      })
      : currentEditorPlace({
        lat: Number(first.lat),
        lng: Number(first.lon),
      });
    fillEditor(place, editingIndex);
    map.setView([place.lat, place.lng], 16);
  } catch (error) {
    alert("検索に失敗しました。時間をおいて再度お試しください。");
    console.error(error);
  } finally {
    els.searchInput.disabled = false;
  }
}

function copyShareLink() {
  const url = shareUrl();
  navigator.clipboard.writeText(url).then(() => {
    els.shareStatus.textContent = "共有URLをコピーしました。";
  }).catch(() => {
    window.prompt("このURLをコピーしてください。", url);
  });
}

map.on("click", (event) => {
  showMenu();
  const editingIndex = els.editingIndex.value;
  const place = editingIndex === ""
    ? {
      title: "",
      note: "",
      type: els.placeType.value,
      lat: event.latlng.lat,
      lng: event.latlng.lng,
    }
    : currentEditorPlace({
      lat: event.latlng.lat,
      lng: event.latlng.lng,
    });
  fillEditor(place, editingIndex);
});

els.placeForm.addEventListener("submit", upsertPlace);
els.searchForm.addEventListener("submit", searchPlace);
els.copyLink.addEventListener("click", copyShareLink);
els.showRoute.addEventListener("change", renderRoute);
els.newPlace.addEventListener("click", resetEditor);
els.resetPanel.addEventListener("click", hideMenu);
[els.placeTitle, els.placeType, els.placeNote, els.placeLat, els.placeLng].forEach((input) => {
  input.addEventListener("input", updatePreviewMarker);
  input.addEventListener("change", updatePreviewMarker);
});
els.editSelectedPlace.addEventListener("click", () => {
  const index = Number(els.editSelectedPlace.dataset.index);
  if (Number.isInteger(index)) {
    startEditing(index);
  }
});

els.placesList.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const index = Number(button.dataset.index);
  const place = state.places[index];
  if (!place) {
    return;
  }

  if (button.dataset.action === "focus") {
    selectPlace(index);
    map.setView([place.lat, place.lng], 16);
    state.markers[index]?.openPopup();
  }

  if (button.dataset.action === "edit") {
    startEditing(index);
  }

  if (button.dataset.action === "move-up") {
    movePlace(index, -1);
  }

  if (button.dataset.action === "move-down") {
    movePlace(index, 1);
  }

  if (button.dataset.action === "delete") {
    state.places.splice(index, 1);
    if (state.selectedIndex === index) {
      state.selectedIndex = null;
      resetEditor();
    } else if (state.selectedIndex > index) {
      state.selectedIndex -= 1;
    }
    render();
  }
});

state.places = loadInitialPlaces();
resetEditor();
render();
fitToPlaces();