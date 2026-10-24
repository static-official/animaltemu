import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";
import { GLTFLoader } from "https://unpkg.com/three@0.169.0/examples/jsm/loaders/GLTFLoader.js";

// ======================================================
// CONFIGURATION
// ======================================================

const MAP_URL =
  document.querySelector('meta[name="map-url"]')?.content;

const PLAYER_URL = "./player.glb";

const PLAYER_HEIGHT = 1.5;
const MOVE_SPEED = 6.2;
const JUMP_SPEED = 8.2;
const GRAVITY = 22;
const CAMERA_DISTANCE = 5.5;

// ======================================================
// UI
// ======================================================

const loading = document.querySelector("#loading");
const statusText = document.querySelector("#loading-status");
const progressFill = document.querySelector("#bar-fill");
const errorText = document.querySelector("#error");
const hud = document.querySelector("#hud");

function setLoading(message, percent = 0) {
  if (statusText) statusText.textContent = message;
  if (progressFill) {
    progressFill.style.width = `${THREE.MathUtils.clamp(percent, 0, 100)}%`;
  }
}

function showError(error) {
  console.error("Game loading failed:", error);

  if (statusText) {
    statusText.textContent = "Could not start the game.";
  }

  if (errorText) {
    errorText.hidden = false;
    errorText.textContent =
      `${error?.message || String(error)}. ` +
      "Check that map.glb and player.glb are in your root folder.";
  }
}

// ======================================================
// THREE.JS SCENE
// ======================================================

const scene = new THREE.Scene();

scene.background = new THREE.Color(0x91b9d3);
scene.fog = new THREE.Fog(0x91b9d3, 90, 450);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  1500
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance"
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

document.body.appendChild(renderer.domElement);

// Lighting
scene.add(
  new THREE.HemisphereLight(0xe5f4ff, 0x59604c, 2)
);

const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(30, 70, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

// ======================================================
// GAME STATE
// ======================================================

const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);

const mapRoot = new THREE.Group();
scene.add(mapRoot);

let player = null;
let mapMeshes = [];

let groundY = 0;
let verticalVelocity = 0;
let grounded = false;

let yaw = 0;
let pitch = 0.18;
let lastTime = performance.now();

const movement = { x: 0, y: 0 };
const looking = { x: 0, y: 0 };
const keys = new Set();

// ======================================================
// MAP DOWNLOADER
// ======================================================

