import * as THREE from "three";

const EPSILON = 1e-6;

const SIDES = ["left", "right"];

const CHAINS = {
    leftArm: ["LeftArm", "LeftForeArm", "LeftHand"],
    rightArm: ["RightArm", "RightForeArm", "RightHand"],
    leftLeg: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
    rightLeg: ["RightUpLeg", "RightLeg", "RightFoot"]
};

const POLES = {
    leftElbow: ["LeftForeArm", 0.18, -0.12],
    rightElbow: ["RightForeArm", -0.18, -0.12],
    leftKnee: ["LeftLeg", 0.08, 0.18],
    rightKnee: ["RightLeg", -0.08, 0.18]
};

// Legacy version 2 values are converted to normalized root coordinates.
// Version 3 configurations are already normalized.
const DEFAULT_IK = {
    version: 2,
    hands: {
        left: {
            position: [70.74850518649906, 303.96564505068204, 63.134803850735715],
            quaternion: [0.566713835449331, -0.40132466388805255, -0.3973534796597484, 0.5999034547889688]
        },
        right: {
            position: [-70.74850518649906, 303.96564505068204, 63.1348038507357],
            quaternion: [0.566713835449331, 0.40132466388805255, 0.3973534796597484, 0.5999034547889688]
        }
    },
    poles: {
        leftElbow: [171.15641342492847, 57.69315786861378, -155.49666047603446],
        rightElbow: [-196.44786844567946, 43.84547346226896, -158.02885740542385],
        leftKnee: [50.725906957497564, 100.17165119081419, 246.71200215428763],
        rightKnee: [-50.72590695749758, 100.17165119081419, 246.71200215428763]
    }
};

function scaledVector(values, scale) {
    return values.map(value => value * scale);
}

class TwoBoneIK {
    constructor(bones, poleTarget = null) {
        if (bones.length !== 3 || bones.some(bone => !bone?.isBone)) {
            throw new Error("Simple IK requires exactly three bones.");
        }

        for (let i = 1; i < bones.length; i++) {
            let parent = bones[i].parent;
            let valid = false;

            while (parent) {
                if (parent === bones[i - 1]) {
                    valid = true;
                    break;
                }

                parent = parent.parent;
            }

            if (!valid) {
                throw new Error("Invalid IK joint hierarchy.");
            }
        }

        this.bones = bones;
        this.root = bones[0];
        this.middle = bones[1];
        this.end = bones[2];

        this.poleTarget = poleTarget;

        this.savedPositions = bones.map(() => new THREE.Vector3());
        this.savedQuaternions = bones.map(() => new THREE.Quaternion());
        this.savedScales = bones.map(() => new THREE.Vector3());

        this.hasSavedPose = false;

        this.animatedRoot = new THREE.Vector3();
        this.animatedMiddle = new THREE.Vector3();

        this.target = new THREE.Vector3();
        this.targetQuaternion = new THREE.Quaternion();

        this.cachedPole = new THREE.Vector3(0, 0, 1);
    }

    restorePose() {
        if (!this.hasSavedPose) {
            return;
        }

        for (let i = 0; i < 3; i++) {
            this.bones[i].position.copy(this.savedPositions[i]);
            this.bones[i].quaternion.copy(this.savedQuaternions[i]);
            this.bones[i].scale.copy(this.savedScales[i]);
        }
    }

    captureAnimatedPose(worldDelta) {
        this.root.updateWorldMatrix(true, true);

        this.root.getWorldPosition(this.animatedRoot);
        this.middle.getWorldPosition(this.animatedMiddle);
        this.end.getWorldPosition(this.target);

        this.animatedRoot.sub(worldDelta);
        this.animatedMiddle.sub(worldDelta);
        this.target.sub(worldDelta);

        this.end.getWorldQuaternion(this.targetQuaternion);

        for (let i = 0; i < 3; i++) {
            this.savedPositions[i].copy(this.bones[i].position);
            this.savedQuaternions[i].copy(this.bones[i].quaternion);
            this.savedScales[i].copy(this.bones[i].scale);
        }

        this.hasSavedPose = true;
    }

    solve() {
        if (!this.hasSavedPose) {
            return;
        }

        this.solveTwoBone();
        this.restoreEndOrientation();
    }

