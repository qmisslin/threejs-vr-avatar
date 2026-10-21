
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
            throw new Error(
                'Player requires an Avatar instance.'
            );
        }

        this.name = 'Player';
        this.avatar = avatar;

        this.capsuleHeight = Math.max(0.3, height);

        this.capsuleRadius = THREE.MathUtils.clamp(
            radius,
            0.05,
            this.capsuleHeight / 2
        );

        this.capsuleYaw = 0;
        this.eyeTopOffset = eyeTopOffset;
        this.eyeY = this.getNeutralEyeY();

        this.eyeRotation = new THREE.Vector3();

        this.headOverride = true;
        this.displayCapsule = true;

        this.origin = new THREE.Group();
        this.origin.name = 'Origin';
        this.add(this.origin);

        this.capsuleDebug = new THREE.Group();
        this.capsuleDebug.name = 'CapsuleDebug';
        this.add(this.capsuleDebug);

        this.setCapsuleYaw(yaw);
        this.applyDimensions();
    }

    // --------------------------------------------------
    // Eye height
    // --------------------------------------------------

    getNeutralEyeY() {
        return this.capsuleHeight * (
            1 - this.eyeTopOffset / this.avatar.height
        );
    }

    // --------------------------------------------------
    // Simple capsule wireframe
    // --------------------------------------------------

    createLine(points) {
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({
                color: 0x67aaff,
                transparent: true,
                opacity: 0.7,
                depthTest: false
            })
        );

        line.renderOrder = 15;
        line.frustumCulled = false;

        return line;
    }

    createCapsuleOutlinePoints(
        radius,
        height,
        plane,
        segments = 12
    ) {
        const points = [];

        const straight = Math.max(
            0,
            height - 2 * radius
        );

        const topY = straight / 2;
        const bottomY = -straight / 2;

        const point = (horizontal, y) => {
            return plane === 'xy'
                ? new THREE.Vector3(horizontal, y, 0)
                : new THREE.Vector3(0, y, horizontal);
        };

        // Upper hemisphere.

        for (let i = 0; i <= segments; i++) {
            const angle = Math.PI - i * Math.PI / segments;

            points.push(
                point(
                    radius * Math.cos(angle),
                    topY + radius * Math.sin(angle)
                )
            );
        }

        // Right side.

        points.push(point(radius, bottomY));

        // Lower hemisphere.

        for (let i = 0; i <= segments; i++) {
            const angle = i * Math.PI / segments;

            points.push(
                point(
                    radius * Math.cos(angle),
                    bottomY - radius * Math.sin(angle)
                )
            );
        }

        // Left side.

        points.push(point(-radius, topY));
        points.push(points[0].clone());

        return points;
    }

    createHorizontalCirclePoints(
        radius,
        segments = 24
    ) {
        const points = [];

        for (let i = 0; i <= segments; i++) {
            const angle = i * Math.PI * 2 / segments;

            points.push(
                new THREE.Vector3(
                    radius * Math.cos(angle),
                    0,
                    radius * Math.sin(angle)
                )
            );
        }

        return points;
    }

    rebuildCapsuleDebug() {
        for (const child of [...this.capsuleDebug.children]) {
            this.capsuleDebug.remove(child);

            child.geometry.dispose();
            child.material.dispose();
        }

        const radius = this.capsuleRadius;
        const height = this.capsuleHeight;

        this.capsuleDebug.add(
            this.createLine(
                this.createCapsuleOutlinePoints(
                    radius,
                    height,
                    'xy'
                )
            ),
            this.createLine(
                this.createCapsuleOutlinePoints(
                    radius,
                    height,
                    'yz'
                )
            ),
            this.createLine(
                this.createHorizontalCirclePoints(radius)
            )
        );

        // The wireframe is centered locally.
        // Shift it up so the bottom touches the ground.

        this.capsuleDebug.position.set(
            0,
            height / 2,
            0
        );

        this.capsuleDebug.visible = this.displayCapsule;
    }

    // --------------------------------------------------
    // Dimensions
    // --------------------------------------------------

    applyDimensions() {
        this.rebuildCapsuleDebug();

        // Player scale is always (1, 1, 1).

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

    setCapsuleYaw(degrees) {
        this.capsuleYaw = degrees;

        this.rotation.y = THREE.MathUtils.degToRad(
            degrees
        );

        return this.capsuleYaw;
    }

    setDisplayCapsule(visible) {
        this.displayCapsule = Boolean(visible);

        this.capsuleDebug.visible = this.displayCapsule;
    }

    // --------------------------------------------------
    // Eyes
    // --------------------------------------------------

    setEyesPosition(
        components,
        { clampY = true } = {}
    ) {
        if (components.x !== undefined) {
            this.position.x = components.x;
        }

        if (components.z !== undefined) {
            this.position.z = components.z;
        }

        if (components.y !== undefined) {
            const neutral = this.getNeutralEyeY();

            // Allow VR to use the actual tracked headset height.
            // The avatar crouch itself remains clamped.

            this.eyeY = clampY
                ? THREE.MathUtils.clamp(
                    components.y,
                    neutral - this.avatar.maxCrouch,
                    neutral - this.avatar.minCrouch
                )
                : components.y;

            this.avatar.syncEyesHeight(
                this.eyeY,
                neutral
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

        // All eye rotations control the avatar head.
        // Capsule yaw remains independent.

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

        this.avatar.setHeadOverride(
            this.headOverride
        );
    }

    // --------------------------------------------------
    // Sidebar state
    // --------------------------------------------------

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
