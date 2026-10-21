
import * as THREE from 'three';
import { IK } from './ik.js';

const EPSILON = 1e-6;

const DEFAULT_TRANSFORMS = {
  leftHand: [0.20, 1, 0.17],
  leftHandRotation: [90, -45, -10],
  rightHand: [-0.20, 1, 0.17],
  rightHandRotation: [90, 45, -10],
  leftElbow: [0.8118, 0.9691, -0.3815],
  rightElbow: [-0.8118, 0.9691, -0.3815],
  leftKnee: [0.2466, 0.5087, 1.2265],
  rightKnee: [-0.2466, 0.5087, 1.2265]
};

export class Avatar {
  constructor({
    height = 1.8,
    minCrouch = 0,
    maxCrouch = 0.5
  } = {}) {
    this.height = height;
    this.minCrouch = minCrouch;
    this.maxCrouch = maxCrouch;

    this.origin = null;
    this.model = null;
    this.root = null;
    this.mixer = null;
    this.hips = null;
    this.head = null;
    this.hipOffset = null;
    this.poleAnchor = null;
    this.skeletonHelper = null;

    this.headRestQuaternion = new THREE.Quaternion();
    this.headEuler = new THREE.Euler(0, 0, 0, 'XYZ');
    this.headOffsetQuaternion = new THREE.Quaternion();
    this.headOverride = true;

    this.legIK = [];
    this.handIK = {};
    this.armIKEnabled = {
      left: true,
      right: true
    };

    this.handTargets = {};
    this.poleTargets = {};
    this.transformMarkers = [];

    this.displayTransforms = true;
    this.displaySkeleton = true;

    this.animationClips = new Map();
    this.currentAnimation = null;
    this.currentAction = null;
    this.playing = true;

    this.crouchDeltaY = 0;
    this.worldDelta = new THREE.Vector3();
    this.inverseMatrix = new THREE.Matrix3();

    this.targetPosition = new THREE.Vector3();
    this.targetQuaternion = new THREE.Quaternion();
    this.handWorldPosition = new THREE.Vector3();
    this.originWorldQuaternion = new THREE.Quaternion();
  }

  // --------------------------------------------------
  // Skeleton utilities
  // --------------------------------------------------

