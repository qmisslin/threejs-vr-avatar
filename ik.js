
import * as THREE from 'three';

const EPSILON = 1e-6;

export class IK {
    constructor({ bones, poleBone = null }) {
        if (!Array.isArray(bones) || bones.length !== 3) {
            throw new Error('Simple IK requires exactly three joints.');
        }

        for (let i = 1; i < bones.length; i++) {
            let parent = bones[i].parent;
            let found = false;

            while (parent) {
                if (parent === bones[i - 1]) {
                    found = true;
                    break;
                }

                parent = parent.parent;
            }

            if (!found) {
                throw new Error('IK joints must form an ordered hierarchy.');
            }
        }

        this.bones = bones;

        this.root = bones[0];
        this.middle = bones[1];
        this.end = bones[2];

        this.poleBone = poleBone;
        this.poleTarget = null;

        this.savedPositions = bones.map(() => new THREE.Vector3());
        this.savedRotations = bones.map(() => new THREE.Quaternion());
        this.savedScales = bones.map(() => new THREE.Vector3());

        this.hasSavedPose = false;

        this.animatedRoot = new THREE.Vector3();
        this.animatedMiddle = new THREE.Vector3();

        this.target = new THREE.Vector3();
        this.endWorldQuaternion = new THREE.Quaternion();

        this.toeDirection = new THREE.Vector3();
        this.cachedPole = new THREE.Vector3(0, 0, 1);

        this.rootWorld = new THREE.Vector3();
        this.middleWorld = new THREE.Vector3();
        this.endWorld = new THREE.Vector3();

        this.axis = new THREE.Vector3();
        this.pole = new THREE.Vector3();
        this.baseAxis = new THREE.Vector3();

        this.desiredMiddle = new THREE.Vector3();
        this.desiredEnd = new THREE.Vector3();

        this.worldPole = new THREE.Vector3();

        this.fromDirection = new THREE.Vector3();
        this.toDirection = new THREE.Vector3();

        this.qWorld = new THREE.Quaternion();
        this.qParent = new THREE.Quaternion();
        this.qDelta = new THREE.Quaternion();

        this.inverseMatrix = new THREE.Matrix3();
        this.residual = new THREE.Vector3();
        this.zero = new THREE.Vector3();

        this.originalPositions = bones.map(() => new THREE.Vector3());
        this.desiredJointWorld = new THREE.Vector3();
    }

    // --------------------------------------------------
    // Pole target
    // --------------------------------------------------

    setPoleTarget(target) {
        this.poleTarget = target;
        return this;
    }

    // --------------------------------------------------
    // Animation pose management
    // --------------------------------------------------

    restorePose() {
        if (!this.hasSavedPose) return;

        for (let i = 0; i < this.bones.length; i++) {
            this.bones[i].position.copy(this.savedPositions[i]);
            this.bones[i].quaternion.copy(this.savedRotations[i]);
            this.bones[i].scale.copy(this.savedScales[i]);
        }
    }

    captureAnimatedPose(worldDelta = this.zero) {
        this.root.getWorldPosition(this.animatedRoot);
        this.middle.getWorldPosition(this.animatedMiddle);
        this.end.getWorldPosition(this.target);

        this.animatedRoot.sub(worldDelta);
        this.animatedMiddle.sub(worldDelta);
        this.target.sub(worldDelta);

        this.end.getWorldQuaternion(this.endWorldQuaternion);

        if (this.poleBone) {
            this.poleBone.getWorldPosition(this.toeDirection);
            this.end.getWorldPosition(this.endWorld);
            this.toeDirection.sub(this.endWorld);
        } else {
            this.toeDirection.copy(this.cachedPole);
        }

        for (let i = 0; i < this.bones.length; i++) {
            this.savedPositions[i].copy(this.bones[i].position);
            this.savedRotations[i].copy(this.bones[i].quaternion);
            this.savedScales[i].copy(this.bones[i].scale);
        }

        this.hasSavedPose = true;
    }

    // --------------------------------------------------
    // Solve
    // --------------------------------------------------

    solve() {
        this.solveTwoBone();
        this.restoreEndOrientation();
    }