    solveToTarget(position, quaternion, { stretch = false } = {}) {
        if (!this.hasSavedPose) {
            return;
        }

        this.target.copy(position);
        this.targetQuaternion.copy(quaternion);

        if (stretch) {
            this.stretchToReach();
        }

        this.solveTwoBone();
        this.restoreEndOrientation();
        this.pinEndPosition();
    }

    stretchToReach() {
        const positions = this.bones.map(bone => {
            return bone.getWorldPosition(new THREE.Vector3());
        });

        const upper = positions[0].distanceTo(positions[1]);
        const lower = positions[1].distanceTo(positions[2]);

        const total = upper + lower;

        if (total < EPSILON) {
            return;
        }

        const distance = positions[0].distanceTo(this.target);
        const minimum = Math.abs(upper - lower);
        const margin = Math.max(total * 0.001, EPSILON * 10);

        let factor = 1;

        if (distance >= total - margin) {
            factor = (distance + margin) / total;
        } else if (
            minimum > EPSILON &&
            distance < minimum + margin
        ) {
            factor = Math.max(
                1e-4,
                (distance - margin) / minimum
            );
        }

        if (Math.abs(factor - 1) < EPSILON) {
            return;
        }

        for (let i = 1; i < 3; i++) {
            const bone = this.bones[i];

            const desired = positions[i]
                .clone()
                .sub(positions[0])
                .multiplyScalar(factor)
                .add(positions[0]);

            bone.parent.updateWorldMatrix(true, false);

            bone.position.copy(
                bone.parent.worldToLocal(desired)
            );

            bone.updateWorldMatrix(true, true);
        }
    }

    computePole(axis, rootPosition) {
        const pole = new THREE.Vector3();

        if (this.poleTarget) {
            this.poleTarget.getWorldPosition(pole);
            pole.sub(rootPosition);
        } else {
            pole.subVectors(
                this.animatedMiddle,
                this.animatedRoot
            );
        }

        pole.addScaledVector(
            axis,
            -pole.dot(axis)
        );

        if (pole.lengthSq() < EPSILON) {
            pole.copy(this.cachedPole);
            pole.addScaledVector(axis, -pole.dot(axis));
        }

        if (pole.lengthSq() < EPSILON) {
            pole.set(0, 0, 1);
            pole.addScaledVector(axis, -pole.dot(axis));
        }

        if (pole.lengthSq() < EPSILON) {
            pole.set(1, 0, 0);
            pole.addScaledVector(axis, -pole.dot(axis));
        }

        pole.normalize();

        this.cachedPole.copy(pole);

        return pole;
    }

    solveTwoBone() {
        const rootPosition = this.root.getWorldPosition(
            new THREE.Vector3()
        );

        const middlePosition = this.middle.getWorldPosition(
            new THREE.Vector3()
        );

        const endPosition = this.end.getWorldPosition(
            new THREE.Vector3()
        );

        const upper = rootPosition.distanceTo(middlePosition);
        const lower = middlePosition.distanceTo(endPosition);

        if (upper < EPSILON || lower < EPSILON) {
            return;
        }

        const axis = this.target
            .clone()
            .sub(rootPosition);

        const actualDistance = axis.length();

        if (actualDistance < EPSILON) {
            axis.set(0, -1, 0);
        } else {
            axis.divideScalar(actualDistance);
        }

        const minReach = Math.abs(upper - lower);
        const maxReach = upper + lower;

        const distance = THREE.MathUtils.clamp(
            actualDistance,
            minReach + EPSILON,
            Math.max(
                minReach + EPSILON,
                maxReach - EPSILON
            )
        );

        const desiredEnd = rootPosition
            .clone()
            .addScaledVector(axis, distance);

        const pole = this.computePole(
            axis,
            rootPosition
        );

        const x = (
            upper * upper -
            lower * lower +
            distance * distance
        ) / (2 * distance);

        const h = Math.sqrt(
            Math.max(0, upper * upper - x * x)
        );

        const desiredMiddle = rootPosition
            .clone()
            .addScaledVector(axis, x)
            .addScaledVector(pole, h);

        this.rotateBoneToTarget(
            this.root,
            rootPosition,
            middlePosition,
            desiredMiddle
        );

        this.middle.getWorldPosition(middlePosition);
        this.end.getWorldPosition(endPosition);

        this.rotateBoneToTarget(
            this.middle,
            middlePosition,
            endPosition,
            desiredEnd
        );
    }

