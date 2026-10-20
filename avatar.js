
import * as THREE from 'three';
import { IK } from './ik.js';

const EPSILON = 1e-6;

const DEFAULT_TRANSFORMS = {
    leftHand: [0.32, 1, 0.20],
    leftHandRotation: [90, -45, -10],
    rightHand: [-0.32, 1, 0.20],
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

        this.model = null;
        this.root = null;
        this.mixer = null;
        this.hips = null;
        this.hipOffset = null;
        this.elbowPoleAnchor = null;
        this.skeletonHelper = null;

        this.legIK = [];
        this.handIK = {};

        // Independent IK state for each arm.
        this.armIKEnabled = {
            left: true,
            right: true
        };

        this.handTargets = {};
        this.poleTargets = {};
        this.transformMarkers = [];

        this.displayTransforms = true;
        this.displaySkeleton = true;

        // Animation state.

        this.animationClips = new Map();
        this.currentAnimation = null;
        this.currentAction = null;
        this.playing = true;

        // Temporary transforms.

        this.initialHipsPosition = new THREE.Vector3();
        this.positionY = 0;

        this.worldDelta = new THREE.Vector3();
        this.inverseMatrix = new THREE.Matrix3();

        this.targetPosition = new THREE.Vector3();
        this.targetQuaternion = new THREE.Quaternion();
    }

    // --------------------------------------------------
    // Generic skeleton utilities
    // --------------------------------------------------

    normalizeBoneName(name) {
        return name
            .replace(/^.*[|:]/, '')
            .replace(/^mixamorig\d*/i, '')
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase();
    }

    collectBones(object) {
        const bones = new Map();

        object.traverse((child) => {
            if (!child.isBone) return;

            const name = this.normalizeBoneName(child.name);

            if (!bones.has(name)) {
                bones.set(name, child);
            }
        });

        return bones;
    }

    isDescendantOf(object, ancestor) {
        let current = object.parent;

        while (current) {
            if (current === ancestor) return true;
            current = current.parent;
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
    // Public transform setters
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
            this.skeletonHelper.visible = this.displaySkeleton;
        }
    }

    setPositionY(value) {
        this.positionY = THREE.MathUtils.clamp(
            value,
            this.initialHipsPosition.y - this.maxCrouch,
            this.initialHipsPosition.y - this.minCrouch
        );

        // Elbow poles follow the manually controlled hips offset,
        // not the vertical movement from the animation.

        if (this.elbowPoleAnchor) {
            this.elbowPoleAnchor.position.y =
                this.positionY - this.initialHipsPosition.y;
        }

        return this.positionY;
    }

    setHandPosition(side, components) {
        const target = this.handTargets[side];

        if (!target) {
            throw new Error(`Unknown hand: ${side}`);
        }

        this.setVectorComponents(
            target.position,
            components
        );
    }

    setHandRotation(side, components) {
        const target = this.handTargets[side];

        if (!target) {
            throw new Error(`Unknown hand: ${side}`);
        }

        for (const axis of ['x', 'y', 'z']) {
            if (components[axis] !== undefined) {
                target.rotation[axis] = THREE.MathUtils.degToRad(
                    components[axis]
                );
            }
        }
    }

    setPolePosition(name, components) {
        const pole = this.poleTargets[name];

        if (!pole) {
            throw new Error(`Unknown pole: ${name}`);
        }

        this.setVectorComponents(
            pole.position,
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

    // Enable or disable analytical IK independently for each arm.

    setArmIKEnabled(side, enabled) {
        if (side !== 'left' && side !== 'right') {
            throw new Error(`Unknown arm: ${side}`);
        }

        this.armIKEnabled[side] = Boolean(enabled);
    }

    isArmIKEnabled(side) {
        if (side !== 'left' && side !== 'right') {
            throw new Error(`Unknown arm: ${side}`);
        }

        return this.armIKEnabled[side];
    }

    // --------------------------------------------------
    // Animation controls
    // --------------------------------------------------

    setAnimation(name) {
        if (!this.animationClips.has(name)) {
            throw new Error(`Unknown animation: ${name}`);
        }

        if (this.currentAnimation === name) {
            return;
        }

        if (this.currentAction) {
            this.currentAction.stop();
        }

        this.currentAction = this.mixer.clipAction(
            this.animationClips.get(name)
        );

        this.currentAction.reset();

        this.currentAction.setLoop(
            THREE.LoopRepeat,
            Infinity
        );

        this.currentAction.play();
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
    // Public state
    // --------------------------------------------------

    getControlState() {
        const getHand = (side) => ({
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
                left: this.armIKEnabled.left,
                right: this.armIKEnabled.right
            },

            avatar: {
                position: {
                    y: this.positionY
                },

                positionLimits: {
                    min: this.initialHipsPosition.y - this.maxCrouch,
                    max: this.initialHipsPosition.y - this.minCrouch
                }
            },

            hands: {
                left: getHand('left'),
                right: getHand('right')
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
    // Wireframe transform markers
    // --------------------------------------------------

    createTransformMarker(parent, radius, color) {
        const vertices = [];
        const segments = 32;

        // Three perpendicular circles: XY, XZ, YZ.

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

        const material = new THREE.LineBasicMaterial({
            color,
            depthTest: false,
            transparent: true,
            opacity: 0.95
        });

        const marker = new THREE.LineSegments(
            geometry,
            material
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
    // Mixamo animation retargeting
    // --------------------------------------------------

    createAnimationClip(sourceClip, sourceBones, targetBones, name) {
        const tracks = [];

        const sourceHips = sourceBones.get('hips');
        const targetHips = targetBones.get('hips');

        const sourceLeg = sourceBones.get('leftleg');
        const targetLeg = targetBones.get('leftleg');

        let motionScale = 1;

        if (sourceLeg && targetLeg) {
            const sourceLength = sourceLeg.position.length();
            const targetLength = targetLeg.position.length();

            if (sourceLength > EPSILON) {
                motionScale = targetLength / sourceLength;
            }
        }

        const sourceHipRest = sourceHips
            ? sourceHips.position.clone()
            : null;

        const targetHipRest = targetHips.position.clone();
        const sourceQuaternion = new THREE.Quaternion();

        for (const sourceTrack of sourceClip.tracks) {
            const separator = sourceTrack.name.lastIndexOf('.');

            if (separator === -1) continue;

            let sourceName = sourceTrack.name.slice(0, separator);
            const property = sourceTrack.name.slice(separator + 1);

            const boneMatch = sourceName.match(/\.bones\[([^\]]+)\]/);

            if (boneMatch) {
                sourceName = boneMatch[1];
            }

            const normalizedName = this.normalizeBoneName(sourceName);
            const targetBone = targetBones.get(normalizedName);

            if (!targetBone) continue;

            if (property === 'quaternion') {
                const track = sourceTrack.clone();

                track.name = `${targetBone.uuid}.quaternion`;

                const sourceBone = sourceBones.get(normalizedName);

                if (sourceBone) {
                    const rotationOffset = targetBone.quaternion
                        .clone()
                        .multiply(sourceBone.quaternion.clone().invert());

                    for (let i = 0; i < track.values.length; i += 4) {
                        sourceQuaternion
                            .fromArray(track.values, i)
                            .premultiply(rotationOffset)
                            .normalize()
                            .toArray(track.values, i);
                    }
                }

                tracks.push(track);
                continue;
            }

            if (property === 'position' && targetBone === targetHips) {
                const track = sourceTrack.clone();

                track.name = `${targetBone.uuid}.position`;

                const reference = sourceHipRest || new THREE.Vector3(
                    track.values[0],
                    track.values[1],
                    track.values[2]
                );

                for (let i = 0; i < track.values.length; i += 3) {
                    track.values[i] =
                        targetHipRest.x +
                        (track.values[i] - reference.x) * motionScale;

                    track.values[i + 1] =
                        targetHipRest.y +
                        (track.values[i + 1] - reference.y) * motionScale;

                    track.values[i + 2] =
                        targetHipRest.z +
                        (track.values[i + 2] - reference.z) * motionScale;
                }

                tracks.push(track);
            }
        }

        if (!tracks.length) {
            throw new Error(
                `No compatible animation tracks in ${name}.`
            );
        }

        console.log(
            `Mapped animation tracks (${name}): ${tracks.length}`
        );

        return new THREE.AnimationClip(
            name,
            sourceClip.duration,
            tracks
        );
    }

    // --------------------------------------------------
    // Initialization
    // --------------------------------------------------

    initialize(scene, loadedAvatar, animationModels) {
        this.model = loadedAvatar;

        this.model.traverse((child) => {
            if (child.isSkinnedMesh) {
                child.frustumCulled = false;
            }
        });

        // Normalize character height.

        this.root = new THREE.Group();

        this.root.add(this.model);
        scene.add(this.root);

        const bounds = new THREE.Box3().setFromObject(this.model);
        const size = bounds.getSize(new THREE.Vector3());

        if (size.y <= 0) {
            throw new Error('Invalid avatar height.');
        }

        this.root.scale.setScalar(
            this.height / size.y
        );

        this.root.updateMatrixWorld(true);

        const scaledBounds = new THREE.Box3().setFromObject(this.model);

        this.root.position.y = -scaledBounds.min.y;
        this.root.updateMatrixWorld(true);

        // Resolve skeleton bones.

        const targetBones = this.collectBones(this.model);

        this.hips = targetBones.get('hips');

        const leftUpper = targetBones.get('leftupleg');
        const leftLower = targetBones.get('leftleg');
        const leftFoot = targetBones.get('leftfoot');
        const leftToe = targetBones.get('lefttoebase');

        const rightUpper = targetBones.get('rightupleg');
        const rightLower = targetBones.get('rightleg');
        const rightFoot = targetBones.get('rightfoot');
        const rightToe = targetBones.get('righttoebase');

        const leftArm = targetBones.get('leftarm');
        const leftForeArm = targetBones.get('leftforearm');
        const leftHand = targetBones.get('lefthand');

        const rightArm = targetBones.get('rightarm');
        const rightForeArm = targetBones.get('rightforearm');
        const rightHand = targetBones.get('righthand');

        const required = [
            this.hips,
            leftUpper,
            leftLower,
            leftFoot,
            rightUpper,
            rightLower,
            rightFoot,
            leftArm,
            leftForeArm,
            leftHand,
            rightArm,
            rightForeArm,
            rightHand
        ];

        if (required.some((bone) => !bone)) {
            console.table([...targetBones.keys()]);

            throw new Error(
                'Missing required Mixamo limb bones.'
            );
        }

        const validHierarchy =
            this.isDescendantOf(leftUpper, this.hips) &&
            this.isDescendantOf(leftLower, leftUpper) &&
            this.isDescendantOf(leftFoot, leftLower) &&
            this.isDescendantOf(rightUpper, this.hips) &&
            this.isDescendantOf(rightLower, rightUpper) &&
            this.isDescendantOf(rightFoot, rightLower) &&
            this.isDescendantOf(leftForeArm, leftArm) &&
            this.isDescendantOf(leftHand, leftForeArm) &&
            this.isDescendantOf(rightForeArm, rightArm) &&
            this.isDescendantOf(rightHand, rightForeArm);

        if (!validHierarchy) {
            throw new Error(
                'Invalid limb hierarchy for two-bone IK.'
            );
        }

        // --------------------------------------------------
        // IK chains
        // --------------------------------------------------

        this.legIK.push(
            new IK({
                bones: [leftUpper, leftLower, leftFoot],
                poleBone: leftToe
            }),
            new IK({
                bones: [rightUpper, rightLower, rightFoot],
                poleBone: rightToe
            })
        );

        this.handIK.left = new IK({
            bones: [leftArm, leftForeArm, leftHand]
        });

        this.handIK.right = new IK({
            bones: [rightArm, rightForeArm, rightHand]
        });

        // --------------------------------------------------
        // Initial hips position
        // --------------------------------------------------

        this.hips.updateWorldMatrix(true, false);
        this.hips.getWorldPosition(this.initialHipsPosition);

        this.positionY =
            this.initialHipsPosition.y - this.minCrouch;

        // --------------------------------------------------
        // Default absolute hand targets
        // --------------------------------------------------

        for (const side of ['left', 'right']) {
            const target = new THREE.Object3D();

            target.name = `${side}HandTarget`;

            target.position.set(
                ...DEFAULT_TRANSFORMS[`${side}Hand`]
            );

            const rotation =
                DEFAULT_TRANSFORMS[`${side}HandRotation`];

            target.rotation.set(
                ...rotation.map(THREE.MathUtils.degToRad),
                'XYZ'
            );

            scene.add(target);

            this.handTargets[side] = target;

            this.createTransformMarker(
                target,
                0.055,
                side === 'left' ? 0xffaa33 : 0x33ccff
            );
        }

        // --------------------------------------------------
        // Default pole targets
        // --------------------------------------------------

        const colors = {
            leftElbow: 0xffaa33,
            rightElbow: 0x33ccff,
            leftKnee: 0xffdd33,
            rightKnee: 0x66ff66
        };

        // The elbows follow the manually set hips Y offset,
        // while knee poles remain fixed in world space.

        this.elbowPoleAnchor = new THREE.Group();
        this.elbowPoleAnchor.name = 'ElbowPoleAnchor';

        this.elbowPoleAnchor.position.y =
            this.positionY - this.initialHipsPosition.y;

        scene.add(this.elbowPoleAnchor);

        for (const name of [
            'leftElbow',
            'rightElbow',
            'leftKnee',
            'rightKnee'
        ]) {
            const parent = this.elbowPoleAnchor;

            this.poleTargets[name] = this.createPoleTarget(
                parent,
                name,
                DEFAULT_TRANSFORMS[name],
                colors[name]
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

        // --------------------------------------------------
        // Hips offset pivot
        // --------------------------------------------------

        const originalParent = this.hips.parent;

        this.hipOffset = new THREE.Object3D();
        this.hipOffset.name = 'DynamicHipOffset';

        originalParent.add(this.hipOffset);
        this.hipOffset.add(this.hips);

        this.model.updateWorldMatrix(true, true);

        // --------------------------------------------------
        // Skeleton helper
        // --------------------------------------------------

        this.skeletonHelper = new THREE.SkeletonHelper(
            this.model
        );

        this.skeletonHelper.material.depthTest = false;
        this.skeletonHelper.material.transparent = true;
        this.skeletonHelper.material.opacity = 0.9;
        this.skeletonHelper.renderOrder = 10;
        this.skeletonHelper.visible = this.displaySkeleton;

        scene.add(this.skeletonHelper);

        // --------------------------------------------------
        // Register loaded animations
        // --------------------------------------------------

        this.mixer = new THREE.AnimationMixer(this.model);

        for (const [name, sourceModel] of Object.entries(animationModels)) {
            if (!sourceModel.animations.length) {
                throw new Error(
                    `${name}.fbx contains no animation.`
                );
            }

            const sourceBones = this.collectBones(sourceModel);

            const clip = this.createAnimationClip(
                sourceModel.animations[0],
                sourceBones,
                targetBones,
                name
            );

            this.animationClips.set(name, clip);
        }

        const defaultAnimation = this.animationClips.has('walk')
            ? 'walk'
            : this.animationClips.keys().next().value;

        this.setAnimation(defaultAnimation);

        console.log('Character ready');
        console.log(
            'Available animations:',
            [...this.animationClips.keys()]
        );

        return this;
    }

    // --------------------------------------------------
    // Animation pipeline
    // --------------------------------------------------

    update(deltaTime) {
        if (!this.mixer) return;

        // 1. Restore the original animated pose.
        //
        // This must include disabled arms: otherwise the IK
        // modification from the previous frame would persist.

        for (const chain of this.legIK) {
            chain.restorePose();
        }

        for (const chain of Object.values(this.handIK)) {
            chain.restorePose();
        }

        // 2. Apply manual hips displacement.

        const crouchDeltaY =
            this.positionY - this.initialHipsPosition.y;

        this.worldDelta.set(0, crouchDeltaY, 0);

        this.worldToParentDelta(
            this.hipOffset,
            this.worldDelta,
            this.hipOffset.position
        );

        // 3. Evaluate the current Mixamo animation.

        this.mixer.update(deltaTime);
        this.model.updateWorldMatrix(true, true);

        // 4. Capture animation poses before any IK operation.

        for (const chain of this.legIK) {
            chain.captureAnimatedPose(this.worldDelta);
        }

        for (const chain of Object.values(this.handIK)) {
            chain.captureAnimatedPose(this.worldDelta);
        }

        // 5. Preserve animated feet during crouching.

        if (Math.abs(crouchDeltaY) > EPSILON) {
            for (const chain of this.legIK) {
                chain.solve();
            }
        }

        // 6. Apply IK only to enabled arms.
        // Disabled arms keep their complete animation pose,
        // including upper arm, forearm and hand transforms.

        for (const side of ['left', 'right']) {
            if (!this.armIKEnabled[side]) {
                continue;
            }

            const target = this.handTargets[side];

            target.getWorldPosition(this.targetPosition);
            target.getWorldQuaternion(this.targetQuaternion);

            this.handIK[side].solveToTarget(
                this.targetPosition,
                this.targetQuaternion,
                { stretch: true }
            );
        }

        // 7. Update final skeleton matrices.

        this.model.updateWorldMatrix(true, true);
    }
}
