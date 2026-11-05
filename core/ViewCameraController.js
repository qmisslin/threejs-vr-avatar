import * as THREE from "three";

const DEFAULT_CAMERA_OFFSET = {
    x: 0,
    y: -0.1,
    z: 0.1
};

const DEFAULT_ORBIT = [0, 0, -1];
const CAMERA_STATE_VERSION = 1;

function validVector(value) {
    return Array.isArray(value) &&
        value.length === 3 &&
        value.every(Number.isFinite);
}

function createLookQuaternion(orbitPosition) {
    const camera = new THREE.PerspectiveCamera();

    camera.position.fromArray(orbitPosition);
    camera.lookAt(0, 0, 0);

    return camera.quaternion.clone();
}

export default class ViewCameraController extends EventTarget {
    constructor(session) {
        super();

        this.session = session;

        this.avatar = null;
        this.root = null;
        this.head = null;
        this.anchor = null;
        this.marker = null;

        this.ownsAnchor = false;
        this.visible = false;
        this.active = false;
        this.ready = false;
        this.error = null;

        this.defaultState = null;

        this.orbitPosition = new THREE.Vector3()
            .fromArray(DEFAULT_ORBIT);

        this.defaultLookQuaternion = createLookQuaternion(
            DEFAULT_ORBIT
        );

        this.viewQuaternion = this.defaultLookQuaternion.clone();

        this.headAnimatedQuaternion = new THREE.Quaternion();
        this.headWasOverridden = false;

        this.rootWorldQuaternion = new THREE.Quaternion();
        this.parentWorldQuaternion = new THREE.Quaternion();
        this.headWorldQuaternion = new THREE.Quaternion();

        this.rotationDelta = new THREE.Quaternion();
        this.worldRotationDelta = new THREE.Quaternion();

        this.markerGeometry = new THREE.SphereGeometry(
            0.025,
            16,
            12
        );

        this.onSessionChange = () => {
            if (this.avatar !== this.session.avatar) {
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
            this.root = this.session.getBone("root");
            this.head = this.session.getBone("Head");

            if (!this.root?.isBone) {
                throw new Error(
                    "The avatar must contain a root bone."
                );
            }

            if (!this.head?.isBone) {
                throw new Error(
                    "The avatar must contain a Head bone."
                );
            }

            this.avatar.updateWorldMatrix(true, true);

            const existing = this.session.getBone("CameraAnchor");

            if (existing?.isBone) {
                this.anchor = existing;
                this.ownsAnchor = false;

                if (this.anchor.parent !== this.root) {
                    this.root.attach(this.anchor);
                }
            } else {
                this.anchor = new THREE.Bone();
                this.anchor.name = "CameraAnchor";

                this.root.add(this.anchor);

                this.session.bones.set(
                    "cameraanchor",
                    this.anchor
                );

                this.ownsAnchor = true;
            }

            this.defaultState = {
                version: CAMERA_STATE_VERSION,
                position: this.computeDefaultPosition().toArray(),
                orbitPosition: [...DEFAULT_ORBIT]
            };

            const saved = this.session.metadata.cameraAnchor;

            this.applyState(
                this.validateState(saved)
                    ? saved
                    : this.defaultState
            );

            this.createMarker();

            this.ready = true;
            this.error = null;

            this.setVisible(wasVisible);

            this.dispatchEvent(new Event("reset"));
        } catch (error) {
            this.clear();

            this.error = error.message;

            console.warn(
                "Camera anchor unavailable:",
                error
            );
        }
    }

    computeDefaultPosition() {
        this.avatar.updateWorldMatrix(true, true);

        const position = this.head.getWorldPosition(
            new THREE.Vector3()
        );

        this.root.worldToLocal(position);

        position.add(
            new THREE.Vector3(
                DEFAULT_CAMERA_OFFSET.x,
                DEFAULT_CAMERA_OFFSET.y,
                DEFAULT_CAMERA_OFFSET.z
            )
        );

        return position;
    }

    validateState(state) {
        return state?.version === CAMERA_STATE_VERSION &&
            validVector(state.position) &&
            validVector(state.orbitPosition) &&
            new THREE.Vector3()
                .fromArray(state.orbitPosition)
                .lengthSq() > 1e-8;
    }

    applyState(state) {
        if (!this.anchor || !this.validateState(state)) {
            return;
        }

        this.anchor.position.fromArray(state.position);

        this.orbitPosition
            .fromArray(state.orbitPosition)
            .normalize();

        this.viewQuaternion.copy(
            createLookQuaternion(this.orbitPosition.toArray())
        );

        this.anchor.updateWorldMatrix(true, true);
    }

    createMarker() {
        const styles = getComputedStyle(
            document.documentElement
        );

        const color = styles.getPropertyValue(
            "--primary"
        ).trim();

        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(color),
            depthTest: false,
            depthWrite: false
        });