    rotateBoneToTarget(bone, origin, currentEndpoint, desiredEndpoint) {
        const from = currentEndpoint
            .clone()
            .sub(origin);

        const to = desiredEndpoint
            .clone()
            .sub(origin);

        if (
            from.lengthSq() < EPSILON ||
            to.lengthSq() < EPSILON
        ) {
            return;
        }

        from.normalize();
        to.normalize();

        const delta = new THREE.Quaternion()
            .setFromUnitVectors(from, to);

        const world = bone.getWorldQuaternion(
            new THREE.Quaternion()
        );

        const parent = bone.parent.getWorldQuaternion(
            new THREE.Quaternion()
        );

        bone.quaternion
            .copy(parent.invert())
            .multiply(delta)
            .multiply(world)
            .normalize();

        bone.updateWorldMatrix(true, true);
    }

    restoreEndOrientation() {
        const parent = this.end.parent.getWorldQuaternion(
            new THREE.Quaternion()
        );

        this.end.quaternion
            .copy(parent.invert())
            .multiply(this.targetQuaternion)
            .normalize();

        this.end.updateWorldMatrix(true, true);
    }

    pinEndPosition() {
        const actual = this.end.getWorldPosition(
            new THREE.Vector3()
        );

        const residual = this.target
            .clone()
            .sub(actual);

        if (residual.lengthSq() < 1e-18) {
            return;
        }

        this.end.parent.updateWorldMatrix(true, false);

        const inverse = new THREE.Matrix3()
            .setFromMatrix4(this.end.parent.matrixWorld)
            .invert();

        this.end.position.add(
            residual.applyMatrix3(inverse)
        );

        this.end.updateWorldMatrix(true, true);
    }
}

export default class IKController {
    constructor(session) {
        this.session = session;

        this.avatar = null;
        this.root = null;
        this.hips = null;
        this.hipTarget = null;

        this.hipBasePosition = new THREE.Vector3();

        this.hipsDelta = 0;
        this.appliedHipDelta = 0;

        this.handTargets = {};
        this.poleTargets = {};
        this.chains = {};

        this.targets = new Map();
        this.markers = [];

        this.markerGeometry = new THREE.SphereGeometry(
            1,
            16,
            12
        );

        this.baseState = null;
        this.defaultState = null;

        this.selectedKey = "hips";

        this.visible = false;
        this.active = false;
        this.ready = false;
        this.error = null;

        this.worldDelta = new THREE.Vector3();

        this.onSessionChange = () => {
            if (this.session.avatar !== this.avatar) {
                this.rebuild();
            }
        };

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        if (this.session.avatar) {
            this.rebuild();
        }
    }

    rebuild() {
        const wasVisible = this.visible;

        this.clear();

        this.avatar = this.session.avatar;

        if (!this.avatar) {
            return;
        }

        try {
            this.initializeSkeleton();

            this.baseState = this.serialize();
            this.defaultState = this.normalizeState(DEFAULT_IK);

            this.applyState(this.defaultState);

            const saved = this.session.metadata.ik;

            if (saved && Object.keys(saved).length) {
                this.applyState(
                    this.normalizeState(saved)
                );
            }

            this.ready = true;
            this.error = null;

            this.setVisible(wasVisible);
        } catch (error) {
            this.clear();

            this.error = error.message;

            console.warn("IK unavailable:", error);
        }
    }

