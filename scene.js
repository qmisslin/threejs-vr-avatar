
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Avatar } from './avatar.js';
import { Player } from './player.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const DEG = 180 / Math.PI;
const DEADZONE = 0.18;

export class Scene {
  constructor({
    avatarUrl = './avatar.fbx',
    animationUrls = {
      walk: './walk.fbx',
      idle: './idle.fbx'
    },
    characterHeight = 1.8,
    capsuleHeight = 1.8,
    capsuleRadius = 0.3,
    capsuleYaw = 0,
    minCrouch = 0,
    maxCrouch = 0.5,
    desktopCameraForwardOffset = 0.35
  } = {}) {
    this.avatarUrl = avatarUrl;
    this.animationUrls = animationUrls;

    this.viewport = document.getElementById('viewport');
    this.sidebar = document.getElementById('sidebar');
    this.controlsContainer =
      document.getElementById('controls');

    this.modeButtons = {
      debug: document.getElementById('mode-debug'),
      desktop: document.getElementById('mode-desktop'),
      vr: document.getElementById('mode-vr')
    };

    this.modeHint =
      document.getElementById('mode-hint');

    // Scene and cameras.

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x202020);

    this.debugCamera = new THREE.PerspectiveCamera(
      45, 1, 0.01, 100
    );

    this.debugCamera.position.set(
      2.8, 1.8, 3.5
    );

    this.gameCamera = new THREE.PerspectiveCamera(
      65, 1, 0.16, 100
    );

    // Renderer and WebXR.

