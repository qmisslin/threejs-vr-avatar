import * as THREE from 'three';

export class Player extends THREE.Group {
    constructor({
        avatar,
        height = 1.8,
        radius = 0.3,
        yaw = 0,
        eyeTopOffset = 0.15
    } = {}) {
        super();

        if (!avatar) {
            throw new Error('Player requires an Avatar instance.');
        }

        this.name = 'Player';
        this.avatar = avatar;

        this.capsuleHeight = Math.max(0.3, height);
        this.capsuleRadius = THREE.MathUtils.clamp(
            radius,
            0.05,
            this.capsuleHeight / 2
        );

        this.eyeTopOffset = eyeTopOffset;
        this.eyeY = this.getNeutralEyeY();

        // Eyes/head rotation is independent of the player yaw.
        this.eyeRotation = new THREE.Vector3();
        this.capsuleYaw = 0;
        this.headOverride = true;
        this.displayCapsule = true;

        this.origin = new THREE.Group();
        this.origin.name = 'Origin';
        this.add(this.origin);

        // Simple debug capsule wire representation.
        this.capsuleDebug = new THREE.Group();
        this.capsuleDebug.name = 'CapsuleDebug';
        this.capsuleDebug.renderOrder = 15;
        this.add(this.capsuleDebug);

        this.setCapsuleYaw(yaw);
        this.applyDimensions();
    }

    getNeutralEyeY() {
        return this.capsuleHeight * (
            1 - this.eyeTopOffset / this.avatar.height
        );
    }

    createLine(points, color = 0x67aaff) {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);

        const material = new THREE.LineBasicMaterial({
            color,
            transparent: true,
            opacity: 0.7,
            depthTest: false
        });

        const line = new THREE.Line(geometry, material);
        line.renderOrder = 15;
        line.frustumCulled = false;