    initializeSkeleton() {
        const getBone = name => {
            const bone = this.session.getBone(name);

            if (!bone?.isBone) {
                throw new Error(`Missing IK bone: ${name}`);
            }

            if (!/^(left|right)Hand$/i.test(name)) {
                return bone;
            }

            // Use the proximal wrist when GLB import creates
            // nested duplicate hand joints.
            let wrist = bone;

            const baseName = name.toLowerCase();

            while (wrist.parent?.isBone) {
                const parentName = wrist.parent.name.toLowerCase();

                if (
                    parentName !== baseName &&
                    !new RegExp(`^${baseName}_\\d+$`).test(parentName)
                ) {
                    break;
                }

                wrist = wrist.parent;
            }

            return wrist;
        };

        this.hips = getBone("Hips");
        this.root = getBone("root");

        if (this.hips.parent !== this.root) {
            throw new Error(
                "Expected Hips to be a direct child of root."
            );
        }

        this.avatar.updateWorldMatrix(true, true);

        // HipsTarget is independent from the animated Hips bone.
        // It represents the requested pelvis position.
        this.hipTarget = new THREE.Object3D();

        this.hipTarget.name = "HipsTarget";

        this.root.add(this.hipTarget);

        const hipsPosition = this.hips.getWorldPosition(
            new THREE.Vector3()
        );

        this.hipTarget.position.copy(
            this.root.worldToLocal(hipsPosition)
        );

        this.hipBasePosition.copy(
            this.hipTarget.position
        );

        this.targets.set("hips", this.hipTarget);

        // Elbow poles are children of HipsTarget.
        // Knee poles are direct children of root.
        for (const [name, [jointName, xOffset, zOffset]] of Object.entries(POLES)) {
            const joint = getBone(jointName);

            const parent = name.endsWith("Elbow")
                ? this.hipTarget
                : this.root;

            let pole = this.session.getBone(name);

            if (!pole) {
                pole = new THREE.Bone();
                pole.name = name;

                this.root.add(pole);

                this.session.bones.set(
                    name.toLowerCase(),
                    pole
                );
            }

            this.avatar.updateWorldMatrix(true, true);

            const local = this.root.worldToLocal(
                joint.getWorldPosition(new THREE.Vector3())
            );

            local.x += xOffset;
            local.z += zOffset;

            const world = this.root.localToWorld(local);

            parent.attach(pole);

            pole.position.copy(
                parent.worldToLocal(world)
            );

            pole.quaternion.identity();
            pole.scale.set(1, 1, 1);

            pole.updateWorldMatrix(true, true);

            this.poleTargets[name] = pole;
            this.targets.set(name, pole);
        }

        // Hand targets remain independent from animated bones.
        for (const side of SIDES) {
            const hand = getBone(`${side}Hand`);

            const target = new THREE.Object3D();

            target.name = `${side}HandTarget`;

            this.root.add(target);

            const position = hand.getWorldPosition(
                new THREE.Vector3()
            );

            const rotation = hand.getWorldQuaternion(
                new THREE.Quaternion()
            );

            const rootRotation = this.root.getWorldQuaternion(
                new THREE.Quaternion()
            );

            target.position.copy(
                this.root.worldToLocal(position)
            );

            target.quaternion
                .copy(rootRotation.invert())
                .multiply(rotation);

            this.handTargets[side] = target;
            this.targets.set(`${side}Hand`, target);
        }

        for (const side of SIDES) {
            this.chains[`${side}Arm`] = new TwoBoneIK(
                CHAINS[`${side}Arm`].map(getBone),
                this.poleTargets[`${side}Elbow`]
            );

            this.chains[`${side}Leg`] = new TwoBoneIK(
                CHAINS[`${side}Leg`].map(getBone),
                this.poleTargets[`${side}Knee`]
            );
        }

        for (const key of this.targets.keys()) {
            this.createMarker(key);
        }
    }