  normalizeBoneName(name) {
    return name
      .replace(/^.*[|:]/, '')
      .replace(/^mixamorig\d*/i, '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
  }

  collectBones(object) {
    const result = new Map();

    object.traverse(child => {
      if (!child.isBone) return;

      const name = this.normalizeBoneName(
        child.name
      );

      if (!result.has(name)) {
        result.set(name, child);
      }
    });

    return result;
  }

  isDescendantOf(object, ancestor) {
    for (
      let node = object.parent;
      node;
      node = node.parent
    ) {
      if (node === ancestor) return true;
    }

    return false;
  }

  worldToParentDelta(object, delta, result) {
    object.parent.updateWorldMatrix(true, false);

    this.inverseMatrix
      .setFromMatrix4(object.parent.matrixWorld)
      .invert();

    return result
      .copy(delta)
      .applyMatrix3(this.inverseMatrix);
  }

  setVectorComponents(vector, components) {
    for (const axis of ['x', 'y', 'z']) {
      if (components[axis] !== undefined) {
        vector[axis] = components[axis];
      }
    }
  }

  vectorToObject(vector) {
    return {
      x: vector.x,
      y: vector.y,
      z: vector.z
    };
  }

  rotationToDegrees(rotation) {
    return {
      x: THREE.MathUtils.radToDeg(rotation.x),
      y: THREE.MathUtils.radToDeg(rotation.y),
      z: THREE.MathUtils.radToDeg(rotation.z)
    };
  }

  // --------------------------------------------------
  // Crouch
  // --------------------------------------------------

  syncEyesHeight(eyeY, neutralEyeY) {
    this.crouchDeltaY = THREE.MathUtils.clamp(
      eyeY - neutralEyeY,
      -this.maxCrouch,
      -this.minCrouch
    );

    if (this.poleAnchor && this.origin) {
      this.poleAnchor.position.y =
        this.crouchDeltaY / this.origin.scale.y;
    }
  }

  // --------------------------------------------------
  // Head controls
  // --------------------------------------------------

  setHeadRotation(x, y, z) {
    this.headEuler.set(
      THREE.MathUtils.degToRad(x),
      THREE.MathUtils.degToRad(y),
      THREE.MathUtils.degToRad(z),
      'XYZ'
    );
  }

  setHeadOverride(enabled) {
    this.headOverride = Boolean(enabled);
  }

  applyHeadOverride() {
    if (!this.headOverride || !this.head) return;

    this.headOffsetQuaternion.setFromEuler(
      this.headEuler
    );

    this.head.quaternion
      .copy(this.headRestQuaternion)
      .multiply(this.headOffsetQuaternion)
      .normalize();

    this.head.updateWorldMatrix(true, true);
  }

  // --------------------------------------------------
  // Debug visibility
  // --------------------------------------------------

  setDisplayTransforms(visible) {
    this.displayTransforms = Boolean(visible);

    for (const marker of this.transformMarkers) {
      marker.visible = this.displayTransforms;
    }
  }

  setDisplaySkeleton(visible) {
    this.displaySkeleton = Boolean(visible);

    if (this.skeletonHelper) {
      this.skeletonHelper.visible =
        this.displaySkeleton;
    }
  }

  // --------------------------------------------------
  // Hand and pole controls
  // --------------------------------------------------

  setHandPosition(side, components) {
    if (!this.handTargets[side]) {
      throw new Error(`Unknown hand: ${side}`);
    }

    this.setVectorComponents(
      this.handTargets[side].position,
      components
    );
  }

  setHandWorldPose(
    side,
    worldPosition,
    worldQuaternion
  ) {
    const target = this.handTargets[side];

    if (!target) {
      throw new Error(`Unknown hand: ${side}`);
    }

    this.origin.updateWorldMatrix(true, false);

    this.handWorldPosition.copy(worldPosition);

    target.position.copy(
      this.origin.worldToLocal(this.handWorldPosition)
    );

    this.origin.getWorldQuaternion(
      this.originWorldQuaternion
    );

    target.quaternion
      .copy(this.originWorldQuaternion)
      .invert()
      .multiply(worldQuaternion)
      .normalize();
  }

  setHandRotation(side, components) {
    const target = this.handTargets[side];

    if (!target) {
      throw new Error(`Unknown hand: ${side}`);
    }

    for (const axis of ['x', 'y', 'z']) {
      if (components[axis] !== undefined) {
        target.rotation[axis] =
          THREE.MathUtils.degToRad(
            components[axis]
          );
      }
    }
  }

  setPolePosition(name, components) {
    const target = this.poleTargets[name];

    if (!target) {
      throw new Error(`Unknown pole: ${name}`);
    }

    this.setVectorComponents(
      target.position,
      components
    );
  }

  setHandPolePosition(side, components) {
    this.setPolePosition(
      `${side}Elbow`,
      components
    );
  }

  setLegPolePosition(side, components) {
    this.setPolePosition(
      `${side}Knee`,
      components
    );
  }

  setArmIKEnabled(side, enabled) {
    if (side !== 'left' && side !== 'right') {
      throw new Error(`Unknown arm: ${side}`);
    }

    this.armIKEnabled[side] = Boolean(enabled);
  }

  // --------------------------------------------------
  // Animation controls
  // --------------------------------------------------

  setAnimation(name) {
    const clip = this.animationClips.get(name);

    if (!clip) {
      throw new Error(`Unknown animation: ${name}`);
    }

    if (this.currentAnimation === name) return;

    if (this.currentAction) {
      this.currentAction.stop();
    }

    this.currentAction = this.mixer.clipAction(clip);

    this.currentAction
      .reset()
      .setLoop(THREE.LoopRepeat, Infinity)
      .play();

    this.currentAction.paused = !this.playing;
    this.currentAnimation = name;

    this.mixer.update(0);
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);

    if (this.currentAction) {
      this.currentAction.paused = !this.playing;
    }
  }

  isPlaying() {
    return this.playing;
  }

  // --------------------------------------------------
  // Sidebar state
  // --------------------------------------------------

  getControlState() {
    const handState = side => ({
      position: this.vectorToObject(
        this.handTargets[side].position
      ),
      rotation: this.rotationToDegrees(
        this.handTargets[side].rotation
      ),
      pole: this.vectorToObject(
        this.poleTargets[`${side}Elbow`].position
      )
    });

    return {
      view: {
        displayTransforms: this.displayTransforms,
        displaySkeleton: this.displaySkeleton
      },

      animation: {
        available: [...this.animationClips.keys()],
        current: this.currentAnimation,
        playing: this.playing
      },

      ik: {
        ...this.armIKEnabled
      },

      hands: {
        left: handState('left'),
        right: handState('right')
      },

      legs: {
        left: {
          pole: this.vectorToObject(
            this.poleTargets.leftKnee.position
          )
        },
        right: {
          pole: this.vectorToObject(
            this.poleTargets.rightKnee.position
          )
        }
      }
    };
  }

