
import * as THREE from 'three';
import { IK } from './ik.js';

const EPSILON = 1e-6;

const DEFAULT_TRANSFORMS = {
    leftHand: [0.32, 1, 0.26],
    leftHandRotation: [90, -45, -10],
    rightHand: [-0.32, 1, 0.26],
    rightHandRotation: [90, 45, -10],
    leftElbow: [0.8118, 0.9691, -0.3815],
    rightElbow: [-0.8118, 0.9691, -0.3815],
    leftKnee: [0.2466, 0.5087, 1.2265],
    rightKnee: [-0.2466, 0.5087, 1.2265]
};

export class Avatar {
    #hipsPositionY = 0;

    constructor({ height = 1.8, minCrouch = 0, maxCrouch = 0.5 } = {}) {
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
        this.headOverride = true;
        this.headEuler = new THREE.Euler(0, 0, 0, 'XYZ');
        this.headOffsetQuaternion = new THREE.Quaternion();

        this.legIK = [];
        this.handIK = {};
        this.armIKEnabled = { left: true, right: true };
        this.handTargets = {};
        this.poleTargets = {};
        this.transformMarkers = [];

        this.displayTransforms = true;
        this.displaySkeleton = true;
        this.animationClips = new Map();
        this.currentAnimation = null;
        this.currentAction = null;
        this.playing = true;

        this.initialHipsPosition = new THREE.Vector3();
        this.crouchDeltaY = 0;
        this.worldDelta = new THREE.Vector3();
        this.inverseMatrix = new THREE.Matrix3();
        this.targetPosition = new THREE.Vector3();
        this.targetQuaternion = new THREE.Quaternion();
    }