        this.marker = new THREE.Mesh(
            this.markerGeometry,
            material
        );

        this.marker.name = "CameraAnchorMarker";
        this.marker.userData.editorOnly = true;

        this.marker.layers.set(1);
        this.marker.renderOrder = 100;

        this.anchor.add(this.marker);

        this.marker.visible = this.visible;
    }

    onAnchorChanged() {
        if (!this.ready) {
            return;
        }

        // Allow only vertical and forward/backward translations.
        this.anchor.position.x = this.defaultState.position[0];

        this.anchor.updateWorldMatrix(true, true);
    }

    setOrbitPosition(position) {
        if (!this.ready || position.lengthSq() < 1e-8) {
            return;
        }

        this.orbitPosition
            .copy(position)
            .normalize();
    }

    setLookQuaternion(quaternion) {
        if (!this.ready) {
            return;
        }

        this.viewQuaternion
            .copy(quaternion)
            .normalize();
    }

    getState() {
        return {
            version: CAMERA_STATE_VERSION,
            position: this.anchor.position.toArray(),
            orbitPosition: this.orbitPosition.toArray()
        };
    }

    async persist() {
        if (!this.ready) {
            return;
        }

        await this.session.setMetadata({
            ...this.session.metadata,
            cameraAnchor: this.getState()
        });
    }

    async reset() {
        if (!this.ready) {
            return;
        }

        this.applyState(this.defaultState);

        this.dispatchEvent(new Event("reset"));

        await this.persist();
    }

    beforeAnimation() {
        if (!this.active || !this.ready) {
            return;
        }

        if (this.headWasOverridden) {
            this.head.quaternion.copy(
                this.headAnimatedQuaternion
            );

            this.headWasOverridden = false;
        }
    }

    afterAnimation() {
        if (!this.active || !this.ready) {
            return;
        }

        // Preserve the evaluated animation pose.
        this.headAnimatedQuaternion.copy(
            this.head.quaternion
        );

        this.root.getWorldQuaternion(
            this.rootWorldQuaternion
        );

        this.head.getWorldQuaternion(
            this.headWorldQuaternion
        );

        this.head.parent.getWorldQuaternion(
            this.parentWorldQuaternion
        );

        // Compute camera rotation relative to its neutral direction.
        this.rotationDelta
            .copy(this.viewQuaternion)
            .multiply(
                this.defaultLookQuaternion.clone().invert()
            )
            .normalize();

        // Convert the relative rotation into world space.
        this.worldRotationDelta
            .copy(this.rootWorldQuaternion)
            .multiply(this.rotationDelta)
            .multiply(
                this.rootWorldQuaternion.clone().invert()
            )
            .normalize();

        // Apply the camera's relative orientation to the animated head.
        this.headWorldQuaternion.premultiply(
            this.worldRotationDelta
        );

        this.head.quaternion
            .copy(this.parentWorldQuaternion.invert())
            .multiply(this.headWorldQuaternion)
            .normalize();

        this.head.updateWorldMatrix(true, true);

        this.headWasOverridden = true;
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
        if (!this.active) {
            return;
        }

        this.active = false;

        this.session.setPosePipeline(null, null);

        if (this.head && this.headWasOverridden) {
            this.head.quaternion.copy(
                this.headAnimatedQuaternion
            );

            this.headWasOverridden = false;
            this.head.updateWorldMatrix(true, true);
        }

        if (this.session.avatar === this.avatar) {
            this.session.mixer?.update(0);
        }
    }

    setVisible(visible) {
        this.visible = Boolean(visible);

        if (this.marker) {
            this.marker.visible = this.visible;
        }

        if (this.visible) {
            this.activate();
        } else {
            this.deactivate();
        }
    }

    clear() {
        this.deactivate();

        if (this.marker) {
            this.marker.parent?.remove(this.marker);
            this.marker.material.dispose();
            this.marker = null;
        }

        if (this.ownsAnchor && this.anchor) {
            this.anchor.parent?.remove(this.anchor);

            if (
                this.session.bones.get("cameraanchor") ===
                this.anchor
            ) {
                this.session.bones.delete("cameraanchor");
            }
        }

        this.avatar = null;
        this.root = null;
        this.head = null;
        this.anchor = null;

        this.ownsAnchor = false;
        this.ready = false;
        this.visible = false;
        this.active = false;

        this.headWasOverridden = false;
        this.defaultState = null;
    }
}