    this.renderer = new THREE.WebGLRenderer({
      antialias: true
    });

    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, 2)
    );

    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.viewport.appendChild(
      this.renderer.domElement
    );

    // Lights and grid.

    this.scene.add(
      new THREE.HemisphereLight(
        0xffffff,
        0x555555,
        2
      )
    );

    const light = new THREE.DirectionalLight(
      0xffffff,
      2
    );

    light.position.set(3, 6, 4);
    this.scene.add(light);

    this.grid = new THREE.GridHelper(
      20, 20, 0x777777, 0x444444
    );

    this.grid.position.y = -0.004;
    this.scene.add(this.grid);

    // Debug OrbitControls.

    this.orbit = new OrbitControls(
      this.debugCamera,
      this.renderer.domElement
    );

    this.orbit.target.set(0, 0.95, 0);
    this.orbit.enableDamping = true;
    this.orbit.update();

    // Avatar and player.

    this.avatar = new Avatar({
      height: characterHeight,
      minCrouch,
      maxCrouch
    });

    this.player = new Player({
      avatar: this.avatar,
      height: capsuleHeight,
      radius: capsuleRadius,
      yaw: capsuleYaw
    });

    this.scene.add(this.player);

    // VR tracking space.

    this.xrRig = new THREE.Group();
    this.xrRig.name = 'XRTrackingRig';
    this.scene.add(this.xrRig);

    // Game mode state.

    this.mode = 'debug';
    this.previousFlatMode = 'debug';
    this.pendingExitMode = null;
    this.savedDebugState = null;

    // Desktop controls.

    this.keys = new Set();
    this.desktopPitch = 0;

    // Positive Z places the camera in front of the avatar.
    this.desktopCameraForwardOffset =
      desktopCameraForwardOffset;

    this.desktopCameraNear = 0.35;
    this.vrCameraNear = 0.16;

    this.mouseSensitivity = 0.002;
    this.walkSpeed = 2.2;

    // VR movement.

    this.vrWalkSpeed = 2.0;
    this.vrTurnSpeed = 1.7;

    this.ui = {};

    // Reusable XR transforms.

    this.headLocal = new THREE.Vector3();
    this.headWorld = new THREE.Vector3();

    this.beforeTurn = new THREE.Vector3();
    this.afterTurn = new THREE.Vector3();

    this.trackedPosition = new THREE.Vector3();
    this.trackedQuaternion = new THREE.Quaternion();
    this.rigQuaternion = new THREE.Quaternion();

    this.headEuler = new THREE.Euler(
      0, 0, 0, 'YXZ'
    );

    this.moveForward = new THREE.Vector3();
    this.moveRight = new THREE.Vector3();

    // Timer and events.

    this.timer = new THREE.Timer();
    this.timer.connect(document);

    this.installInputListeners();
    this.installModeButtons();
    this.checkVRSupport();

    window.addEventListener(
      'resize',
      () => this.resize()
    );

    this.resize();
  }

  // --------------------------------------------------
  // Loading
  // --------------------------------------------------

  async start() {
    this.renderer.setAnimationLoop(
      (_, frame) => this.animate(frame)
    );

    const loader = new FBXLoader();
    const entries = Object.entries(this.animationUrls);

    const [model, ...sources] = await Promise.all([
      loader.loadAsync(this.avatarUrl),
      ...entries.map(([, url]) =>
        loader.loadAsync(url)
      )
    ]);

    const animations = Object.fromEntries(
      entries.map(([name], i) => [
        name,
        sources[i]
      ])
    );

    // Initialize the avatar before restoring capsule scale.

    this.player.origin.scale.setScalar(1);
    this.player.origin.updateWorldMatrix(true, true);

    this.avatar.initialize(
      this.player.origin,
      model,
      animations
    );

    this.player.applyDimensions();
    this.player.setHeadOverride(true);

    this.player.setEyesRotation({
      x: 0,
      y: 0,
      z: 0
    });

    this.buildControls();
    this.activateModeUI();
    this.resize();
  }

  // --------------------------------------------------
  // Mode buttons
  // --------------------------------------------------

  installModeButtons() {
    this.modeButtons.debug.addEventListener(
      'click',
      () => this.setMode('debug')
    );

    this.modeButtons.desktop.addEventListener(
      'click',
      () => {
        this.setMode('desktop');
        this.requestPointerLock();
      }
    );

    this.modeButtons.vr.addEventListener(
      'click',
      () => this.setMode('vr')
    );
  }

  async checkVRSupport() {
    const button = this.modeButtons.vr;

    button.disabled = true;
    button.title = 'Checking immersive VR support';

    if (
      !navigator.xr ||
      !window.isSecureContext
    ) {
      button.title =
        'WebXR requires HTTPS or localhost and a compatible browser';
      return;
    }

    try {
      const supported =
        await navigator.xr.isSessionSupported(
          'immersive-vr'
        );

      button.disabled = !supported;

      button.title = supported
        ? 'Enter immersive VR'
        : 'Immersive VR unavailable';

    } catch (error) {
      button.title =
        'Could not determine immersive VR support';

      console.warn(error);
    }
  }

  // --------------------------------------------------
  // Debug state persistence
  // --------------------------------------------------

  saveDebugState() {
    if (this.savedDebugState) return;

    const state = this.player.getControlState();

    this.savedDebugState = {
      ik: {
        ...state.ik
      },

      view: {
        ...state.view
      },

      eyes: {
        ...state.eyes.rotation
      },

      eyeY: state.eyes.position.y,
      headOverride: state.eyes.headOverride,

      animation: {
        name: state.animation.current,
        playing: state.animation.playing
      },

      hands: Object.fromEntries(
        ['left', 'right'].map(side => [
          side,
          {
            position:
              this.avatar.handTargets[side]
                .position.clone(),

            quaternion:
              this.avatar.handTargets[side]
                .quaternion.clone()
          }
        ])
      )
    };
  }

  restoreDebugState() {
    if (!this.savedDebugState) return;

    const state = this.savedDebugState;

    for (const side of ['left', 'right']) {
      this.avatar.setArmIKEnabled(
        side,
        state.ik[side]
      );

      this.avatar.handTargets[side].position.copy(
        state.hands[side].position
      );

      this.avatar.handTargets[side].quaternion.copy(
        state.hands[side].quaternion
      );
    }

    this.avatar.setDisplayTransforms(
      state.view.displayTransforms
    );

    this.avatar.setDisplaySkeleton(
      state.view.displaySkeleton
    );

    this.player.setDisplayCapsule(
      state.view.displayCapsule
    );

    this.player.setEyesRotation(state.eyes);

    this.player.setEyesPosition({
      y: state.eyeY
    });

    this.player.setHeadOverride(
      state.headOverride
    );

    this.avatar.setAnimation(
      state.animation.name
    );

    this.avatar.setPlaying(
      state.animation.playing
    );

    this.savedDebugState = null;
  }

  setGameplayAppearance() {
    this.avatar.setDisplayTransforms(false);
    this.avatar.setDisplaySkeleton(false);
    this.player.setDisplayCapsule(false);
    this.player.setHeadOverride(true);
  }

  activateModeUI() {
    this.sidebar.classList.toggle(
      'is-hidden',
      this.mode !== 'debug'
    );

    for (
      const [mode, button] of
      Object.entries(this.modeButtons)
    ) {
      button.classList.toggle(
        'active',
        mode === this.mode
      );

      button.setAttribute(
        'aria-pressed',
        String(mode === this.mode)
      );
    }

    this.resize();
  }

  setHint(text) {
    this.modeHint.textContent = text;
  }

  // --------------------------------------------------
  // Mode transitions
  // --------------------------------------------------

  setMode(mode) {
    if (mode === 'vr') {
      if (this.mode !== 'vr') {
        this.enterVR();
      }

      return;
    }

    if (this.renderer.xr.isPresenting) {
      this.pendingExitMode = mode;

      this.renderer.xr.getSession()
        ?.end()
        .catch(console.error);

      return;
    }

    this.activateFlatMode(mode);
  }

  activateFlatMode(mode) {
    if (
      this.mode === 'debug' &&
      mode !== 'debug'
    ) {
      this.saveDebugState();
    }

    this.keys.clear();

    if (
      mode !== 'desktop' &&
      document.pointerLockElement ===
      this.renderer.domElement
    ) {
      document.exitPointerLock();
    }

    this.mode = mode;
    this.orbit.enabled = mode === 'debug';

    if (mode === 'debug') {
      this.restoreDebugState();

      const offset = this.debugCamera.position
        .clone()
        .sub(this.orbit.target);

      this.orbit.target.set(
        this.player.position.x,
        this.player.capsuleHeight * 0.55,
        this.player.position.z
      );

      this.debugCamera.position
        .copy(this.orbit.target)
        .add(offset);

      this.orbit.update();
      this.buildControls();

      this.setHint(
        'Debug: orbit with the mouse, edit settings in the sidebar.'
      );

    } else if (mode === 'desktop') {
      this.setGameplayAppearance();

      this.avatar.setArmIKEnabled('left', false);
      this.avatar.setArmIKEnabled('right', false);

      this.player.setEyesPosition({
        y: this.player.getNeutralEyeY()
      });

      this.desktopPitch = 0;

      this.player.setEyesRotation({
        x: 0,
        y: 0,
        z: 0
      });

      // First-person camera follows Player, not Head.
      this.player.add(this.gameCamera);

      this.updateDesktopCameraPosition();

      // Clip avatar geometry too close to the FPS camera.
      this.gameCamera.near = this.desktopCameraNear;
      this.gameCamera.updateProjectionMatrix();

      // FBX avatar faces +Z; Three.js camera faces -Z.
      this.gameCamera.rotation.set(
        0, Math.PI, 0, 'YXZ'
      );

      this.avatar.setPlaying(true);
      this.updateLocomotionAnimation(false);

      this.setHint(
        'Desktop: click viewport to lock mouse · ZQSD/WASD or arrows · Shift crouch · Esc unlock'
      );
    }

    this.activateModeUI();
  }

  // --------------------------------------------------
  // Desktop camera offset
  // --------------------------------------------------

  updateDesktopCameraPosition() {
    // The camera remains in Player-local coordinates.
    // Moving the player or turning its yaw moves it too.
    // The Z offset avoids placing the camera inside the face.

    this.gameCamera.position.set(
      0,
      this.player.eyeY,
      this.desktopCameraForwardOffset
    );
  }

  // --------------------------------------------------
  // Locomotion animations
  // --------------------------------------------------

  updateLocomotionAnimation(walking) {
    const name = walking ? 'walk' : 'idle';

    if (this.avatar.currentAnimation !== name) {
      this.avatar.setAnimation(name);
    }
  }

  // --------------------------------------------------
  // VR session
  // --------------------------------------------------

  async enterVR() {
    if (
      !navigator.xr ||
      this.renderer.xr.isPresenting
    ) {
      return;
    }

    const flatMode = this.mode === 'vr'
      ? this.previousFlatMode
      : this.mode;

    let session;

    try {
      session = await navigator.xr.requestSession(
        'immersive-vr',
        {
          requiredFeatures: ['local-floor']
        }
      );
    } catch (error) {
      this.setHint(
        `Unable to start VR: ${error.message}`
      );

      console.warn(error);
      return;
    }

    try {
      if (this.mode === 'debug') {
        this.saveDebugState();
      }

      this.previousFlatMode = flatMode;
      this.keys.clear();

      if (
        document.pointerLockElement ===
        this.renderer.domElement
      ) {
        document.exitPointerLock();
      }

      this.orbit.enabled = false;
      this.setGameplayAppearance();

      // VR uses its own tracking rig, with no Desktop offset.
      this.gameCamera.rotation.set(0, 0, 0);
      this.gameCamera.position.set(0, 0, 0);
      this.xrRig.add(this.gameCamera);

      this.xrRig.position.set(
        this.player.position.x,
        0,
        this.player.position.z
      );

      this.xrRig.rotation.y =
        this.player.rotation.y;

      this.xrRig.updateWorldMatrix(true, true);

      // Restore the shorter clipping distance for immersive VR.
      this.gameCamera.near = this.vrCameraNear;
      this.gameCamera.updateProjectionMatrix();

      await this.renderer.xr.setSession(session);

      this.avatar.setPlaying(true);
      this.updateLocomotionAnimation(false);

      this.mode = 'vr';
      this.activateModeUI();

      this.setHint(
        'VR: left stick move · right stick turn · headset/controller tracking'
      );

      session.addEventListener(
        'end',
        () => {
          const next =
            this.pendingExitMode ||
            this.previousFlatMode;

          this.pendingExitMode = null;
          this.activateFlatMode(next);
        },
        { once: true }
      );

    } catch (error) {
      console.error(error);

      this.setHint(
        `VR initialization failed: ${error.message}`
      );

      try {
        await session.end();
      } catch (_) {
        // Session may already be closed.
      }

      this.activateFlatMode(flatMode);
    }
  }

  // --------------------------------------------------
  // Desktop mouse and keyboard
  // --------------------------------------------------

  installInputListeners() {
    this.renderer.domElement.addEventListener(
      'click',
      () => {
        if (this.mode === 'desktop') {
          this.requestPointerLock();
        }
      }
    );

    document.addEventListener(
      'pointerlockchange',
      () => {
        if (this.mode !== 'desktop') return;

        const locked =
          document.pointerLockElement ===
          this.renderer.domElement;

        this.setHint(
          locked
            ? 'Desktop: ZQSD/WASD or arrows move · Shift crouch · Esc unlock'
            : 'Desktop: click the 3D viewport to capture the mouse'
        );
      }
    );

    document.addEventListener(
      'mousemove',
      event => {
        if (this.mode !== 'desktop') return;

        if (
          document.pointerLockElement !==
          this.renderer.domElement
        ) {
          return;
        }

        this.player.setCapsuleYaw(
          this.player.capsuleYaw -
          event.movementX *
          this.mouseSensitivity *
          DEG
        );

        this.desktopPitch = THREE.MathUtils.clamp(
          this.desktopPitch -
          event.movementY *
          this.mouseSensitivity,
          -Math.PI * 0.42,
          Math.PI * 0.42
        );

        this.player.setEyesRotation({
          x: -this.desktopPitch * DEG
        });

        this.gameCamera.rotation.x =
          this.desktopPitch;
      }
    );

    document.addEventListener(
      'keydown',
      event => {
        if (this.mode !== 'desktop') return;

        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLSelectElement
        ) {
          return;
        }

        if (this.isMovementKey(event.code)) {
          event.preventDefault();
        }

        this.keys.add(event.code);
      }
    );

    document.addEventListener(
      'keyup',
      event => this.keys.delete(event.code)
    );

    window.addEventListener(
      'blur',
      () => this.keys.clear()
    );
  }

  requestPointerLock() {
    if (this.mode !== 'desktop') return;

    if (
      document.pointerLockElement ===
      this.renderer.domElement
    ) {
      return;
    }

    try {
      this.renderer.domElement
        .requestPointerLock()
        ?.catch(error => {
          this.setHint(
            `Pointer lock unavailable: ${error.message}`
          );
        });

    } catch (error) {
      this.setHint(
        `Pointer lock unavailable: ${error.message}`
      );
    }
  }

  isMovementKey(code) {
    return [
      'KeyW',
      'KeyZ',
      'KeyA',
      'KeyQ',
      'KeyS',
      'KeyD',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ShiftLeft',
      'ShiftRight'
    ].includes(code);
  }

  // --------------------------------------------------
  // Desktop movement and crouch
  // --------------------------------------------------

  updateDesktop(delta) {
    const down = (...codes) =>
      codes.some(code => this.keys.has(code));

    const forward =
      Number(down('KeyW', 'KeyZ', 'ArrowUp')) -
      Number(down('KeyS', 'ArrowDown'));

    const strafe =
      Number(down('KeyD', 'ArrowRight')) -
      Number(down('KeyA', 'KeyQ', 'ArrowLeft'));

    // Avatar forward is +Z.

    const movement = this.moveForward.set(
      -strafe,
      0,
      forward
    );

    if (movement.lengthSq() > 0) {
      movement
        .normalize()
        .applyAxisAngle(
          Y_AXIS,
          this.player.rotation.y
        );

      this.player.position.addScaledVector(
        movement,
        this.walkSpeed * delta
      );
    }

    // Walk only when moving forward.

    this.updateLocomotionAnimation(
      forward > 0
    );

    // Shift crouch.

    const crouching = down(
      'ShiftLeft',
      'ShiftRight'
    );

    const neutral = this.player.getNeutralEyeY();

    this.player.setEyesPosition({
      y: neutral - (
        crouching
          ? this.avatar.maxCrouch
          : this.avatar.minCrouch
      )
    });

    // Keep the forward offset during crouch.

    this.updateDesktopCameraPosition();
  }

  // --------------------------------------------------
  // VR gamepad
  // --------------------------------------------------

  readStick(source) {
    const axes = source?.gamepad?.axes;

    if (!axes) {
      return { x: 0, y: 0 };
    }

    let x = axes.length >= 4
      ? axes[2]
      : axes[0];

    let y = axes.length >= 4
      ? axes[3]
      : axes[1];

    if (
      axes.length >= 4 &&
      Math.abs(x) < DEADZONE &&
      Math.abs(y) < DEADZONE
    ) {
      x = axes[0];
      y = axes[1];
    }

    return {
      x: Math.abs(x ?? 0) < DEADZONE ? 0 : x,
      y: Math.abs(y ?? 0) < DEADZONE ? 0 : y
    };
  }

  // --------------------------------------------------
  // VR locomotion
  // --------------------------------------------------

  updateVRLocomotion(delta, frame) {
    let left = null;
    let right = null;

    for (const source of frame.session.inputSources) {
      if (source.handedness === 'left') {
        left = source;
      }

      if (source.handedness === 'right') {
        right = source;
      }
    }

    const moveStick = this.readStick(left);
    const turnStick = this.readStick(right);

    // Rotate around tracked headset position.

    if (turnStick.x !== 0) {
      this.xrRig.updateWorldMatrix(true, false);

      this.beforeTurn.copy(this.headLocal);
      this.xrRig.localToWorld(this.beforeTurn);

      this.xrRig.rotation.y -=
        turnStick.x * this.vrTurnSpeed * delta;

      this.xrRig.updateWorldMatrix(true, false);

      this.afterTurn.copy(this.headLocal);
      this.xrRig.localToWorld(this.afterTurn);

      this.xrRig.position.x +=
        this.beforeTurn.x - this.afterTurn.x;

      this.xrRig.position.z +=
        this.beforeTurn.z - this.afterTurn.z;
    }

    this.player.setCapsuleYaw(
      this.xrRig.rotation.y * DEG
    );

    // Move relative to the XR rig orientation.

    this.moveForward
      .set(0, 0, -1)
      .applyAxisAngle(
        Y_AXIS,
        this.xrRig.rotation.y
      );

    this.moveRight
      .set(1, 0, 0)
      .applyAxisAngle(
        Y_AXIS,
        this.xrRig.rotation.y
      );

    const speed = this.vrWalkSpeed * delta;

    this.xrRig.position.addScaledVector(
      this.moveForward,
      -moveStick.y * speed
    );

    this.xrRig.position.addScaledVector(
      this.moveRight,
      moveStick.x * speed
    );

    this.xrRig.updateWorldMatrix(true, false);

    // VR walking for forward or backward stick movement.

    return moveStick.y !== 0;
  }

  // --------------------------------------------------
  // VR headset and controller tracking
  // --------------------------------------------------

  updateVR(delta, frame) {
    if (
      !frame ||
      !this.renderer.xr.isPresenting
    ) {
      return;
    }

    const referenceSpace =
      this.renderer.xr.getReferenceSpace();

    if (!referenceSpace) return;

    const viewerPose =
      frame.getViewerPose(referenceSpace);

    if (!viewerPose) return;

    const head = viewerPose.transform;

    this.headLocal.set(
      head.position.x,
      head.position.y,
      head.position.z
    );

    const walking =
      this.updateVRLocomotion(delta, frame);

    this.updateLocomotionAnimation(walking);

    this.headWorld.copy(this.headLocal);
    this.xrRig.localToWorld(this.headWorld);

    this.player.setEyesPosition(
      {
        x: this.headWorld.x,
        y: this.headWorld.y,
        z: this.headWorld.z
      },
      { clampY: false }
    );

    this.trackedQuaternion.set(
      head.orientation.x,
      head.orientation.y,
      head.orientation.z,
      head.orientation.w
    );

    this.headEuler.setFromQuaternion(
      this.trackedQuaternion,
      'YXZ'
    );

    this.player.setEyesRotation({
      x: this.headEuler.x * DEG,
      y: this.headEuler.y * DEG,
      z: this.headEuler.z * DEG
    });

    const tracked = {
      left: false,
      right: false
    };

    this.xrRig.getWorldQuaternion(
      this.rigQuaternion
    );

    for (const source of frame.session.inputSources) {
      const side = source.handedness;

      if (
        (side !== 'left' && side !== 'right') ||
        !source.gripSpace
      ) {
        continue;
      }

      const gripPose = frame.getPose(
        source.gripSpace,
        referenceSpace
      );

      if (!gripPose) continue;

      const pose = gripPose.transform;

      this.trackedPosition.set(
        pose.position.x,
        pose.position.y,
        pose.position.z
      );

      this.xrRig.localToWorld(
        this.trackedPosition
      );

      this.trackedQuaternion
        .set(
          pose.orientation.x,
          pose.orientation.y,
          pose.orientation.z,
          pose.orientation.w
        )
        .premultiply(this.rigQuaternion);

      this.avatar.setHandWorldPose(
        side,
        this.trackedPosition,
        this.trackedQuaternion
      );

      tracked[side] = true;
    }

    for (const side of ['left', 'right']) {
      this.avatar.setArmIKEnabled(
        side,
        tracked[side]
      );
    }
  }

  // --------------------------------------------------
  // Sidebar controls
  // --------------------------------------------------

  createSection(title) {
    const section = document.createElement('section');
    const heading = document.createElement('h2');

    heading.textContent = title;
    section.appendChild(heading);
    this.controlsContainer.appendChild(section);

    return section;
  }

  createCheckbox(section, label, checked, onChange) {
    const wrapper = document.createElement('label');
    wrapper.className = 'checkbox-field';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;

    const span = document.createElement('span');
    span.textContent = label;

    input.addEventListener(
      'change',
      () => onChange(input.checked)
    );

    wrapper.append(input, span);
    section.appendChild(wrapper);

    return input;
  }

  createVectorInput({
    section,
    label,
    values,
    axes = ['x', 'y', 'z'],
    step = 0.01,
    min,
    max,
    axisSettings = {},
    onChange
  }) {
    const group = document.createElement('div');
    group.className = 'field-group';

    const title = document.createElement('span');
    title.className = 'field-title';
    title.textContent = label;

    const row = document.createElement('div');
    row.className = axes.length === 1
      ? 'vector-inputs single'
      : 'vector-inputs';

    const inputs = {};

    for (const axis of axes) {
      const settings = axisSettings[axis] || {};

      const axisStep = settings.step ?? step;
      const axisMin = settings.min ?? min;
      const axisMax = settings.max ?? max;

      const field = document.createElement('label');
      field.className = 'axis-field';

      const caption = document.createElement('span');
      caption.className = 'axis-label';
      caption.textContent = settings.label ?? axis;

      const input = document.createElement('input');
      input.type = 'number';
      input.step = String(axisStep);

      input.value = this.formatNumber(
        values[axis]
      );

      if (axisMin !== undefined) {
        input.min = String(axisMin);
      }

      if (axisMax !== undefined) {
        input.max = String(axisMax);
      }

      inputs[axis] = input;

      const apply = (value, normalizeInput) => {
        if (!Number.isFinite(value)) return;

        const result = onChange(axis, value);

        const actual = Number.isFinite(result)
          ? result
          : value;

        values[axis] = actual;

        if (normalizeInput) {
          input.value = this.formatNumber(actual);
        }
      };

      input.addEventListener('input', () => {
        if (
          input.value !== '' &&
          Number.isFinite(input.valueAsNumber)
        ) {
          apply(input.valueAsNumber, false);
        }
      });

      input.addEventListener('change', () => {
        if (
          input.value === '' ||
          !Number.isFinite(input.valueAsNumber)
        ) {
          input.value = this.formatNumber(
            values[axis]
          );
        } else {
          apply(input.valueAsNumber, true);
        }
      });

      // Scroll the numeric value, not the sidebar.

      input.addEventListener(
        'wheel',
        event => {
          event.preventDefault();
          event.stopPropagation();

          if (!event.deltaY) return;

          const direction =
            event.deltaY < 0 ? 1 : -1;

          const next = Number(
            (
              values[axis] +
              direction * axisStep
            ).toFixed(6)
          );

          apply(next, true);
        },
        { passive: false }
      );

      field.append(caption, input);
      row.appendChild(field);
    }

    group.append(title, row);
    section.appendChild(group);

    return {
      inputs,

      sync: (
        updated,
        { preserveActive = false } = {}
      ) => {
        for (const axis of axes) {
          values[axis] = updated[axis];

          if (
            !preserveActive ||
            document.activeElement !== inputs[axis]
          ) {
            inputs[axis].value =
              this.formatNumber(updated[axis]);
          }
        }
      }
    };
  }

  formatNumber(value) {
    return String(Number(value.toFixed(4)));
  }

  createAnimationControls(section, state) {
    const group = document.createElement('div');
    group.className = 'field-group';

    const title = document.createElement('span');
    title.className = 'field-title';
    title.textContent = 'Animation';

    const row = document.createElement('div');
    row.className = 'animation-row';

    const select = document.createElement('select');
    select.className = 'animation-select';

    for (const name of state.available) {
      const option = document.createElement('option');
      option.value = name;

      option.textContent =
        name[0].toUpperCase() + name.slice(1);

      select.appendChild(option);
    }

    select.value = state.current;

    select.addEventListener('change', () => {
      this.avatar.setAnimation(select.value);
    });

    const button = document.createElement('button');
    button.className = 'animation-button';
    button.type = 'button';

    const refresh = () => {
      button.textContent =
        this.avatar.isPlaying() ? 'Pause' : 'Play';
    };

    button.addEventListener('click', () => {
      this.avatar.setPlaying(
        !this.avatar.isPlaying()
      );

      refresh();
    });

    refresh();

    row.append(select, button);
    group.append(title, row);
    section.appendChild(group);
  }

  syncCapsuleDependentFields() {
    const state = this.player.getControlState();

    this.ui.capsuleParameters.sync(
      state.capsule,
      { preserveActive: true }
    );

    this.ui.capsuleParameters.inputs.radius.min =
      '0.05';

    this.ui.capsuleParameters.inputs.radius.max =
      String(state.capsule.height / 2);

    this.ui.eyesPosition.sync(
      state.eyes.position
    );

    this.ui.eyesPosition.inputs.y.min =
      String(state.eyes.yLimits.min);

    this.ui.eyesPosition.inputs.y.max =
      String(state.eyes.yLimits.max);
  }

  // --------------------------------------------------
  // Debug sidebar
  // --------------------------------------------------

  buildControls() {
    this.controlsContainer.replaceChildren();

    const state = this.player.getControlState();

    // View.

    const view = this.createSection('View');

    this.createCheckbox(
      view,
      'Display transform',
      state.view.displayTransforms,
      visible =>
        this.avatar.setDisplayTransforms(visible)
    );

    this.createCheckbox(
      view,
      'Display skeleton',
      state.view.displaySkeleton,
      visible =>
        this.avatar.setDisplaySkeleton(visible)
    );

    this.createCheckbox(
      view,
      'Display capsule',
      state.view.displayCapsule,
      visible =>
        this.player.setDisplayCapsule(visible)
    );

    // Animation.

    this.createAnimationControls(
      this.createSection('Animation'),
      state.animation
    );

    // Capsule.

    const capsule = this.createSection(
      'Player capsule'
    );

    this.ui.capsuleParameters = this.createVectorInput({
      section: capsule,
      label: 'Capsule parameters',

      values: state.capsule,
      axes: ['height', 'radius', 'yaw'],

      axisSettings: {
        height: {
          step: 0.01,
          min: 0.3
        },

        radius: {
          step: 0.01,
          min: 0.05,
          max: state.capsule.height / 2
        },

        yaw: {
          step: 1
        }
      },

      onChange: (axis, value) => {
        if (axis === 'height') {
          const actual =
            this.player.setCapsuleHeight(value);

          this.syncCapsuleDependentFields();
          return actual;
        }

        if (axis === 'radius') {
          return this.player.setCapsuleRadius(value);
        }

        return this.player.setCapsuleYaw(value);
      }
    });

    // Avatar eyes.

    const eyes = this.createSection(
      'Avatar eyes'
    );

    this.ui.eyesPosition = this.createVectorInput({
      section: eyes,
      label: 'Position (world)',

      values: state.eyes.position,

      onChange: (axis, value) =>
        this.player.setEyesPosition({
          [axis]: value
        })[axis]
    });

    this.ui.eyesPosition.inputs.y.min =
      String(state.eyes.yLimits.min);

    this.ui.eyesPosition.inputs.y.max =
      String(state.eyes.yLimits.max);

    this.createVectorInput({
      section: eyes,
      label: 'Head rotation (degrees)',

      values: state.eyes.rotation,
      step: 1,

      onChange: (axis, value) =>
        this.player.setEyesRotation({
          [axis]: value
        })[axis]
    });

    this.createCheckbox(
      eyes,
      'Override head animation (X / Y / Z)',
      state.eyes.headOverride,

      enabled =>
        this.player.setHeadOverride(enabled)
    );

    // Hand controls.

    for (const side of ['left', 'right']) {
      const hand = this.createSection(
        `${side === 'left' ? 'Left' : 'Right'} hand`
      );

      this.createCheckbox(
        hand,
        'Enable arm IK',
        state.ik[side],

        enabled =>
          this.avatar.setArmIKEnabled(side, enabled)
      );

      this.createVectorInput({
        section: hand,
        label: 'Position (origin local)',

        values: state.hands[side].position,

        onChange: (axis, value) =>
          this.avatar.setHandPosition(
            side,
            { [axis]: value }
          )
      });

      this.createVectorInput({
        section: hand,
        label: 'Pole (origin local)',

        values: state.hands[side].pole,

        onChange: (axis, value) =>
          this.avatar.setHandPolePosition(
            side,
            { [axis]: value }
          )
      });

      this.createVectorInput({
        section: hand,
        label: 'Rotation (degrees)',

        values: state.hands[side].rotation,
        step: 1,

        onChange: (axis, value) =>
          this.avatar.setHandRotation(
            side,
            { [axis]: value }
          )
      });
    }

    // Leg poles.

    for (const side of ['left', 'right']) {
      const leg = this.createSection(
        `${side === 'left' ? 'Left' : 'Right'} leg`
      );

      this.createVectorInput({
        section: leg,
        label: 'Pole (origin local)',

        values: state.legs[side].pole,

        onChange: (axis, value) =>
          this.avatar.setLegPolePosition(
            side,
            { [axis]: value }
          )
      });
    }
  }

  // --------------------------------------------------
  // Rendering and resize
  // --------------------------------------------------

  animate(frame) {
    this.timer.update();

    const delta = Math.min(
      this.timer.getDelta(),
      0.05
    );

    if (this.mode === 'desktop') {
      this.updateDesktop(delta);
    }

    if (this.mode === 'vr') {
      this.updateVR(delta, frame);
    }

    if (this.avatar.mixer) {
      this.avatar.update(delta);
    }

    if (this.mode === 'debug') {
      this.orbit.update();
    }

    this.renderer.render(
      this.scene,
      this.mode === 'debug'
        ? this.debugCamera
        : this.gameCamera
    );
  }

  resize() {
    const width = this.viewport.clientWidth;
    const height = this.viewport.clientHeight;

    if (!width || !height) return;

    for (const camera of [
      this.debugCamera,
      this.gameCamera
    ]) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    if (!this.renderer.xr.isPresenting) {
      this.renderer.setSize(width, height);
    }
  }
}