        return line;
    }

    createCapsuleOutlinePoints(radius, height, plane = 'xy', segments = 12) {
        const points = [];

        const straight = Math.max(0, height - 2 * radius);
        const topCenterY = straight / 2;
        const bottomCenterY = -straight / 2;

        const makePoint = (horizontal, vertical) => {
            return plane === 'xy'
                ? new THREE.Vector3(horizontal, vertical, 0)
                : new THREE.Vector3(0, vertical, horizontal);
        };

        // Upper semicircle: left to right, bulging upward.
        for (let i = 0; i <= segments; i++) {
            const angle = Math.PI - (i / segments) * Math.PI;

            points.push(makePoint(
                Math.cos(angle) * radius,
                topCenterY + Math.sin(angle) * radius
            ));
        }

        // Right vertical segment.
        points.push(makePoint(radius, bottomCenterY));

        // Lower semicircle: right to left, bulging downward.
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI;

            points.push(makePoint(
                Math.cos(angle) * radius,
                bottomCenterY - Math.sin(angle) * radius
            ));
        }

        // Left vertical segment and close the outline.
        points.push(makePoint(-radius, topCenterY));
        points.push(points[0].clone());

        return points;
    }

    createHorizontalCirclePoints(radius, y = 0, segments = 24) {
        const points = [];

        for (let i = 0; i <= segments; i++) {
            const t = (i / segments) * Math.PI * 2;
            points.push(
                new THREE.Vector3(
                    Math.cos(t) * radius,
                    y,
                    Math.sin(t) * radius
                )
            );
        }

        return points;
    }

    rebuildCapsuleDebug() {
        // Dispose previous wireframe objects safely.
        while (this.capsuleDebug.children.length > 0) {
            const child = this.capsuleDebug.children[0];

            this.capsuleDebug.remove(child);

            child.geometry.dispose();
            child.material.dispose();
        }

        const radius = this.capsuleRadius;
        const height = this.capsuleHeight;
        const color = 0x67aaff;

        // Vertical capsule outline in XY plane.
        const xyOutline = this.createLine(
            this.createCapsuleOutlinePoints(radius, height, 'xy', 12),
            color
        );

        // Vertical capsule outline in YZ plane.
        const yzOutline = this.createLine(
            this.createCapsuleOutlinePoints(radius, height, 'yz', 12),
            color
        );

        // Horizontal circle at the capsule midpoint.
        const xzCircle = this.createLine(
            this.createHorizontalCirclePoints(radius, 0, 24),
            color
        );

        this.capsuleDebug.add(
            xyOutline,
            yzOutline,
            xzCircle
        );

        // Capsule geometry is centered locally.
        // Move it upward so its bottom touches the ground.
        this.capsuleDebug.position.set(
            0,
            height / 2,
            0
        );

        this.capsuleDebug.visible = this.displayCapsule;
    }

    applyDimensions() {
        this.rebuildCapsuleDebug();

        // Player scale remains (1, 1, 1).
        this.origin.scale.setScalar(
            this.capsuleHeight / this.avatar.height
        );

        this.origin.updateWorldMatrix(true, true);

        this.avatar.syncEyesHeight(
            this.eyeY,
            this.getNeutralEyeY()
        );
    }

    setCapsuleHeight(value) {
        const crouchOffset =
            this.eyeY - this.getNeutralEyeY();

        this.capsuleHeight = Math.max(0.3, value);

        this.capsuleRadius = Math.min(
            this.capsuleRadius,
            this.capsuleHeight / 2
        );

        // Preserve the manual crouch offset when resizing.
        this.eyeY = this.getNeutralEyeY() + crouchOffset;

        this.applyDimensions();

        return this.capsuleHeight;
    }

    setCapsuleRadius(value) {
        this.capsuleRadius = THREE.MathUtils.clamp(
            value,
            0.05,
            this.capsuleHeight / 2
        );

        this.applyDimensions();

        return this.capsuleRadius;
    }

    setCapsuleYaw(value) {
        this.capsuleYaw = value;
        this.rotation.y = THREE.MathUtils.degToRad(value);
        return this.capsuleYaw;
    }

    setDisplayCapsule(visible) {
        this.displayCapsule = Boolean(visible);
        this.capsuleDebug.visible = this.displayCapsule;
    }

    setEyesPosition(components) {
        if (components.x !== undefined) {
            this.position.x = components.x;
        }

        if (components.z !== undefined) {
            this.position.z = components.z;
        }

        if (components.y !== undefined) {
            const nominal = this.getNeutralEyeY();

            this.eyeY = THREE.MathUtils.clamp(
                components.y,
                nominal - this.avatar.maxCrouch,
                nominal - this.avatar.minCrouch
            );

            this.avatar.syncEyesHeight(
                this.eyeY,
                nominal
            );
        }

        return {
            x: this.position.x,
            y: this.eyeY,
            z: this.position.z
        };
    }

    setEyesRotation(components) {
        for (const axis of ['x', 'y', 'z']) {
            if (components[axis] !== undefined) {
                this.eyeRotation[axis] = components[axis];
            }
        }

        // X, Y and Z are exclusively head rotation controls.
        // Player yaw is controlled by setCapsuleYaw().
        this.avatar.setHeadRotation(
            this.eyeRotation.x,
            this.eyeRotation.y,
            this.eyeRotation.z
        );

        return {
            x: this.eyeRotation.x,
            y: this.eyeRotation.y,
            z: this.eyeRotation.z
        };
    }

    setHeadOverride(enabled) {
        this.headOverride = Boolean(enabled);
        this.avatar.setHeadOverride(this.headOverride);
    }

    getControlState() {
        const state = this.avatar.getControlState();
        state.view.displayCapsule = this.displayCapsule;

        state.capsule = {
            height: this.capsuleHeight,
            radius: this.capsuleRadius,
            yaw: this.capsuleYaw
        };

        state.eyes = {
            position: {
                x: this.position.x,
                y: this.eyeY,
                z: this.position.z
            },
            rotation: {
                x: this.eyeRotation.x,
                y: this.eyeRotation.y,
                z: this.eyeRotation.z
            },
            yLimits: {
                min: this.getNeutralEyeY() - this.avatar.maxCrouch,
                max: this.getNeutralEyeY() - this.avatar.minCrouch
            },
            headOverride: this.headOverride
        };

        return state;
    }
}