    solveToTarget(position, quaternion, { stretch = false } = {}) {
        if (!this.hasSavedPose) {
            throw new Error(
                'Call captureAnimatedPose() before solveToTarget().'
            );
        }

        this.target.copy(position);
        this.endWorldQuaternion.copy(quaternion);

        if (stretch) {
            this.stretchToReach();
        }

        this.solveTwoBone();
        this.restoreEndOrientation();
        this.pinEndPosition();
    }

    // --------------------------------------------------
    // Longitudinal stretching
    // --------------------------------------------------

    stretchToReach() {
        for (let i = 0; i < 3; i++) {
            this.bones[i].getWorldPosition(this.originalPositions[i]);
        }

        const upperLength = this.originalPositions[0].distanceTo(
            this.originalPositions[1]
        );

        const lowerLength = this.originalPositions[1].distanceTo(
            this.originalPositions[2]
        );

        const totalLength = upperLength + lowerLength;

        if (totalLength < EPSILON) return;

        const distance = this.originalPositions[0].distanceTo(this.target);
        const minimumReach = Math.abs(upperLength - lowerLength);
        const margin = Math.max(totalLength * 0.001, EPSILON * 10);

        let factor = 1;

        if (distance >= totalLength - margin) {
            factor = (distance + margin) / totalLength;
        } else if (
            minimumReach > EPSILON &&
            distance < minimumReach + margin
        ) {
            factor = Math.max(
                1e-4,
                (distance - margin) / minimumReach
            );
        }

        if (Math.abs(factor - 1) < EPSILON) return;

        // Modify joint translations without changing bone scales.

        for (let i = 1; i < 3; i++) {
            const bone = this.bones[i];

            this.desiredJointWorld
                .subVectors(
                    this.originalPositions[i],
                    this.originalPositions[0]
                )
                .multiplyScalar(factor)
                .add(this.originalPositions[0]);

            bone.parent.updateWorldMatrix(true, false);

            bone.position.copy(
                bone.parent.worldToLocal(this.desiredJointWorld)
            );

            bone.updateWorldMatrix(true, true);
        }
    }

    // --------------------------------------------------
    // Pole computation
    // --------------------------------------------------

    computePole() {
        if (this.poleTarget) {
            // Absolute world-space pole.

            this.poleTarget.getWorldPosition(this.worldPole);

            this.pole.subVectors(
                this.worldPole,
                this.rootWorld
            );

            this.pole.addScaledVector(
                this.axis,
                -this.pole.dot(this.axis)
            );

            if (this.pole.lengthSq() < EPSILON) {
                this.pole.copy(this.cachedPole);

                this.pole.addScaledVector(
                    this.axis,
                    -this.pole.dot(this.axis)
                );
            }
        } else {
            // Original animation-derived pole.

            this.baseAxis.subVectors(
                this.target,
                this.animatedRoot
            );

            const baseLengthSq = this.baseAxis.lengthSq();

            this.pole.subVectors(
                this.animatedMiddle,
                this.animatedRoot
            );

            if (baseLengthSq > EPSILON) {
                this.pole.addScaledVector(
                    this.baseAxis,
                    -this.pole.dot(this.baseAxis) / baseLengthSq
                );
            }

            this.pole.addScaledVector(
                this.axis,
                -this.pole.dot(this.axis)
            );

            if (this.pole.lengthSq() < 0.000025) {
                this.pole.copy(this.toeDirection);

                this.pole.addScaledVector(
                    this.axis,
                    -this.pole.dot(this.axis)
                );
            }

            if (this.pole.lengthSq() < EPSILON) {
                this.pole.copy(this.cachedPole);

                this.pole.addScaledVector(
                    this.axis,
                    -this.pole.dot(this.axis)
                );
            }
        }

        if (this.pole.lengthSq() < EPSILON) {
            this.pole.set(0, 0, 1);

            this.pole.addScaledVector(
                this.axis,
                -this.pole.dot(this.axis)
            );
        }

        if (this.pole.lengthSq() < EPSILON) {
            this.pole.set(1, 0, 0);

            this.pole.addScaledVector(
                this.axis,
                -this.pole.dot(this.axis)
            );
        }

        this.pole.normalize();
        this.cachedPole.copy(this.pole);
    }

