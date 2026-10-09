// Vue subjective : avant-bras du parrain et arme tenue en main, dessinés par-dessus la
// scène (tampon de profondeur vidé) avec balancement de marche, recul, coups, rechargement
// et changement d'arme.

import * as THREE from 'three';
import { CharKind, WEAPONS, Weapon } from '../../shared/characters';
import type { Slot } from '../../shared/protocol';
import { clamp } from '../../shared/util';
import * as P from '../characters/parts';
import { appearanceFor, type BossCustom } from '../characters/styles';
import { meshModel } from '../models/modelMesher';
import { SLOT, type VoxelModel } from '../models/voxelModel';
import { envUniforms } from '../render/env';
import { createObjectMaterial } from '../render/voxelObjectMaterial';
import type { PlayerController } from './player';
import type { WeaponSystem } from './weapons';

const VM_FOV = 62;

interface Pose {
  /** Position de la main droite (poignée) dans le repère de la caméra. */
  grip: THREE.Vector3;
  /** Rotation de l'arme (tangage, lacet, roulis). */
  rot: THREE.Euler;
  /** Main gauche : position (ou null si invisible). */
  left: THREE.Vector3 | null;
}

const HIP: Record<Weapon, Pose> = {
  [Weapon.FISTS]: { grip: new THREE.Vector3(0.2, -0.24, -0.42), rot: new THREE.Euler(0.1, 0.1, 0), left: new THREE.Vector3(-0.2, -0.25, -0.4) },
  [Weapon.REVOLVER]: { grip: new THREE.Vector3(0.17, -0.19, -0.42), rot: new THREE.Euler(0.03, 0.06, 0), left: null },
  [Weapon.SHOTGUN]: { grip: new THREE.Vector3(0.15, -0.21, -0.26), rot: new THREE.Euler(0.03, 0.05, 0.02), left: new THREE.Vector3(0.11, -0.19, -0.66) },
  [Weapon.RIFLE]: { grip: new THREE.Vector3(0.15, -0.2, -0.24), rot: new THREE.Euler(0.03, 0.05, 0.02), left: new THREE.Vector3(0.11, -0.18, -0.68) },
  [Weapon.KNIFE]: { grip: new THREE.Vector3(0.2, -0.22, -0.4), rot: new THREE.Euler(0.5, 0.25, -0.3), left: null },
  [Weapon.CLUB]: { grip: new THREE.Vector3(0.2, -0.24, -0.38), rot: new THREE.Euler(0.8, 0.2, -0.25), left: null },
};

const ADS: Partial<Record<Weapon, Pose>> = {
  [Weapon.REVOLVER]: { grip: new THREE.Vector3(0.0, -0.105, -0.36), rot: new THREE.Euler(0, 0, 0), left: new THREE.Vector3(0.02, -0.14, -0.33) },
  [Weapon.SHOTGUN]: { grip: new THREE.Vector3(0.0, -0.1, -0.2), rot: new THREE.Euler(0, 0, 0), left: new THREE.Vector3(0.0, -0.11, -0.6) },
  [Weapon.RIFLE]: { grip: new THREE.Vector3(0.0, -0.095, -0.18), rot: new THREE.Euler(0, 0, 0), left: new THREE.Vector3(0.0, -0.105, -0.62) },
};

/** Extrémité du canon dans le repère du modèle d'arme (m). */
const MUZZLE: Partial<Record<Weapon, THREE.Vector3>> = {
  [Weapon.REVOLVER]: new THREE.Vector3(0, 3 / 32, 10.5 / 32),
  [Weapon.SHOTGUN]: new THREE.Vector3(0, 1.5 / 32, 31 / 32),
  [Weapon.RIFLE]: new THREE.Vector3(0, 1.5 / 32, 36 / 32),
};

const WEAPON_PART: Partial<Record<Weapon, 'revolver' | 'shotgun' | 'rifle' | 'knife' | 'club'>> = {
  [Weapon.REVOLVER]: 'revolver',
  [Weapon.SHOTGUN]: 'shotgun',
  [Weapon.RIFLE]: 'rifle',
  [Weapon.KNIFE]: 'knife',
  [Weapon.CLUB]: 'club',
};

