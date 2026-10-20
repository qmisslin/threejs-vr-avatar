
import * as THREE from 'three';

const EPSILON = 1e-6;

export class IK {
    constructor({ bones, poleBone = null }) {
        if (
            !Array.isArray(bones) ||
            bones.length !== 3
        ) {
            throw new Error(
                'Simple IK requires exactly three joints.'
            );
        }

        for (let i = 1; i < bones.length; i++) {
            let found = false;

            for (
                let parent = bones[i].parent;
                parent;
                parent = parent.parent
            ) {
                if (parent === bones[i - 1]) {
                    found = true;
                    break;
                }
            }

            if (!found) {
                throw new Error(
                    'IK joints must form an ordered hierarchy.'
                );
            }
        }

        [
            this.root,
            this.middle,
            this.end
        ] = bones;

        this.bones = bones;
        this.poleBone = poleBone;
        this.poleTarget = null;

        this.savedPositions = bones.map(
            () => new THREE.Vector3()
        );

        this.savedRotations = bones.map(
            () => new THREE.Quaternion()
        );

        this.savedScales = bones.map(
            () => new THREE.Vector3()
        );

        this.hasSavedPose = false;

        this.animatedRoot = new THREE.Vector3();
        this.animatedMiddle = new THREE.Vector3();

        this.target = new THREE.Vector3();
        this.endWorldQuaternion =
            new THREE.Quaternion();

        this.toeDirection = new THREE.Vector3();
        this.cachedPole = new THREE.Vector3(
            0,
            0,
            1
        );

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

        this.originalPositions = bones.map(
            () => new THREE.Vector3()
        );

        this.desiredJointWorld =
            new THREE.Vector3();
    }

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
            this.bones[i].position.copy(
                this.savedPositions[i]
            );

            this.bones[i].quaternion.copy(
                this.savedRotations[i]
            );