    createMarker(key) {
        const target = this.targets.get(key);

        const styles = getComputedStyle(
            document.documentElement
        );

        const property = key === "hips"
            ? "--ik-hips"
            : key.endsWith("Hand")
                ? "--ik-hand"
                : key.endsWith("Elbow")
                    ? "--ik-elbow"
                    : "--ik-knee";

        const color = styles.getPropertyValue(property).trim();

        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            depthTest: false,
            depthWrite: false
        });

        const mesh = new THREE.Mesh(
            this.markerGeometry,
            material
        );

        mesh.name = `${key}IKMarker`;
        mesh.userData.ikKey = key;
        mesh.userData.editorOnly = true;
        mesh.renderOrder = 100;

        target.add(mesh);
        target.updateWorldMatrix(true, true);

        const scale = target.getWorldScale(
            new THREE.Vector3()
        );

        const maximum = Math.max(
            Math.abs(scale.x),
            Math.abs(scale.y),
            Math.abs(scale.z),
            EPSILON
        );

        mesh.scale.setScalar(0.022 / maximum);
        mesh.visible = this.visible;

        this.markers.push({ key, mesh });
    }

    normalizeState(value) {
        if (!value || typeof value !== "object") {
            return structuredClone(this.baseState);
        }

        if (value.version === 3) {
            return structuredClone(value);
        }

        // Convert version 2 coordinates into version 3.
        // The reference scale is constant for all imported avatars.
        const factor = this.session.legacyReferenceScale;

        const output = structuredClone(this.baseState);
        const hipsHeight = Number(value.hipsHeight) || 0;

        output.version = 3;
        output.hipsHeight = hipsHeight;

        if (
            Array.isArray(value.hipPosition) &&
            value.hipPosition.length === 3
        ) {
            output.hipPosition = scaledVector(
                value.hipPosition,
                factor
            );

            // In v2, hipPosition already included the crouch offset.
            output.hipPosition[1] -= hipsHeight;
        }

        for (const side of SIDES) {
            const hand = value.hands?.[side];

            if (!hand) {
                continue;
            }

            if (hand.position?.length === 3) {
                output.hands[side].position = scaledVector(
                    hand.position,
                    factor
                );
            }

            if (hand.quaternion?.length === 4) {
                output.hands[side].quaternion = [
                    ...hand.quaternion
                ];
            }
        }

        for (const key of Object.keys(POLES)) {
            if (value.poles?.[key]?.length === 3) {
                output.poles[key] = scaledVector(
                    value.poles[key],
                    factor
                );
            }
        }

        return output;
    }

    mirrorTarget(key) {
        const isLeft = key.startsWith("left");

        const opposite = key.replace(
            isLeft ? /^left/ : /^right/,
            isLeft ? "right" : "left"
        );

        const source = this.targets.get(key);
        const target = this.targets.get(opposite);

        if (!source || !target) {
            return;
        }

        this.avatar.updateWorldMatrix(true, true);

        const mirrored = this.root.worldToLocal(
            source.getWorldPosition(new THREE.Vector3())
        );

        mirrored.x = -mirrored.x;

        this.root.localToWorld(mirrored);

        target.parent.updateWorldMatrix(true, false);

        target.position.copy(
            target.parent.worldToLocal(mirrored)
        );

        if (key.endsWith("Hand")) {
            const q = source.quaternion;

            target.quaternion.set(
                q.x,
                -q.y,
                -q.z,
                q.w
            ).normalize();
        }

        target.updateWorldMatrix(true, true);
    }

    onObjectChange(key) {
        if (!this.ready || !this.active) {
            return;
        }

        if (key === "hips") {
            // HipsTarget may move vertically only.
            this.hipTarget.position.x = this.hipBasePosition.x;
            this.hipTarget.position.z = this.hipBasePosition.z;

            this.hipsDelta = THREE.MathUtils.clamp(
                this.hipTarget.position.y - this.hipBasePosition.y,
                -0.5,
                0.5
            );

            this.hipTarget.position.y =
                this.hipBasePosition.y + this.hipsDelta;
        } else {
            this.mirrorTarget(key);
        }
    }

    serialize() {
        const state = {
            version: 3,
            hipsHeight: this.hipsDelta,
            hipPosition: this.hipBasePosition.toArray(),
            hands: {},
            poles: {}
        };

        for (const side of SIDES) {
            const hand = this.handTargets[side];

            state.hands[side] = {
                position: hand.position.toArray(),
                quaternion: hand.quaternion.toArray()
            };
        }

        for (const key of Object.keys(POLES)) {
            state.poles[key] = this.poleTargets[key]
                .position
                .toArray();
        }

        return state;
    }

    applyState(state) {
        if (state.hipPosition?.length === 3) {
            this.hipBasePosition.fromArray(
                state.hipPosition
            );
        }

        this.hipsDelta = THREE.MathUtils.clamp(
            Number(state.hipsHeight) || 0,
            -0.5,
            0.5
        );

        this.hipTarget.position.copy(
            this.hipBasePosition
        );

        this.hipTarget.position.y += this.hipsDelta;

        for (const side of SIDES) {
            const value = state.hands?.[side];
            const target = this.handTargets[side];

            if (value?.position?.length === 3) {
                target.position.fromArray(
                    value.position
                );
            }

            if (value?.quaternion?.length === 4) {
                target.quaternion
                    .fromArray(value.quaternion)
                    .normalize();
            }
        }

        for (const key of Object.keys(POLES)) {
            if (state.poles?.[key]?.length === 3) {
                this.poleTargets[key].position.fromArray(
                    state.poles[key]
                );
            }
        }

        this.avatar.updateWorldMatrix(true, true);
    }

    beforeAnimation() {
        if (!this.active || !this.ready) {
            return;
        }

        // Restore any changes made by the previous IK evaluation.
        for (const chain of Object.values(this.chains)) {
            chain.restorePose();
        }

        // Restore the original animated Hips position.
        if (this.appliedHipDelta) {
            this.hips.position.y -= this.appliedHipDelta;
            this.appliedHipDelta = 0;
        }
    }

    afterAnimation() {
        if (!this.active || !this.ready) {
            return;
        }

        // Apply crouch to animated Hips in root-local units.
        // HipsTarget is not moved by the animation.
        this.hips.position.y += this.hipsDelta;
        this.appliedHipDelta = this.hipsDelta;

        const origin = this.root.localToWorld(
            new THREE.Vector3()
        );

        const displaced = this.root.localToWorld(
            new THREE.Vector3(0, this.hipsDelta, 0)
        );

        this.worldDelta.subVectors(
            displaced,
            origin
        );

        this.avatar.updateWorldMatrix(true, true);

        // Capture the evaluated pose before solving.
        for (const chain of Object.values(this.chains)) {
            chain.captureAnimatedPose(this.worldDelta);
        }

        // Keep feet at their animated positions while moving Hips.
        for (const side of SIDES) {
            this.chains[`${side}Leg`].solve();
        }

        // Override arm animation with hand target transforms.
        for (const side of SIDES) {
            const target = this.handTargets[side];

            this.chains[`${side}Arm`].solveToTarget(
                target.getWorldPosition(new THREE.Vector3()),
                target.getWorldQuaternion(new THREE.Quaternion()),
                { stretch: true }
            );
        }

        this.avatar.updateWorldMatrix(true, true);
    }

    logDefaults() {
        if (!this.ready) {
            return;
        }

        const state = this.serialize();

        return; // Remove this to log default position each updates.

        console.log(
            "const DEFAULT_IK = " +
            JSON.stringify(state, null, 4) +
            ";"
        );
    }

    async persist() {
        if (!this.ready) {
            return;
        }

        await this.session.setMetadata({
            ...this.session.metadata,
            ik: this.serialize()
        });
    }

    async reset() {
        if (!this.ready) {
            return;
        }

        this.applyState(this.defaultState);

        await this.persist();

        this.logDefaults();
    }

    activate() {
        if (!this.ready || this.active) {
            return;
        }

        this.active = true;

        this.session.setPosePipeline(
            () => this.beforeAnimation(),
            () => this.afterAnimation()
        );
    }

    deactivate() {
        this.session.setPosePipeline(null, null);

        if (!this.active) {
            return;
        }

        this.active = false;

        // Restore the original animated skeleton before returning
        // to Loader or another view without IK.
        for (const chain of Object.values(this.chains)) {
            chain.restorePose();
        }

        if (this.hips && this.appliedHipDelta) {
            this.hips.position.y -= this.appliedHipDelta;
        }

        this.appliedHipDelta = 0;

        this.avatar?.updateWorldMatrix(true, true);

        if (this.session.avatar === this.avatar) {
            this.session.mixer?.update(0);
        }
    }

    setVisible(visible) {
        this.visible = Boolean(visible);

        for (const { mesh } of this.markers) {
            mesh.visible = this.visible;
        }

        if (this.visible) {
            this.activate();
        } else {
            this.deactivate();
        }
    }

    clear() {
        this.deactivate();

        for (const { mesh } of this.markers) {
            mesh.parent?.remove(mesh);
            mesh.material.dispose();
        }

        // Return auxiliary elbow bones to root before removing
        // the independent HipsTarget transform.
        if (this.root && this.hipTarget) {
            for (const name of ["leftElbow", "rightElbow"]) {
                const pole = this.poleTargets[name];

                if (pole?.parent === this.hipTarget) {
                    this.root.attach(pole);
                }
            }
        }

        for (const target of Object.values(this.handTargets)) {
            target.parent?.remove(target);
        }

        this.hipTarget?.parent?.remove(this.hipTarget);

        this.markers = [];
        this.targets.clear();

        this.handTargets = {};
        this.poleTargets = {};
        this.chains = {};

        this.hipTarget = null;
        this.hips = null;
        this.root = null;

        this.hipsDelta = 0;
        this.appliedHipDelta = 0;

        this.baseState = null;
        this.defaultState = null;

        this.ready = false;
        this.active = false;
        this.visible = false;
    }
}