export class Viewmodel {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(VM_FOV, 1, 0.01, 10);
  private root = new THREE.Group();
  private material = createObjectMaterial({ noFog: true, key: 'viewmodel' });
  private armR: THREE.Mesh | null = null;
  private armL: THREE.Mesh | null = null;
  private weaponMeshes = new Map<Weapon, THREE.Mesh>();
  private holder = new THREE.Group();
  private sun = new THREE.DirectionalLight(0xfff1dc, 1.2);
  private current: Weapon = Weapon.REVOLVER;
  private shown: Weapon = Weapon.REVOLVER;
  private look = '';
  // animation
  private phase = 0;
  private bobAmp = 0;
  private sway = new THREE.Vector2();
  private lastYaw = 0;
  private lastPitch = 0;
  private kickT = 0;
  private swingT = 0;
  private switchT = 0;
  private aimT = 0;
  private sprintT = 0;
  private landT = 0;
  private wasGround = true;
  // temporaires
  private grip = new THREE.Vector3();
  private rot = new THREE.Euler();
  private left = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private mainFov = 75;
  private mainAspect = 1;

  constructor() {
    this.scene.add(this.camera);
    this.camera.add(this.root);
    this.root.add(this.holder);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.setLook('dadou', {});
  }

  /** Tenue des manches (couleur du manteau du parrain, personnalisation comprise). */
  setLook(slot: Slot, custom: BossCustom | undefined): void {
    const sig = `${slot}:${JSON.stringify(custom ?? {})}`;
    if (sig === this.look) return;
    this.look = sig;
    const app = appearanceFor(slot === 'dadou' ? CharKind.BOSS_DADOU : CharKind.BOSS_EVEN, slot === 'dadou' ? 1 : 2, 1, 0, custom);
    const o = app.outfit;
    const paint = (m: VoxelModel) => {
      m.recolor(SLOT.COAT, o.coat);
      m.recolor(SLOT.SHIRT, o.shirt);
      m.recolor(SLOT.SKIN, o.skin);
      m.recolor(SLOT.COAT2, o.coat2);
      return m;
    };
    for (const a of [this.armR, this.armL]) {
      if (a) {
        a.geometry.dispose();
        this.root.remove(a);
      }
    }
    // avant-bras un peu plus gros qu'en vue externe (perspective rapprochée)
    const mk = () => {
      const m = paint(P.forearm('coat'));
      // gant de cuir pour Even, main nue pour Dadou
      if (slot === 'even') m.recolor(o.skin, 0x2a2420);
      const mesh = new THREE.Mesh(meshModel(m), this.material);
      mesh.scale.setScalar(1.05);
      mesh.frustumCulled = false;
      this.root.add(mesh);
      return mesh;
    };
    this.armR = mk();
    this.armL = mk();
    if (this.weaponMeshes.size === 0) {
      for (const [w, part] of Object.entries(WEAPON_PART) as [string, 'revolver'][]) {
        const mesh = new THREE.Mesh(meshModel(P.weaponModel(part)), this.material);
        mesh.frustumCulled = false;
        mesh.visible = false;
        this.holder.add(mesh);
        this.weaponMeshes.set(Number(w) as Weapon, mesh);
      }
    }
  }

  kick(n: number): void {
    this.kickT = Math.min(1.6, this.kickT + n);
  }

  swing(): void {
    this.swingT = 1;
  }

