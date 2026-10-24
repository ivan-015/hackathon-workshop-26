// Wireframe gear train behind the links page: meshing gears that turn with
// time and lean toward the pointer. Fails quietly without WebGL.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
const INK = 0x050f16;
const MODULE = 0.25; // tooth size shared by every gear so they mesh
const DEPTH = 0.45;
const TOOTH_CENTER = 0.425; // tooth midpoint as a fraction of one tooth step

function gearShape(THREE, teeth) {
  const pitch = (teeth * MODULE) / 2;
  const tip = pitch + MODULE;
  const root = pitch - MODULE * 1.2;
  const step = (Math.PI * 2) / teeth;
  const at = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];

  const shape = new THREE.Shape();
  shape.moveTo(...at(root, 0));
  for (let i = 0; i < teeth; i += 1) {
    const a = i * step;
    shape.lineTo(...at(root, a + step * 0.1));
    shape.lineTo(...at(tip, a + step * 0.3));
    shape.lineTo(...at(tip, a + step * 0.55));
    shape.lineTo(...at(root, a + step * 0.75));
    shape.lineTo(...at(root, a + step));
  }

  const axle = new THREE.Path();
  axle.absarc(0, 0, pitch * 0.18, 0, Math.PI * 2, true);
  shape.holes.push(axle);

  const windows = teeth > 14 ? 6 : 4;
  for (let i = 0; i < windows; i += 1) {
    const [x, y] = at(pitch * 0.55, (i / windows) * Math.PI * 2);
    const hole = new THREE.Path();
    hole.absarc(x, y, pitch * 0.17, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return { shape, pitch };
}

function makeGear(THREE, teeth, opacity) {
  const { shape, pitch } = gearShape(THREE, teeth);
  const solid = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false, curveSegments: 20 });
  solid.translate(0, 0, -DEPTH / 2);
  const edges = new THREE.EdgesGeometry(solid, 20);
  solid.dispose();
  const material = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity });
  return { mesh: new THREE.LineSegments(edges, material), pitch, teeth };
}

// Places `gear` touching `anchor` at `angle`, with a phase that interlocks teeth.
function meshWith(anchor, gear, angle) {
  const distance = anchor.pitch + gear.pitch;
  gear.mesh.position.set(
    anchor.mesh.position.x + Math.cos(angle) * distance,
    anchor.mesh.position.y + Math.sin(angle) * distance,
    0,
  );
  const speed = anchor.teeth / gear.teeth;
  gear.phase = angle * (1 + speed) + Math.PI
    - ((Math.PI * 2) / gear.teeth) * (0.5 + 2 * TOOTH_CENTER)
    - anchor.phase * speed;
  gear.ratio = -anchor.ratio * speed;
  return gear;
}

function buildTrain(THREE) {
  const drive = makeGear(THREE, 28, 0.8);
  drive.ratio = 1;
  drive.phase = 0;
  const gears = [
    drive,
    meshWith(drive, makeGear(THREE, 12, 0.8), Math.PI * 0.82),
    meshWith(drive, makeGear(THREE, 18, 0.7), Math.PI * 1.55),
  ];
  gears.push(meshWith(gears[2], makeGear(THREE, 10, 0.6), Math.PI * 1.15));

  const group = new THREE.Group();
  gears.forEach((g) => group.add(g.mesh));
  return { group, gears };
}

async function start(canvas) {
  const THREE = await import(THREE_URL);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.z = 16;

  const { group, gears } = buildTrain(THREE);
  scene.add(group);

  const base = { x: 0, y: 0 };
  const resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const narrow = w < 860;
    // Centre the train behind the phone column on wide screens.
    base.x = narrow ? 1.2 : camera.aspect * 4.4;
    base.y = narrow ? 1.5 : -0.8;
    group.scale.setScalar(narrow ? 0.75 : 1.25);
  };
  resize();
  addEventListener('resize', resize);

  const pointer = { x: 0, y: 0 };
  const lean = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / innerWidth) * 2 - 1;
    pointer.y = (e.clientY / innerHeight) * 2 - 1;
  }, { passive: true });

  const render = (time) => {
    const turn = reduce ? 0 : time * 0.00018;
    gears.forEach((g) => { g.mesh.rotation.z = g.phase + turn * g.ratio; });

    lean.x += (pointer.x - lean.x) * 0.05;
    lean.y += (pointer.y - lean.y) * 0.05;
    group.position.set(base.x + lean.x * 0.6, base.y - lean.y * 0.4, 0);
    group.rotation.set(-0.55 + lean.y * 0.25, -0.5 + lean.x * 0.35, 0.15);

    renderer.render(scene, camera);
  };

  if (reduce) {
    render(0);
    addEventListener('resize', () => render(0));
    return;
  }
  renderer.setAnimationLoop(render);
}

const canvas = document.querySelector('.gears');
if (canvas) {
  start(canvas).catch((err) => {
    canvas.remove();
    console.warn('Gear background disabled:', err);
  });
}