            this.bones[i].scale.copy(
                this.savedScales[i]
            );
        }
    }

    captureAnimatedPose(
        worldDelta = this.zero
    ) {
        this.root.getWorldPosition(
            this.animatedRoot
        );

        this.middle.getWorldPosition(
            this.animatedMiddle
        );

        this.end.getWorldPosition(
            this.target
        );

        this.animatedRoot.sub(worldDelta);
        this.animatedMiddle.sub(worldDelta);
        this.target.sub(worldDelta);

        this.end.getWorldQuaternion(
            this.endWorldQuaternion
        );

        if (this.poleBone) {
            this.poleBone.getWorldPosition(
                this.toeDirection
            );

            this.end.getWorldPosition(
                this.endWorld
            );

            this.toeDirection.sub(
                this.endWorld
            );
        } else {
            this.toeDirection.copy(
                this.cachedPole
            );
        }

        for (let i = 0; i < this.bones.length; i++) {
            this.savedPositions[i].copy(
                this.bones[i].position
            );

            this.savedRotations[i].copy(
                this.bones[i].quaternion
            );

            this.savedScales[i].copy(
                this.bones[i].scale
            );
        }

        this.hasSavedPose = true;
    }

    // --------------------------------------------------
    // Solver
    // --------------------------------------------------

    solve() {
        this.solveTwoBone();
        this.restoreEndOrientation();
    }

    solveToTarget(
        position,
        quaternion,
        { stretch = false } = {}
    ) {
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
            this.bones[i].getWorldPosition(
                this.originalPositions[i]
            );
        }

        const upper = this.originalPositions[0]
            .distanceTo(this.originalPositions[1]);

        const lower = this.originalPositions[1]
            .distanceTo(this.originalPositions[2]);

        const total = upper + lower;

        if (total < EPSILON) return;

        const distance = this.originalPositions[0]
            .distanceTo(this.target);

        const minimum = Math.abs(upper - lower);

        const margin = Math.max(
            total * 0.001,
            EPSILON * 10
        );

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

        // Modify joint translations, never bone scales.
        for (let i = 1; i < 3; i++) {
            const bone = this.bones[i];

            this.desiredJointWorld
                .subVectors(
                    this.originalPositions[i],
                    this.originalPositions[0]
                )
                .multiplyScalar(factor)
                .add(this.originalPositions[0]);

            bone.parent.updateWorldMatrix(
                true,
                false
            );

            bone.position.copy(
                bone.parent.worldToLocal(
                    this.desiredJointWorld
                )
            );

            bone.updateWorldMatrix(
                true,
                true
            );
        }
    }

    // --------------------------------------------------
    // Pole direction
    // --------------------------------------------------

    computePole() {
        if (this.poleTarget) {
            // Absolute pole position in world coordinates.
            this.poleTarget.getWorldPosition(
                this.worldPole
            );

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
            // Fallback based on the animated pose.
            this.baseAxis.subVectors(
                this.target,
                this.animatedRoot
            );

            const lengthSq =
                this.baseAxis.lengthSq();

            this.pole.subVectors(
                this.animatedMiddle,
                this.animatedRoot
            );

            if (lengthSq > EPSILON) {
                this.pole.addScaledVector(
                    this.baseAxis,
                    -this.pole.dot(this.baseAxis) /
                    lengthSq
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
        this.root.getWorldPosition(
            this.rootWorld
        );

        this.middle.getWorldPosition(
            this.middleWorld
        );

        this.end.getWorldPosition(
            this.endWorld
        );

        const upper = this.rootWorld
            .distanceTo(this.middleWorld);

        const lower = this.middleWorld
            .distanceTo(this.endWorld);

        if (
            upper < EPSILON ||
            lower < EPSILON
        ) {
            return;
        }

        this.axis.subVectors(
            this.target,
            this.rootWorld
        );

        const actualDistance =
            this.axis.length();

        if (actualDistance < EPSILON) {
            this.axis.set(0, -1, 0);
        } else {
            this.axis.divideScalar(
                actualDistance
            );
        }

        const minReach =
            Math.abs(upper - lower);

        const maxReach =
            upper + lower;

        const distance = THREE.MathUtils.clamp(
            actualDistance,
            minReach + EPSILON,
            Math.max(
                minReach + EPSILON,
                maxReach - EPSILON
            )
        );

        this.desiredEnd
            .copy(this.rootWorld)
            .addScaledVector(
                this.axis,
                distance
            );

        this.computePole();

        // Law of cosines.
        const x = (
            upper * upper -
            lower * lower +
            distance * distance
        ) / (2 * distance);

        const h = Math.sqrt(
            Math.max(
                0,
                upper * upper - x * x
            )
        );

        this.desiredMiddle
            .copy(this.rootWorld)
            .addScaledVector(this.axis, x)
            .addScaledVector(this.pole, h);

        // First segment.
        this.rotateBoneToTarget(
            this.root,
            this.rootWorld,
            this.middleWorld,
            this.desiredMiddle
        );

        this.middle.getWorldPosition(
            this.middleWorld
        );

        this.end.getWorldPosition(
            this.endWorld
        );

        // Second segment.
        this.rotateBoneToTarget(
            this.middle,
            this.middleWorld,
            this.endWorld,
            this.desiredEnd
        );
    }

    // --------------------------------------------------
    // World-space joint rotation
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

        bone.getWorldQuaternion(
            this.qWorld
        );

        bone.parent.getWorldQuaternion(
            this.qParent
        );

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
        this.end.parent.getWorldQuaternion(
            this.qParent
        );

        this.end.quaternion
            .copy(this.qParent.invert())
            .multiply(this.endWorldQuaternion)
            .normalize();

        this.end.updateWorldMatrix(true, true);
    }

    // --------------------------------------------------
    // Absolute end-effector positioning
    // --------------------------------------------------

    pinEndPosition() {
        this.end.getWorldPosition(
            this.endWorld
        );

        this.residual.subVectors(
            this.target,
            this.endWorld
        );

        if (this.residual.lengthSq() < 1e-18) {
            return;
        }

        this.end.parent.updateWorldMatrix(
            true,
            false
        );

        this.inverseMatrix
            .setFromMatrix4(
                this.end.parent.matrixWorld
            )
            .invert();

        this.end.position.add(
            this.residual.applyMatrix3(
                this.inverseMatrix
            )
        );

        this.end.updateWorldMatrix(true, true);
    }
}