    // --------------------------------------------------
    // Analytical two-bone solver
    // --------------------------------------------------

    solveTwoBone() {
        this.root.getWorldPosition(this.rootWorld);
        this.middle.getWorldPosition(this.middleWorld);
        this.end.getWorldPosition(this.endWorld);

        const upperLength = this.rootWorld.distanceTo(
            this.middleWorld
        );

        const lowerLength = this.middleWorld.distanceTo(
            this.endWorld
        );

        if (
            upperLength < EPSILON ||
            lowerLength < EPSILON
        ) {
            return;
        }

        this.axis.subVectors(
            this.target,
            this.rootWorld
        );

        const actualDistance = this.axis.length();

        if (actualDistance < EPSILON) {
            this.axis.set(0, -1, 0);
        } else {
            this.axis.divideScalar(actualDistance);
        }

        const minimumReach = Math.abs(
            upperLength - lowerLength
        );

        const maximumReach = upperLength + lowerLength;

        const distance = THREE.MathUtils.clamp(
            actualDistance,
            minimumReach + EPSILON,
            Math.max(
                minimumReach + EPSILON,
                maximumReach - EPSILON
            )
        );

        this.desiredEnd
            .copy(this.rootWorld)
            .addScaledVector(this.axis, distance);

        this.computePole();

        // Law of cosines.

        const x = (
            upperLength * upperLength -
            lowerLength * lowerLength +
            distance * distance
        ) / (2 * distance);

        const h = Math.sqrt(
            Math.max(
                0,
                upperLength * upperLength - x * x
            )
        );

        this.desiredMiddle
            .copy(this.rootWorld)
            .addScaledVector(this.axis, x)
            .addScaledVector(this.pole, h);

        // Rotate the first segment.

        this.rotateBoneToTarget(
            this.root,
            this.rootWorld,
            this.middleWorld,
            this.desiredMiddle
        );

        // Rotate the second segment.

        this.middle.getWorldPosition(this.middleWorld);
        this.end.getWorldPosition(this.endWorld);

        this.rotateBoneToTarget(
            this.middle,
            this.middleWorld,
            this.endWorld,
            this.desiredEnd
        );
    }

    // --------------------------------------------------
    // Bone rotation
    // --------------------------------------------------

    rotateBoneToTarget(
        bone,
        origin,
        currentEndpoint,
        desiredEndpoint
    ) {
        this.fromDirection.subVectors(
            currentEndpoint,
            origin
        );

        this.toDirection.subVectors(
            desiredEndpoint,
            origin
        );

        if (
            this.fromDirection.lengthSq() < EPSILON ||
            this.toDirection.lengthSq() < EPSILON
        ) {
            return;
        }

        this.fromDirection.normalize();
        this.toDirection.normalize();

        this.qDelta.setFromUnitVectors(
            this.fromDirection,
            this.toDirection
        );

        bone.getWorldQuaternion(this.qWorld);
        bone.parent.getWorldQuaternion(this.qParent);

        bone.quaternion
            .copy(this.qParent.invert())
            .multiply(this.qDelta)
            .multiply(this.qWorld)
            .normalize();

        bone.updateWorldMatrix(true, true);
    }

    // --------------------------------------------------
    // End-effector orientation
    // --------------------------------------------------

    restoreEndOrientation() {
        this.end.parent.getWorldQuaternion(this.qParent);

        this.end.quaternion
            .copy(this.qParent.invert())
            .multiply(this.endWorldQuaternion)
            .normalize();

        this.end.updateWorldMatrix(true, true);
    }

    // --------------------------------------------------
    // Exact end-effector positioning
    // --------------------------------------------------

    pinEndPosition() {
        this.end.getWorldPosition(this.endWorld);

        this.residual.subVectors(
            this.target,
            this.endWorld
        );

        if (this.residual.lengthSq() < 1e-18) return;

        this.end.parent.updateWorldMatrix(true, false);

        this.inverseMatrix
            .setFromMatrix4(this.end.parent.matrixWorld)
            .invert();

        this.end.position.add(
            this.residual.applyMatrix3(this.inverseMatrix)
        );

        this.end.updateWorldMatrix(true, true);
    }
}
