
import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";

import { GLTFLoader } from "https://unpkg.com/three@0.169.0/examples/jsm/loaders/GLTFLoader.js";

// URLs
const mapUrl = document.querySelector('meta[name="map-url"]').content;
const playerUrl = "./player.glb";

// Loading screen
const loading = document.querySelector("#loading");
const statusText = document.querySelector("#loading-status");
const progressFill = document.querySelector("#bar-fill");
const errorText = document.querySelector("#error");
const hud = document.querySelector("#hud");

// Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x91b9d3);
scene.fog = new THREE.Fog(0x91b9d3, 90, 450);

// Camera
const camera = new THREE.PerspectiveCamera(
  70,
  innerWidth / innerHeight,
  0.1,
  1500
);

// Renderer
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance"
});

renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;

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

// Game objects
const loader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const down = new THREE.Vector3(0, -1, 0);

const mapRoot = new THREE.Group();
scene.add(mapRoot);

let player = null;
let mapMeshes = [];
let groundY = 0;
let playerHeight = 1.5;
let verticalVelocity = 0;
let grounded = false;

let yaw = 0;
let pitch = 0.18;
let lastTime = performance.now();

const movement = { x: 0, y: 0 };
const looking = { x: 0, y: 0 };
const keys = new Set();

const gravity = 22;
const moveSpeed = 6.2;
const jumpSpeed = 8.2;

// Loading helpers
function setLoading(message, percent = 0) {
  statusText.textContent = message;
  progressFill.style.width = `${percent}%`;
}

function showError(error) {
  console.error(error);
  statusText.textContent = "Could not start the game.";
  errorText.hidden = false;

  errorText.textContent =
    "Check that map.glb can be loaded from its host and that player.glb is next to index.html. " +
    (error?.message || String(error));
}

// Fit the player model to approximately 1.5 units tall
function fitPlayerModel(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();

  box.getSize(size);

  if (size.y > 0.0001) {
    root.scale.multiplyScalar(playerHeight / size.y);
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

// Find map meshes for basic ground detection
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

// Basic raycast ground detection.
// This is not full wall collision.
function getGroundHeight(x, z, fallbackY) {
  if (!mapMeshes.length) return fallbackY;

  const origin = new THREE.Vector3(x, fallbackY + 30, z);

  raycaster.set(origin, down);
  raycaster.far = 1000;

  const hits = raycaster.intersectObjects(mapMeshes, false);

  const valid = hits.find(
    (hit) => hit.point.y <= fallbackY + 2.5
  );

  return valid ? valid.point.y : fallbackY;
}

// Set initial player location
function setPlayerStart() {
  if (!player) return;

  const box = new THREE.Box3().setFromObject(mapRoot);

  if (
    Number.isFinite(box.min.x) &&
    Number.isFinite(box.max.x) &&
    box.max.x > box.min.x
  ) {
    player.position.set(
      (box.min.x + box.max.x) / 2,
      box.max.y + 2,
      (box.min.z + box.max.z) / 2
    );
  } else {
    player.position.set(0, 2, 0);
  }

  const y = getGroundHeight(
    player.position.x,
    player.position.z,
    player.position.y
  );

  player.position.y = y + 0.04;
  groundY = y;
}

// Joystick controls
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
    const length = Math.hypot(dx, dy);
    const scale = length > maxRadius ? maxRadius / length : 1;

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

// Jump button
document.querySelector("#jump").addEventListener(
  "pointerdown",
  (event) => {
    event.preventDefault();

    if (grounded) {
      verticalVelocity = jumpSpeed;
      grounded = false;
    }
  }
);

// Keyboard controls for desktop testing
window.addEventListener("keydown", (event) => {
  keys.add(event.code);

  if (
    ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]
      .includes(event.code)
  ) {
    event.preventDefault();
  }

  if (event.code === "Space" && grounded) {
    verticalVelocity = jumpSpeed;
    grounded = false;
  }
}, { passive: false });

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

window.addEventListener("blur", () => keys.clear());

// Read joystick and keyboard input
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

// Update movement and camera
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

    player.position.x += move.x * moveSpeed * dt;
    player.position.z += move.z * moveSpeed * dt;

    player.rotation.y = Math.atan2(move.x, move.z);
  }

  // Gravity and basic ground detection
  const floor = getGroundHeight(
    player.position.x,
    player.position.z,
    groundY
  );

  verticalVelocity -= gravity * dt;
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

  // Third-person camera
  const target = player.position.clone().add(
    new THREE.Vector3(0, playerHeight * 0.72, 0)
  );

  const distance = 5.5;
  const horizontal = Math.cos(pitch) * distance;

  const camOffset = new THREE.Vector3(
    Math.sin(yaw) * horizontal,
    Math.sin(pitch) * distance + 1,
    Math.cos(yaw) * horizontal
  );

  camera.position.lerp(
    target.clone().add(camOffset),
    1 - Math.exp(-8 * dt)
  );

  camera.lookAt(target);
}

// Load map and player
async function loadGame() {
  if (!mapUrl) {
    throw new Error("Map URL missing from index.html.");
  }

  setLoading("Downloading map...", 2);

  const mapGltf = await new Promise((resolve, reject) => {
    loader.load(
      mapUrl,
      resolve,
      (event) => {
        if (event.total > 0) {
          setLoading(
            "Downloading map...",
            2 + (event.loaded / event.total) * 58
          );
        }
      },
      reject
    );
  });

  mapRoot.add(mapGltf.scene);
  mapRoot.updateMatrixWorld(true);

  mapMeshes = collectMapMeshes(mapRoot);

  if (!mapMeshes.length) {
    throw new Error("No map mesh geometry was found.");
  }

  setLoading("Map loaded. Downloading player...", 65);

  const playerGltf = await new Promise((resolve, reject) => {
    loader.load(
      playerUrl,
      resolve,
      (event) => {
        if (event.total > 0) {
          setLoading(
            "Downloading player...",
            65 + (event.loaded / event.total) * 30
          );
        }
      },
      reject
    );
  });

  player = playerGltf.scene;

  fitPlayerModel(player);
  scene.add(player);
  setPlayerStart();

  setLoading("Ready!", 100);

  await new Promise((resolve) => setTimeout(resolve, 250));

  loading.style.display = "none";
  hud.style.display = "block";

  lastTime = performance.now();
  animate();
}

// Main render loop
function animate(now = performance.now()) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updateGame(dt);
  renderer.render(scene, camera);
}

// Resize handling
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(innerWidth, innerHeight);

  renderer.setPixelRatio(
    Math.min(devicePixelRatio || 1, 1.75)
  );
});

// Start
loadGame().catch(showError);