    normalizeBoneName(name) {
        return name
            .replace(/^.*[|:]/, '')
            .replace(/^mixamorig\d*/i, '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase();
    }

    collectBones(object) {
        const bones = new Map();
        object.traverse(child => {
            if (!child.isBone) return;
            const name = this.normalizeBoneName(child.name);
            if (!bones.has(name)) bones.set(name, child);
        });
        return bones;
    }

    isDescendantOf(object, ancestor) {
        for (let parent = object.parent; parent; parent = parent.parent) {
            if (parent === ancestor) return true;
        }
        return false;
    }

    worldToParentDelta(object, delta, result) {
        object.parent.updateWorldMatrix(true, false);
        this.inverseMatrix
            .setFromMatrix4(object.parent.matrixWorld)
            .invert();
        return result.copy(delta).applyMatrix3(this.inverseMatrix);
    }

    setVectorComponents(vector, components) {
        for (const axis of ['x', 'y', 'z']) {
            if (components[axis] !== undefined) {
                vector[axis] = components[axis];
            }
        }
    }

    vectorToObject(vector) {
        return { x: vector.x, y: vector.y, z: vector.z };
    }

    rotationToDegrees(rotation) {
        return {
            x: THREE.MathUtils.radToDeg(rotation.x),
            y: THREE.MathUtils.radToDeg(rotation.y),
            z: THREE.MathUtils.radToDeg(rotation.z)
        };
    }

    // Manual crouch depends on eyes height, not the animation.
    syncEyesHeight(eyeY, neutralEyeY) {
        this.crouchDeltaY = THREE.MathUtils.clamp(
            eyeY - neutralEyeY,
            -this.maxCrouch,
            -this.minCrouch
        );

        const scale = this.origin ? this.origin.scale.y : 1;
        this.#hipsPositionY =
            this.initialHipsPosition.y * scale + this.crouchDeltaY;

        if (this.poleAnchor) {
            this.poleAnchor.position.y = this.crouchDeltaY / scale;
        }
    }

    // Eyes X/Y/Z now control the head independently of player yaw.
    setHeadRotation(pitchDegrees, yawDegrees, rollDegrees) {
        this.headEuler.set(
            THREE.MathUtils.degToRad(pitchDegrees),
            THREE.MathUtils.degToRad(yawDegrees),
            THREE.MathUtils.degToRad(rollDegrees),
            'XYZ'
        );
    }

    setHeadOverride(enabled) {
        this.headOverride = Boolean(enabled);
    }

    applyHeadOverride() {
        if (!this.headOverride || !this.head) return;

        this.headOffsetQuaternion.setFromEuler(this.headEuler);
        this.head.quaternion
            .copy(this.headRestQuaternion)
            .multiply(this.headOffsetQuaternion)
            .normalize();
        this.head.updateWorldMatrix(true, true);
    }

    setDisplayTransforms(visible) {
        this.displayTransforms = Boolean(visible);
        for (const marker of this.transformMarkers) {
            marker.visible = this.displayTransforms;
        }
    }

    setDisplaySkeleton(visible) {
        this.displaySkeleton = Boolean(visible);
        if (this.skeletonHelper) {
            this.skeletonHelper.visible = this.displaySkeleton;
        }
    }

    setHandPosition(side, components) {
        if (!this.handTargets[side]) throw new Error(`Unknown hand: ${side}`);
        this.setVectorComponents(this.handTargets[side].position, components);
    }

    setHandRotation(side, components) {
        const target = this.handTargets[side];
        if (!target) throw new Error(`Unknown hand: ${side}`);
        for (const axis of ['x', 'y', 'z']) {
            if (components[axis] !== undefined) {
                target.rotation[axis] = THREE.MathUtils.degToRad(components[axis]);
            }
        }
    }

    setPolePosition(name, components) {
        const pole = this.poleTargets[name];
        if (!pole) throw new Error(`Unknown pole: ${name}`);
        this.setVectorComponents(pole.position, components);
    }

    setHandPolePosition(side, components) {
        this.setPolePosition(`${side}Elbow`, components);
    }

    setLegPolePosition(side, components) {
        this.setPolePosition(`${side}Knee`, components);
    }

    setArmIKEnabled(side, enabled) {
        if (side !== 'left' && side !== 'right') {
            throw new Error(`Unknown arm: ${side}`);
        }
        this.armIKEnabled[side] = Boolean(enabled);
    }

    setAnimation(name) {
        if (!this.animationClips.has(name)) {
            throw new Error(`Unknown animation: ${name}`);
        }
        if (this.currentAnimation === name) return;
        if (this.currentAction) this.currentAction.stop();

        this.currentAction = this.mixer.clipAction(this.animationClips.get(name));
        this.currentAction.reset().setLoop(THREE.LoopRepeat, Infinity).play();
        this.currentAction.paused = !this.playing;
        this.currentAnimation = name;
        this.mixer.update(0);
    }

    setPlaying(playing) {
        this.playing = Boolean(playing);
        if (this.currentAction) this.currentAction.paused = !this.playing;
    }

    isPlaying() {
        return this.playing;
    }

    getControlState() {
        const handState = side => ({
            position: this.vectorToObject(this.handTargets[side].position),
            rotation: this.rotationToDegrees(this.handTargets[side].rotation),
            pole: this.vectorToObject(this.poleTargets[`${side}Elbow`].position)
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
            ik: { ...this.armIKEnabled },
            hands: { left: handState('left'), right: handState('right') },
            legs: {
                left: { pole: this.vectorToObject(this.poleTargets.leftKnee.position) },
                right: { pole: this.vectorToObject(this.poleTargets.rightKnee.position) }
            }
        };
    }

    createTransformMarker(parent, radius, color) {
        const vertices = [];
        const segments = 32;

        for (const [u, v] of [[0, 1], [0, 2], [1, 2]]) {
            for (let i = 0; i < segments; i++) {
                const angleA = i * Math.PI * 2 / segments;
                const angleB = (i + 1) * Math.PI * 2 / segments;
                const pointA = [0, 0, 0];
                const pointB = [0, 0, 0];
                pointA[u] = Math.cos(angleA) * radius;
                pointA[v] = Math.sin(angleA) * radius;
                pointB[u] = Math.cos(angleB) * radius;
                pointB[v] = Math.sin(angleB) * radius;
                vertices.push(...pointA, ...pointB);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(vertices, 3)
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
        this.createTransformMarker(target, 0.035, color);
        return target;
    }

    createAnimationClip(sourceClip, sourceBones, targetBones, name) {
        const tracks = [];
        const sourceHips = sourceBones.get('hips');
        const targetHips = targetBones.get('hips');
        const sourceLeg = sourceBones.get('leftleg');
        const targetLeg = targetBones.get('leftleg');

        let motionScale = 1;
        if (sourceLeg && targetLeg && sourceLeg.position.length() > EPSILON) {
            motionScale = targetLeg.position.length() / sourceLeg.position.length();
        }

        const sourceHipRest = sourceHips ? sourceHips.position.clone() : null;
        const targetHipRest = targetHips.position.clone();
        const quaternion = new THREE.Quaternion();

        for (const sourceTrack of sourceClip.tracks) {
            const separator = sourceTrack.name.lastIndexOf('.');
            if (separator < 0) continue;

            let sourceName = sourceTrack.name.slice(0, separator);
            const property = sourceTrack.name.slice(separator + 1);
            const match = sourceName.match(/\.bones\[([^\]]+)\]/);
            if (match) sourceName = match[1];

            const normalizedName = this.normalizeBoneName(sourceName);
            const targetBone = targetBones.get(normalizedName);
            if (!targetBone) continue;

            if (property === 'quaternion') {
                const track = sourceTrack.clone();
                track.name = `${targetBone.uuid}.quaternion`;
                const sourceBone = sourceBones.get(normalizedName);

                if (sourceBone) {
                    const offset = targetBone.quaternion
                        .clone()
                        .multiply(sourceBone.quaternion.clone().invert());

                    for (let i = 0; i < track.values.length; i += 4) {
                        quaternion
                            .fromArray(track.values, i)
                            .premultiply(offset)
                            .normalize()
                            .toArray(track.values, i);
                    }
                }

                tracks.push(track);
            } else if (property === 'position' && targetBone === targetHips) {
                const track = sourceTrack.clone();
                track.name = `${targetBone.uuid}.position`;
                const rest = sourceHipRest || new THREE.Vector3(...track.values.slice(0, 3));

                for (let i = 0; i < track.values.length; i += 3) {
                    track.values[i] = targetHipRest.x + (track.values[i] - rest.x) * motionScale;
                    track.values[i + 1] = targetHipRest.y + (track.values[i + 1] - rest.y) * motionScale;
                    track.values[i + 2] = targetHipRest.z + (track.values[i + 2] - rest.z) * motionScale;
                }

                tracks.push(track);
            }
        }

        if (!tracks.length) {
            throw new Error(`No compatible animation tracks in ${name}.`);
        }

        return new THREE.AnimationClip(name, sourceClip.duration, tracks);
    }

    // Models and animations are loaded by Scene.
    initialize(origin, loadedAvatar, animationModels) {
        this.origin = origin;
        this.model = loadedAvatar;

        this.model.traverse(child => {
            if (child.isSkinnedMesh) child.frustumCulled = false;
        });

        this.root = new THREE.Group();
        this.root.name = 'Avatar';
        this.root.add(this.model);
        origin.add(this.root);

        const bounds = new THREE.Box3().setFromObject(this.model);
        const rawHeight = bounds.getSize(new THREE.Vector3()).y;
        if (rawHeight < EPSILON) throw new Error('Invalid avatar height.');

        this.root.scale.setScalar(this.height / rawHeight);
        this.root.updateWorldMatrix(true, true);

        const scaledBounds = new THREE.Box3().setFromObject(this.model);
        this.root.position.y = -scaledBounds.min.y;
        this.root.updateWorldMatrix(true, true);

        const targetBones = this.collectBones(this.model);
        const sourceSets = new Map(
            Object.entries(animationModels).map(([name, object]) => [
                name,
                this.collectBones(object)
            ])
        );

        this.hips = targetBones.get('hips');
        this.head = targetBones.get('head');

        const lu = targetBones.get('leftupleg');
        const ll = targetBones.get('leftleg');
        const lf = targetBones.get('leftfoot');
        const lt = targetBones.get('lefttoebase');
        const ru = targetBones.get('rightupleg');
        const rl = targetBones.get('rightleg');
        const rf = targetBones.get('rightfoot');
        const rt = targetBones.get('righttoebase');
        const la = targetBones.get('leftarm');
        const lfa = targetBones.get('leftforearm');
        const lh = targetBones.get('lefthand');
        const ra = targetBones.get('rightarm');
        const rfa = targetBones.get('rightforearm');
        const rh = targetBones.get('righthand');

        const required = [
            this.hips, this.head,
            lu, ll, lf, ru, rl, rf,
            la, lfa, lh, ra, rfa, rh
        ];

        if (required.some(bone => !bone)) {
            console.table([...targetBones.keys()]);
            throw new Error('Missing required Mixamo bones.');
        }

        const validHierarchy =
            this.isDescendantOf(lu, this.hips) &&
            this.isDescendantOf(ll, lu) &&
            this.isDescendantOf(lf, ll) &&
            this.isDescendantOf(ru, this.hips) &&
            this.isDescendantOf(rl, ru) &&
            this.isDescendantOf(rf, rl) &&
            this.isDescendantOf(lfa, la) &&
            this.isDescendantOf(lh, lfa) &&
            this.isDescendantOf(rfa, ra) &&
            this.isDescendantOf(rh, rfa);

        if (!validHierarchy) {
            throw new Error('Invalid limb hierarchy for two-bone IK.');
        }

        this.headRestQuaternion.copy(this.head.quaternion);

        this.hips.getWorldPosition(this.initialHipsPosition);
        this.origin.worldToLocal(this.initialHipsPosition);
        this.#hipsPositionY = this.initialHipsPosition.y;

        this.legIK = [
            new IK({ bones: [lu, ll, lf], poleBone: lt }),
            new IK({ bones: [ru, rl, rf], poleBone: rt })
        ];

        this.handIK.left = new IK({ bones: [la, lfa, lh] });
        this.handIK.right = new IK({ bones: [ra, rfa, rh] });

        for (const side of ['left', 'right']) {
            const target = new THREE.Object3D();
            target.name = `${side}HandTarget`;
            target.position.set(...DEFAULT_TRANSFORMS[`${side}Hand`]);
            target.rotation.set(
                ...DEFAULT_TRANSFORMS[`${side}HandRotation`].map(THREE.MathUtils.degToRad),
                'XYZ'
            );
            origin.add(target);
            this.handTargets[side] = target;
            this.createTransformMarker(
                target,
                0.055,
                side === 'left' ? 0xffaa33 : 0x33ccff
            );
        }

        this.poleAnchor = new THREE.Group();
        this.poleAnchor.name = 'PoleAnchor';
        origin.add(this.poleAnchor);

        const colors = {
            leftElbow: 0xffaa33,
            rightElbow: 0x33ccff,
            leftKnee: 0xffdd33,
            rightKnee: 0x66ff66
        };

        for (const name of ['leftElbow', 'rightElbow', 'leftKnee', 'rightKnee']) {
            this.poleTargets[name] = this.createPoleTarget(
                this.poleAnchor,
                name,
                DEFAULT_TRANSFORMS[name],
                colors[name]
            );
        }

        this.legIK[0].setPoleTarget(this.poleTargets.leftKnee);
        this.legIK[1].setPoleTarget(this.poleTargets.rightKnee);
        this.handIK.left.setPoleTarget(this.poleTargets.leftElbow);
        this.handIK.right.setPoleTarget(this.poleTargets.rightElbow);

        const hipsParent = this.hips.parent;
        this.hipOffset = new THREE.Object3D();
        this.hipOffset.name = 'DynamicHipOffset';
        hipsParent.add(this.hipOffset);
        this.hipOffset.add(this.hips);
        this.root.updateWorldMatrix(true, true);

        this.skeletonHelper = new THREE.SkeletonHelper(this.root);

        // Clone the local matrix: SkeletonHelper otherwise references root.matrixWorld.
        this.skeletonHelper.matrix = this.root.matrix.clone();
        this.skeletonHelper.matrixAutoUpdate = false;
        this.skeletonHelper.material.depthTest = false;
        this.skeletonHelper.material.transparent = true;
        this.skeletonHelper.material.opacity = 0.9;
        this.skeletonHelper.renderOrder = 10;
        this.skeletonHelper.visible = this.displaySkeleton;
        origin.add(this.skeletonHelper);

        this.mixer = new THREE.AnimationMixer(this.model);

        for (const [name, object] of Object.entries(animationModels)) {
            if (!object.animations.length) {
                throw new Error(`${name}.fbx contains no animation.`);
            }

            this.animationClips.set(
                name,
                this.createAnimationClip(
                    object.animations[0],
                    sourceSets.get(name),
                    targetBones,
                    name
                )
            );
        }

        this.setAnimation(
            this.animationClips.has('walk')
                ? 'walk'
                : this.animationClips.keys().next().value
        );

        console.log('Character ready:', [...this.animationClips.keys()]);
        return this;
    }

    update(deltaTime) {
        if (!this.mixer) return;

        for (const chain of this.legIK) chain.restorePose();
        for (const chain of Object.values(this.handIK)) chain.restorePose();

        const neutralHipsY = this.initialHipsPosition.y * this.origin.scale.y;
        this.crouchDeltaY = this.#hipsPositionY - neutralHipsY;
        this.worldDelta.set(0, this.crouchDeltaY, 0);
        this.worldToParentDelta(
            this.hipOffset,
            this.worldDelta,
            this.hipOffset.position
        );

        this.mixer.update(deltaTime);
        this.applyHeadOverride();
        this.root.updateWorldMatrix(true, true);

        for (const chain of this.legIK) chain.captureAnimatedPose(this.worldDelta);
        for (const chain of Object.values(this.handIK)) {
            chain.captureAnimatedPose(this.worldDelta);
        }

        if (Math.abs(this.crouchDeltaY) > EPSILON) {
            for (const chain of this.legIK) chain.solve();
        }

        for (const side of ['left', 'right']) {
            if (!this.armIKEnabled[side]) continue;

            const target = this.handTargets[side];
            target.getWorldPosition(this.targetPosition);
            target.getWorldQuaternion(this.targetQuaternion);
            this.handIK[side].solveToTarget(
                this.targetPosition,
                this.targetQuaternion,
                { stretch: true }
            );
        }

        this.root.updateWorldMatrix(true, true);
    }
}