  update(dt: number, player: PlayerController, weapons: WeaponSystem, now: number): void {
    // changement d'arme : on baisse puis on relève
    if (weapons.current !== this.current) {
      this.current = weapons.current;
      this.switchT = 1;
    }
    if (this.switchT > 0) {
      this.switchT = Math.max(0, this.switchT - dt * 4.2);
      if (this.switchT < 0.5) this.shown = this.current;
    } else this.shown = this.current;
    const w = this.shown;
    // balancement de marche
    const speed = Math.hypot(player.vel.x, player.vel.z);
    const onGround = player.onGround;
    this.phase += dt * (onGround ? speed * 1.75 : 0);
    this.bobAmp += ((onGround ? clamp(speed / 5, 0, 1.2) : 0) - this.bobAmp) * Math.min(1, dt * 8);
    if (onGround && !this.wasGround) this.landT = 1;
    this.wasGround = onGround;
    this.landT = Math.max(0, this.landT - dt * 4);
    // inertie de visée
    let dy = player.yaw - this.lastYaw;
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    const dp = player.pitch - this.lastPitch;
    this.lastYaw = player.yaw;
    this.lastPitch = player.pitch;
    this.sway.x = clamp(this.sway.x * Math.exp(-dt * 9) + dy * 0.35, -0.06, 0.06);
    this.sway.y = clamp(this.sway.y * Math.exp(-dt * 9) - dp * 0.35, -0.05, 0.05);
    this.kickT *= Math.exp(-dt * 11);
    this.swingT = Math.max(0, this.swingT - dt / 0.34);
    const aiming = player.aiming && !!ADS[w] && !weapons.reloading(now);
    this.aimT += ((aiming ? 1 : 0) - this.aimT) * Math.min(1, dt * 12);
    this.sprintT += ((player.sprint && speed > 3 && !aiming ? 1 : 0) - this.sprintT) * Math.min(1, dt * 7);
    // pose de base (hanche ↔ visée)
    const hip = HIP[w];
    const ads = ADS[w] ?? hip;
    const a = this.aimT;
    this.grip.copy(hip.grip).lerp(ads.grip, a);
    this.rot.set(hip.rot.x + (ads.rot.x - hip.rot.x) * a, hip.rot.y + (ads.rot.y - hip.rot.y) * a, hip.rot.z + (ads.rot.z - hip.rot.z) * a);
    const hasLeft = hip.left !== null || (ads.left !== null && a > 0.5);
    if (hip.left && ads.left) this.left.copy(hip.left).lerp(ads.left, a);
    else if (hip.left) this.left.copy(hip.left);
    else if (ads.left) this.left.copy(ads.left);
    // balancement (réduit en visée)
    const bk = this.bobAmp * (1 - a * 0.85);
    const bx = Math.sin(this.phase) * 0.014 * bk;
    const by = -Math.abs(Math.cos(this.phase)) * 0.016 * bk - this.landT * 0.03;
    // respiration à l'arrêt
    const br = Math.sin(now * 1.6) * 0.0025 * (1 - a);
    const off = new THREE.Vector3(bx + this.sway.x * (1 - a * 0.7), by + br + this.sway.y * (1 - a * 0.7), 0);
    // recul
    off.z += this.kickT * (w === Weapon.SHOTGUN || w === Weapon.RIFLE ? 0.07 : 0.05);
    off.y += this.kickT * 0.012;
    this.rot.x += this.kickT * (w === Weapon.REVOLVER ? 0.34 : 0.16);
    // course : arme baissée et tournée
    off.x += this.sprintT * 0.04;
    off.y -= this.sprintT * 0.06;
    this.rot.y += this.sprintT * 0.55;
    this.rot.x -= this.sprintT * 0.25;
    // rechargement
    if (weapons.reloading(now) && WEAPONS[w].ranged) {
      const dur = WEAPONS[w].reload;
      const t = clamp(1 - (weapons.reloadUntil - now) / dur, 0, 1);
      const k = Math.sin(t * Math.PI);
      off.y -= 0.1 * k;
      off.x -= 0.04 * k;
      this.rot.x -= 0.5 * k;
      this.rot.z += 0.7 * k;
    }
    // changement d'arme
    const sw = Math.sin(this.switchT * Math.PI * 0.5);
    off.y -= sw * 0.32;
    this.rot.x -= sw * 0.6;
    // coup de mêlée : arc de droite à gauche
    if (this.swingT > 0) {
      const t = 1 - this.swingT;
      const k = Math.sin(t * Math.PI);
      if (w === Weapon.FISTS) {
        off.z -= 0.22 * k;
        off.x -= 0.1 * k;
        off.y += 0.04 * k;
      } else {
        off.x -= 0.28 * k;
        off.z -= 0.16 * k;
        off.y += 0.06 * k;
        this.rot.y += 1.1 * k;
        this.rot.z -= 0.6 * k;
      }
    }
    this.grip.add(off);
    // arme
    this.holder.position.copy(this.grip);
    this.holder.rotation.set(this.rot.x, Math.PI + this.rot.y, this.rot.z);
    for (const [k, m] of this.weaponMeshes) m.visible = k === w;
    // bras droit : la main sur la poignée, le coude en arrière, en bas, vers l'extérieur
    if (this.armR) this.placeArm(this.armR, this.grip, new THREE.Vector3(0.38, -0.55, 0.75), 0);
    if (this.armL) {
      this.armL.visible = hasLeft;
      if (hasLeft) {
        const l = this.left.clone().add(off);
        if (w === Weapon.FISTS && this.swingT > 0) l.z += 0.05 * Math.sin((1 - this.swingT) * Math.PI);
        this.placeArm(this.armL, l, new THREE.Vector3(-0.4, -0.55, 0.7), 0);
      }
    }
  }