async function downloadMap(url) {
  if (!url) {
    throw new Error("No map URL was found in index.html.");
  }

  setLoading("Connecting to map host...", 0);

  let response;

  try {
    response = await fetch(url, {
      method: "GET",
      mode: "cors",
      redirect: "follow"
    });
  } catch (error) {
    throw new Error(
      "Could not access map.glb. Ensure the file is pushed to your repository. " +
      (error?.message || "")
    );
  }

  if (!response.ok) {
    throw new Error(`Map server returned HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") || "";
  const contentLength = Number(
    response.headers.get("content-length")
  ) || 0;

  let buffer;

  if (response.body && response.body.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const result = await reader.read();

      if (result.done) break;

      chunks.push(result.value);
      received += result.value.byteLength;

      if (contentLength > 0) {
        const percent = Math.min(
          60,
          Math.round((received / contentLength) * 60)
        );

        setLoading(
          `Downloading map: ${(received / 1048576).toFixed(1)} MB`,
          percent
        );
      } else {
        setLoading(
          `Downloading map: ${(received / 1048576).toFixed(1)} MB`,
          0
        );
      }
    }

    const combined = new Uint8Array(received);
    let offset = 0;

    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    buffer = combined.buffer;
  } else {
    setLoading("Downloading map...", 10);
    buffer = await response.arrayBuffer();
  }

  if (buffer.byteLength < 12) {
    throw new Error("The downloaded map is empty or incomplete.");
  }

  const magic = new TextDecoder().decode(
    new Uint8Array(buffer, 0, 4)
  );

  if (magic !== "glTF") {
    throw new Error(
      "The map file is not a valid GLB file. " +
      `Received content type: ${contentType || "unknown"}.`
    );
  }

  return buffer;
}

// ======================================================
// LOAD AND PREPARE MAP
// ======================================================

function collectMapMeshes(root) {
  const meshes = [];

  root.updateMatrixWorld(true);

  root.traverse((object) => {
    if (!object.isMesh || !object.geometry) return;

    object.castShadow = true;
    object.receiveShadow = true;

    meshes.push(object);
  });

  return meshes;
}

async function loadMap() {
  const buffer = await downloadMap(MAP_URL);

  setLoading("Parsing map geometry...", 62);

  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buffer, "", resolve, reject);
  });

  mapRoot.add(gltf.scene);
  mapRoot.updateMatrixWorld(true);

  mapMeshes = collectMapMeshes(mapRoot);

  if (mapMeshes.length === 0) {
    throw new Error("The map loaded, but it contains no renderable meshes.");
  }

  console.log(
    `Map loaded: ${mapMeshes.length} mesh objects, ` +
    `${(buffer.byteLength / 1048576).toFixed(1)} MB`
  );

  setLoading("Map loaded!", 68);
}

// ======================================================
// LOAD PLAYER
// ======================================================

function preparePlayer(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();

  box.getSize(size);

  if (size.y > 0.0001) {
    root.scale.multiplyScalar(PLAYER_HEIGHT / size.y);
  }

  const scaledBox = new THREE.Box3().setFromObject(root);
  root.position.y -= scaledBox.min.y;

  root.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
}

async function loadPlayer() {
  setLoading("Downloading player model...", 70);

  const gltf = await new Promise((resolve, reject) => {
    loader.load(
      PLAYER_URL,
      resolve,
      (event) => {
        if (event.total > 0) {
          setLoading(
            "Downloading player model...",
            70 + (event.loaded / event.total) * 25
          );
        }
      },
      reject
    );
  });

  player = gltf.scene;

  preparePlayer(player);
  scene.add(player);

  console.log("Player model loaded.");
}

// ======================================================
// GROUND DETECTION
// ======================================================

function getGroundHeight(x, z, fallbackY) {
  if (mapMeshes.length === 0) return fallbackY;

  const origin = new THREE.Vector3(x, fallbackY + 30, z);

  raycaster.set(origin, down);
  raycaster.far = 1000;

  const hits = raycaster.intersectObjects(mapMeshes, false);

  const hit = hits.find(
    (item) => item.point.y <= fallbackY + 2.5
  );

  return hit ? hit.point.y : fallbackY;
}

function setPlayerStart() {
  if (!player) return;

  const bounds = new THREE.Box3().setFromObject(mapRoot);

  if (
    Number.isFinite(bounds.min.x) &&
    Number.isFinite(bounds.max.x) &&
    bounds.max.x > bounds.min.x
  ) {
    player.position.set(
      (bounds.min.x + bounds.max.x) / 2,
      bounds.max.y + 2,
      (bounds.min.z + bounds.max.z) / 2
    );
  } else {
    player.position.set(0, 2, 0);
  }

  const floor = getGroundHeight(
    player.position.x,
    player.position.z,
    player.position.y
  );

  player.position.y = floor + 0.04;
  groundY = floor;
}

// ======================================================
// MOBILE JOYSTICKS
// ======================================================

function makeJoystick(element, output) {
  const knob = element.querySelector(".knob");

  let pointerId = null;
  let centerX = 0;
  let centerY = 0;
  let maxRadius = 36;

  function reset() {
    output.x = 0;
    output.y = 0;

    knob.style.transform = "translate(0px, 0px)";
    pointerId = null;
  }

  function update(event) {
    if (pointerId !== event.pointerId) return;

    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;

    const distance = Math.hypot(dx, dy);
    const scale = distance > maxRadius
      ? maxRadius / distance
      : 1;

    const x = dx * scale;
    const y = dy * scale;

    output.x = x / maxRadius;
    output.y = y / maxRadius;

    knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();

    pointerId = event.pointerId;
    element.setPointerCapture(pointerId);

    const rect = element.getBoundingClientRect();

    centerX = rect.left + rect.width / 2;
    centerY = rect.top + rect.height / 2;
    maxRadius = rect.width * 0.27;

    update(event);
  });

  element.addEventListener("pointermove", update);

  element.addEventListener("pointerup", (event) => {
    if (pointerId === event.pointerId) reset();
  });

  element.addEventListener("pointercancel", (event) => {
    if (pointerId === event.pointerId) reset();
  });
}

makeJoystick(
  document.querySelector("#move-stick"),
  movement
);

makeJoystick(
  document.querySelector("#look-stick"),
  looking
);

// ======================================================
// JUMP BUTTON
// ======================================================

document.querySelector("#jump").addEventListener(
  "pointerdown",
  (event) => {
    event.preventDefault();

    if (grounded) {
      verticalVelocity = JUMP_SPEED;
      grounded = false;
    }
  }
);

// ======================================================
// KEYBOARD CONTROLS
// ======================================================

window.addEventListener("keydown", (event) => {
  keys.add(event.code);

  if (
    ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
      .includes(event.code)
  ) {
    event.preventDefault();
  }

  if (event.code === "Space" && grounded) {
    verticalVelocity = JUMP_SPEED;
    grounded = false;
  }
}, { passive: false });

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("blur", () => {
  keys.clear();
});

// ======================================================
// MOVEMENT INPUT
// ======================================================

function getInput() {
  let x = movement.x;
  let y = movement.y;

  if (keys.has("KeyA") || keys.has("ArrowLeft")) x -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) x += 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) y -= 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) y += 1;

  const length = Math.hypot(x, y);

  if (length > 1) {
    x /= length;
    y /= length;
  }

  return { x, y };
}

// ======================================================
// GAME UPDATE
// ======================================================

function updateGame(dt) {
  if (!player) return;

  yaw -= looking.x * dt * 2.4;

  pitch = THREE.MathUtils.clamp(
    pitch - looking.y * dt * 1.8,
    -0.45,
    0.85
  );

  const input = getInput();

  const forward = new THREE.Vector3(
    -Math.sin(yaw), 0, -Math.cos(yaw)
  );

  const right = new THREE.Vector3(
    Math.cos(yaw), 0, -Math.sin(yaw)
  );

  const move = new THREE.Vector3()
    .addScaledVector(forward, -input.y)
    .addScaledVector(right, input.x);

  if (move.lengthSq() > 0.0001) {
    move.normalize();

    player.position.x += move.x * MOVE_SPEED * dt;
    player.position.z += move.z * MOVE_SPEED * dt;

    player.rotation.y = Math.atan2(move.x, move.z);
  }

  const floor = getGroundHeight(
    player.position.x,
    player.position.z,
    groundY
  );

  verticalVelocity -= GRAVITY * dt;
  player.position.y += verticalVelocity * dt;

  if (
    player.position.y <= floor + 0.04 &&
    verticalVelocity <= 0
  ) {
    player.position.y = floor + 0.04;
    verticalVelocity = 0;
    grounded = true;
    groundY = floor;
  } else {
    grounded = false;
  }

  const target = player.position.clone().add(
    new THREE.Vector3(0, PLAYER_HEIGHT * 0.72, 0)
  );

  const horizontal = Math.cos(pitch) * CAMERA_DISTANCE;

  const cameraOffset = new THREE.Vector3(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * CAMERA_DISTANCE + 1,
    Math.cos(yaw) * horizontal
  );

  camera.position.lerp(
    target.clone().add(cameraOffset),
    1 - Math.exp(-8 * dt)
  );

  camera.lookAt(target);
}

// ======================================================
// RENDER LOOP
// ======================================================

function animate(now = performance.now()) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updateGame(dt);
  renderer.render(scene, camera);
}

// ======================================================
// WINDOW RESIZE
// ======================================================

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(window.innerWidth, window.innerHeight);

  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio || 1, 1.75)
  );
});

// ======================================================
// START GAME
// ======================================================

async function startGame() {
  try {
    await loadMap();
    await loadPlayer();

    setLoading("Setting up game...", 98);
    setPlayerStart();

    setLoading("Ready!", 100);

    await new Promise((resolve) => setTimeout(resolve, 250));

    loading.style.display = "none";
    hud.style.display = "block";

    lastTime = performance.now();
    animate();
  } catch (error) {
    showError(error);
  }
}

startGame();