  // --------------------------------------------------
  // Debug markers
  // --------------------------------------------------

  createTransformMarker(parent, radius, color) {
    const vertices = [];
    const segments = 32;

    for (const [u, v] of [
      [0, 1],
      [0, 2],
      [1, 2]
    ]) {
      for (let i = 0; i < segments; i++) {
        const a = i * Math.PI * 2 / segments;
        const b = (i + 1) * Math.PI * 2 / segments;

        const pa = [0, 0, 0];
        const pb = [0, 0, 0];

        pa[u] = Math.cos(a) * radius;
        pa[v] = Math.sin(a) * radius;

        pb[u] = Math.cos(b) * radius;
        pb[v] = Math.sin(b) * radius;

        vertices.push(...pa, ...pb);
      }
    }

    const geometry = new THREE.BufferGeometry();

    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        vertices,
        3
      )
    );

    const marker = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
        opacity: 0.95
      })
    );

    marker.renderOrder = 20;
    marker.frustumCulled = false;
    marker.visible = this.displayTransforms;

    parent.add(marker);
    this.transformMarkers.push(marker);

    return marker;
  }

  createPoleTarget(parent, name, position, color) {
    const target = new THREE.Object3D();

    target.name = name;
    target.position.set(...position);

    parent.add(target);

    this.createTransformMarker(
      target,
      0.035,
      color
    );

    return target;
  }

  // --------------------------------------------------
  // Mixamo retargeting
  // --------------------------------------------------

  createAnimationClip(
    sourceClip,
    sourceBones,
    targetBones,
    name
  ) {
    const tracks = [];
    const targetHips = targetBones.get('hips');

    const sourceLeg = sourceBones.get('leftleg');
    const targetLeg = targetBones.get('leftleg');

    const motionScale =
      sourceLeg &&
        targetLeg &&
        sourceLeg.position.length() > EPSILON
        ? targetLeg.position.length() /
        sourceLeg.position.length()
        : 1;

    const targetHipRest =
      targetHips.position.clone();

    const quaternion = new THREE.Quaternion();

    for (const sourceTrack of sourceClip.tracks) {
      const separator =
        sourceTrack.name.lastIndexOf('.');

      if (separator < 0) continue;

      let sourceName =
        sourceTrack.name.slice(0, separator);

      const property =
        sourceTrack.name.slice(separator + 1);

      const boneMatch =
        sourceName.match(/\.bones\[([^\]]+)\]/);

      if (boneMatch) {
        sourceName = boneMatch[1];
      }

      const boneName =
        this.normalizeBoneName(sourceName);

      const targetBone =
        targetBones.get(boneName);

      if (!targetBone) continue;

      if (property === 'quaternion') {
        const track = sourceTrack.clone();

        track.name =
          `${targetBone.uuid}.quaternion`;

        const sourceBone =
          sourceBones.get(boneName);

        // Keep the direct Mixamo arm animations.
        const isArmBone =
          /^(left|right)(shoulder|arm|forearm|hand)/.test(
            boneName
          );

        if (sourceBone && !isArmBone) {
          const offset = targetBone.quaternion
            .clone()
            .multiply(
              sourceBone.quaternion.clone().invert()
            );

          for (
            let i = 0;
            i < track.values.length;
            i += 4
          ) {
            quaternion
              .fromArray(track.values, i)
              .premultiply(offset)
              .normalize()
              .toArray(track.values, i);
          }
        }

        tracks.push(track);

      } else if (
        property === 'position' &&
        targetBone === targetHips
      ) {
        const track = sourceTrack.clone();

        track.name =
          `${targetBone.uuid}.position`;

        // Anchor the first animation frame to
        // the avatar's own Hips reference position.

        const baseX = track.values[0];
        const baseY = track.values[1];
        const baseZ = track.values[2];

        for (
          let i = 0;
          i < track.values.length;
          i += 3
        ) {
          track.values[i] =
            targetHipRest.x +
            (track.values[i] - baseX) * motionScale;

          track.values[i + 1] =
            targetHipRest.y +
            (track.values[i + 1] - baseY) * motionScale;

          track.values[i + 2] =
            targetHipRest.z +
            (track.values[i + 2] - baseZ) * motionScale;
        }

        tracks.push(track);
      }
    }

    if (!tracks.length) {
      throw new Error(
        `No compatible animation tracks in ${name}.`
      );
    }

    return new THREE.AnimationClip(
      name,
      sourceClip.duration,
      tracks
    );
  }

  // --------------------------------------------------
  // Initialization
  // --------------------------------------------------

  initialize(origin, loadedAvatar, animationModels) {
    this.origin = origin;
    this.model = loadedAvatar;

    this.model.traverse(child => {
      if (child.isSkinnedMesh) {
        child.frustumCulled = false;
      }
    });

    this.root = new THREE.Group();
    this.root.name = 'Avatar';

    this.root.add(this.model);
    this.origin.add(this.root);

    // Normalize the character in its FBX reference pose.

    const bounds =
      new THREE.Box3().setFromObject(this.model, true);

    const height =
      bounds.getSize(new THREE.Vector3()).y;

    if (bounds.isEmpty() || height < EPSILON) {
      throw new Error('Invalid avatar bounding box.');
    }

    this.root.scale.setScalar(
      this.height / height
    );

    this.root.updateWorldMatrix(true, true);

    // Resolve the Mixamo skeleton.

    const bones = this.collectBones(this.model);

    const hips = bones.get('hips');
    const head = bones.get('head');

    const lUpperLeg = bones.get('leftupleg');
    const lLeg = bones.get('leftleg');
    const lFoot = bones.get('leftfoot');

    const rUpperLeg = bones.get('rightupleg');
    const rLeg = bones.get('rightleg');
    const rFoot = bones.get('rightfoot');

    const lArm = bones.get('leftarm');
    const lForearm = bones.get('leftforearm');
    const lHand = bones.get('lefthand');

    const rArm = bones.get('rightarm');
    const rForearm = bones.get('rightforearm');
    const rHand = bones.get('righthand');

    const required = [
      hips, head,
      lUpperLeg, lLeg, lFoot,
      rUpperLeg, rLeg, rFoot,
      lArm, lForearm, lHand,
      rArm, rForearm, rHand
    ];

    if (required.some(bone => !bone)) {
      throw new Error(
        `Missing Mixamo bones: ${[...bones.keys()].join(', ')}`
      );
    }

    // Validate the IK hierarchies.

    for (const [a, b] of [
      [lUpperLeg, hips],
      [lLeg, lUpperLeg],
      [lFoot, lLeg],
      [rUpperLeg, hips],
      [rLeg, rUpperLeg],
      [rFoot, rLeg],
      [lForearm, lArm],
      [lHand, lForearm],
      [rForearm, rArm],
      [rHand, rForearm]
    ]) {
      if (!this.isDescendantOf(a, b)) {
        throw new Error(
          'Invalid Mixamo bone hierarchy.'
        );
      }
    }

    this.hips = hips;
    this.head = head;

    this.headRestQuaternion.copy(
      head.quaternion
    );

    // Create two-bone IK chains.

    this.legIK = [
      new IK({
        bones: [lUpperLeg, lLeg, lFoot],
        poleBone: bones.get('lefttoebase')
      }),
      new IK({
        bones: [rUpperLeg, rLeg, rFoot],
        poleBone: bones.get('righttoebase')
      })
    ];

    this.handIK.left = new IK({
      bones: [lArm, lForearm, lHand]
    });

    this.handIK.right = new IK({
      bones: [rArm, rForearm, rHand]
    });

    // Create hand targets.

    for (const side of ['left', 'right']) {
      const target = new THREE.Object3D();

      target.name = `${side}HandTarget`;

      target.position.set(
        ...DEFAULT_TRANSFORMS[`${side}Hand`]
      );

      target.rotation.set(
        ...DEFAULT_TRANSFORMS[
          `${side}HandRotation`
        ].map(THREE.MathUtils.degToRad),
        'XYZ'
      );

      this.origin.add(target);
      this.handTargets[side] = target;

      this.createTransformMarker(
        target,
        0.055,
        side === 'left'
          ? 0xffaa33
          : 0x33ccff
      );
    }

    // Create elbow and knee pole targets.

    this.poleAnchor = new THREE.Group();
    this.poleAnchor.name = 'PoleAnchor';

    this.origin.add(this.poleAnchor);

    const poleColors = {
      leftElbow: 0xffaa33,
      rightElbow: 0x33ccff,
      leftKnee: 0xffdd33,
      rightKnee: 0x66ff66
    };

    for (const name of Object.keys(poleColors)) {
      this.poleTargets[name] =
        this.createPoleTarget(
          this.poleAnchor,
          name,
          DEFAULT_TRANSFORMS[name],
          poleColors[name]
        );
    }

    this.legIK[0].setPoleTarget(
      this.poleTargets.leftKnee
    );

    this.legIK[1].setPoleTarget(
      this.poleTargets.rightKnee
    );

    this.handIK.left.setPoleTarget(
      this.poleTargets.leftElbow
    );

    this.handIK.right.setPoleTarget(
      this.poleTargets.rightElbow
    );

    // Insert a neutral parent for crouch.

    this.hipOffset = new THREE.Object3D();
    this.hipOffset.name = 'DynamicHipOffset';

    this.hips.parent.add(this.hipOffset);
    this.hipOffset.add(this.hips);

    // Skeleton visualization.

    this.root.updateWorldMatrix(true, true);

    this.skeletonHelper =
      new THREE.SkeletonHelper(this.root);

    this.skeletonHelper.matrix =
      this.root.matrix.clone();

    this.skeletonHelper.matrixAutoUpdate = false;
    this.skeletonHelper.material.depthTest = false;
    this.skeletonHelper.material.transparent = true;
    this.skeletonHelper.material.opacity = 0.9;
    this.skeletonHelper.renderOrder = 10;
    this.skeletonHelper.visible = this.displaySkeleton;

    this.origin.add(this.skeletonHelper);

    // Retarget animations.

    this.mixer = new THREE.AnimationMixer(this.model);

    for (
      const [name, object] of
      Object.entries(animationModels)
    ) {
      if (!object.animations.length) {
        throw new Error(
          `${name}.fbx contains no animation.`
        );
      }

      this.animationClips.set(
        name,
        this.createAnimationClip(
          object.animations[0],
          this.collectBones(object),
          bones,
          name
        )
      );
    }

    // --------------------------------------------------
    // One-time ground alignment using foot bones
    // --------------------------------------------------

    const initial = this.animationClips.has('walk')
      ? 'walk'
      : this.animationClips.keys().next().value;

    const reference = this.animationClips.has('idle')
      ? 'idle'
      : initial;

    // Apply a stable animated pose before calibration.
    this.setAnimation(reference);

    // FBX skinned mesh bounds are not reliable for
    // these exports. Use actual world-space foot joints.

    const toeBones = [
      bones.get('lefttoebase'),
      bones.get('righttoebase')
    ].filter(Boolean);

    const groundBones = toeBones.length
      ? toeBones
      : [lFoot, rFoot];

    const probe = new THREE.Vector3();

    // Measure relative to Origin's ground plane,
    // independently from the FBX's internal transforms.

    const lowestBoneY = Math.min(
      ...groundBones.map(bone => {
        bone.getWorldPosition(probe);

        return this.origin.worldToLocal(
          probe
        ).y;
      })
    );

    // Avatar.root is a direct child of Origin.
    // Both values use Origin-local coordinates.
    this.root.position.y -= lowestBoneY;

    this.root.updateMatrix();
    this.root.updateWorldMatrix(true, true);

    // Keep SkeletonHelper aligned with Avatar.root.
    this.skeletonHelper.matrix.copy(
      this.root.matrix
    );

    this.setAnimation(initial);

    return this;
  }

  // --------------------------------------------------
  // Animation and IK update
  // --------------------------------------------------

  update(deltaTime) {
    if (!this.mixer) return;

    for (const chain of [
      ...this.legIK,
      ...Object.values(this.handIK)
    ]) {
      chain.restorePose();
    }

    // Crouch is a separate world-space offset.

    this.worldDelta.set(
      0,
      this.crouchDeltaY,
      0
    );

    this.worldToParentDelta(
      this.hipOffset,
      this.worldDelta,
      this.hipOffset.position
    );

    this.mixer.update(deltaTime);
    this.applyHeadOverride();

    this.root.updateWorldMatrix(true, true);

    // Capture the current animation pose.

    for (const chain of [
      ...this.legIK,
      ...Object.values(this.handIK)
    ]) {
      chain.captureAnimatedPose(
        this.worldDelta
      );
    }

    // Compensate leg positions while crouching.

    if (Math.abs(this.crouchDeltaY) > EPSILON) {
      for (const chain of this.legIK) {
        chain.solve();
      }
    }

    // Apply arm IK only when enabled.

    for (const side of ['left', 'right']) {
      if (!this.armIKEnabled[side]) continue;

      const target = this.handTargets[side];

      target.getWorldPosition(
        this.targetPosition
      );

      target.getWorldQuaternion(
        this.targetQuaternion
      );

      this.handIK[side].solveToTarget(
        this.targetPosition,
        this.targetQuaternion,
        { stretch: true }
      );
    }

    this.root.updateWorldMatrix(true, true);
  }
}