  /** Oriente l'avant-bras pour que la main soit au point donné. */
  private placeArm(mesh: THREE.Mesh, hand: THREE.Vector3, elbowDir: THREE.Vector3, roll: number): void {
    const dir = elbowDir.clone().normalize();
    // l'origine du modèle est au coude ; la main est à ~0,36 m le long de −Y local
    const len = 0.36 * mesh.scale.y;
    const elbow = hand.clone().addScaledVector(dir, len);
    mesh.position.copy(elbow);
    const toHand = hand.clone().sub(elbow).normalize();
    this.q.setFromUnitVectors(this.v.set(0, -1, 0), toHand);
    mesh.quaternion.copy(this.q);
    if (roll) mesh.rotateY(roll);
  }

  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.camera.position.copy(camera.position);
    this.camera.quaternion.copy(camera.quaternion);
    if (this.camera.aspect !== camera.aspect) {
      this.camera.aspect = camera.aspect;
      this.camera.updateProjectionMatrix();
    }
    this.mainFov = camera.fov;
    this.mainAspect = camera.aspect;
    this.camera.updateMatrixWorld(true);
    // lumière : soleil/lune adoucis, la lumière ambiante vient du volume de lumière
    const night = envUniforms.uNight.value;
    this.sun.intensity = 0.25 + 1.1 * (1 - night);
    this.sun.color.setRGB(1, 0.94 - 0.1 * night, 0.86 + 0.1 * night);
    this.sun.position.copy(camera.position).add(this.v.set(0.4, 1.0, 0.3));
    this.sun.target.position.copy(camera.position);
    this.sun.target.updateMatrixWorld();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = ac;
  }

  /** Position monde de la bouche du canon (pour la flamme), corrigée du champ de vision. */
  muzzleWorld(camera: THREE.PerspectiveCamera): THREE.Vector3 {
    const w = this.shown;
    const tip = MUZZLE[w] ?? new THREE.Vector3(0, 0, 0.3);
    const mesh = this.weaponMeshes.get(w);
    this.root.updateMatrixWorld(true);
    // point dans le repère de la caméra de la vue subjective
    const p = tip.clone();
    if (mesh) {
      mesh.updateMatrix();
      this.holder.updateMatrix();
      p.applyMatrix4(mesh.matrix).applyMatrix4(this.holder.matrix);
    }
    // même position à l'écran avec le champ de vision de la caméra principale
    const k = Math.tan(THREE.MathUtils.degToRad(this.mainFov || camera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(VM_FOV) / 2);
    p.x *= k;
    p.y *= k;
    void this.mainAspect;
    return p.applyMatrix4(camera.matrixWorld);
  }
}
