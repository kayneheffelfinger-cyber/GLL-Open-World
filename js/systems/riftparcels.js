// ====================================================================
// js/systems/riftparcels.js — v2.103 RIFT PARCELS: the Capital Rift
// owned-parcel marking. An owned sidewalk spot already flips to sand-gold
// with a white house icon (v2.71); this adds the reference's other two
// cues: a solid gold frame hugging the parcel edge, and a small dark
// "YOURS" tag. Purely additive: it wraps CITY.setPlotOwned, touches no
// other file's logic, and every step is try/caught so a mistake here can
// never reach the world. window.RIFTPARCELS is the QA surface.
// ====================================================================
import * as THREE from 'three';
import { CITY } from '../world/city.js';

const GOLD = 0xf5cc74;
let _tagMat = null, _frameMat = null;
const _frameGeo = new Map();

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// the small dark pill with gold text — shared by every owned parcel
function tagMaterial() {
  if (_tagMat) return _tagMat;
  const W = 256, H = 64;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  roundRectPath(ctx, 6, 10, W - 12, H - 20, 14);
  ctx.fillStyle = 'rgba(20,25,35,.94)'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(245,204,116,.85)'; ctx.stroke();
  ctx.font = '800 25px system-ui, -apple-system, Segoe UI, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f5cc74';
  const word = 'YOURS', gap = 3;           // manual letter-spacing (works in every browser)
  let total = 0; const ws = [];
  for (const ch of word) { const w = ctx.measureText(ch).width; ws.push(w); total += w + gap; }
  let x = W / 2 - (total - gap) / 2;
  for (let i = 0; i < word.length; i++) { ctx.textAlign = 'left'; ctx.fillText(word[i], x, H / 2 + 1); x += ws[i] + gap; }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _tagMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  return _tagMat;
}

// a flat gold frame (outer rect minus inner rect), laid on the ground
function frameGeometry(w, d, t) {
  const key = w + 'x' + d + 'x' + t;
  if (_frameGeo.has(key)) return _frameGeo.get(key);
  const sh = new THREE.Shape();
  sh.moveTo(-w / 2, -d / 2); sh.lineTo(w / 2, -d / 2); sh.lineTo(w / 2, d / 2); sh.lineTo(-w / 2, d / 2); sh.closePath();
  const iw = w / 2 - t, id = d / 2 - t;
  const hole = new THREE.Path();
  hole.moveTo(-iw, -id); hole.lineTo(-iw, id); hole.lineTo(iw, id); hole.lineTo(iw, -id); hole.closePath();
  sh.holes.push(hole);
  const g = new THREE.ShapeGeometry(sh);
  g.rotateX(-Math.PI / 2);
  _frameGeo.set(key, g);
  return g;
}

// add the frame + tag to one owned parcel record (idempotent)
function decorate(rec) {
  if (!rec || rec.yoursFrame || !rec.icon || !rec.icon.parent) return false;
  const layer = rec.icon.parent;            // the city-local plot layer the house icon already rides
  const AX = rec.x - rec.icon.position.x;   // recover the layer offset the same way setPlotOwned used it
  const AZ = rec.z - rec.icon.position.z;
  if (!_frameMat) _frameMat = new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: .95, side: THREE.DoubleSide, depthWrite: false });
  const w = (rec.w || 15) - .4, d = (rec.d || 20) - .4;
  const frame = new THREE.Mesh(frameGeometry(w, d, .5), _frameMat);
  frame.position.set(rec.x - AX, .23, rec.z - AZ);
  frame.rotation.y = rec.rot || 0;
  frame.renderOrder = 2;
  layer.add(frame);
  const tag = new THREE.Sprite(tagMaterial());
  tag.scale.set(5.6, 1.4, 1);
  tag.position.set(rec.x - AX, 1.3, rec.z - AZ);
  layer.add(tag);
  rec.yoursFrame = frame; rec.yoursTag = tag;
  return true;
}

// wrap CITY.setPlotOwned once; also catch up any parcel that flipped before this loaded
let installed = false;
function install() {
  if (installed) return;
  const orig = CITY.setPlotOwned;
  if (typeof orig !== 'function' || orig.__riftParcels) return;
  const wrapped = function (rec) {
    const out = orig.apply(this, arguments);
    try { decorate(rec); } catch (e) { console.warn('[riftparcels]', e); }
    return out;
  };
  wrapped.__riftParcels = true;
  CITY.setPlotOwned = wrapped;
  installed = true;
  try { for (const rec of (CITY.plots || [])) if (rec.sold && rec.icon) decorate(rec); } catch (e) { }
}
try { install(); } catch (e) { console.warn('[riftparcels] not installed', e); }

export const RIFTPARCELS = { decorate, installed: () => installed };
window.RIFTPARCELS = RIFTPARCELS;   // QA surface
