import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import InteractiveViewHelper from "./InteractiveViewHelper.js";

export default class AvatarViewport {
    constructor(session, canvas) {
        this.session = session;
        this.canvas = canvas;
        this.disposed = false;
        this.transformControls = new Map();
        this.lastRenderTime = null;
        this.animationControlsState = null;
        this.orthographicHeight = 2;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: false,
            powerPreference: "high-performance"
        });

        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        this.renderer.autoClear = false;

        this.perspectiveCamera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
        this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
        this.camera = this.perspectiveCamera;

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = true;
        this.controls.enableZoom = true;
        this.controls.minDistance = 0.015;
        this.controls.maxDistance = 15;
        this.controls.minZoom = 0.05;
        this.controls.maxZoom = 300;
        this.controls.maxPolarAngle = Math.PI;

        this.viewHelper = new InteractiveViewHelper(
            this.canvas,
            this.camera,
            this.controls.target,
            {
                onAxis: () => {
                    this.animationControlsState = {
                        enabled: this.controls.enabled,
                        damping: this.controls.enableDamping
                    };

                    this.controls.enabled = false;
                    this.controls.enableDamping = false;
                    this.setProjection("orthographic");
                },
                onCenter: () => {
                    this.setProjection(
                        this.camera.isPerspectiveCamera
                            ? "orthographic"
                            : "perspective"
                    );

                    this.saveCamera();
                },
                onAnimationEnd: () => {
                    this.controls.update();

                    if (this.animationControlsState) {
                        this.controls.enabled = this.animationControlsState.enabled;
                        this.controls.enableDamping = this.animationControlsState.damping;
                        this.animationControlsState = null;
                    }

                    this.saveCamera();
                }
            }
        );

        this.onCameraEnd = () => this.saveCamera();
        this.controls.addEventListener("end", this.onCameraEnd);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);

        this.restoreCamera();
        this.resize();
    }

    setProjection(type) {
        if (this.disposed) return;

        const next = type === "orthographic"
            ? this.orthographicCamera
            : this.perspectiveCamera;

        if (next === this.camera) return;

        const previous = this.camera;
        const target = this.controls.target;
        const direction = previous.position.clone().sub(target);
        const distance = Math.max(direction.length(), 0.01);

        direction.normalize();

        const tangent = Math.tan(
            THREE.MathUtils.degToRad(this.perspectiveCamera.fov / 2)
        );

        if (next.isOrthographicCamera) {
            this.orthographicHeight = Math.max(
                0.001,
                2 * distance * tangent / this.perspectiveCamera.zoom
            );

            next.zoom = 1;
        } else {
            const visibleHeight = this.orthographicHeight / previous.zoom;
            const perspectiveDistance = visibleHeight * next.zoom / (2 * tangent);

            direction.multiplyScalar(perspectiveDistance);
        }

        next.position.copy(target).add(
            next.isOrthographicCamera
                ? direction.multiplyScalar(distance)
                : direction
        );

        next.quaternion.copy(previous.quaternion);
        next.up.copy(previous.up);
        next.layers.mask = previous.layers.mask;
        next.updateMatrixWorld(true);

        this.camera = next;
        this.controls.object = next;
        this.viewHelper.setCamera(next);

        for (const transform of this.transformControls.keys()) {
            transform.camera = next;
        }

        this.resize();
        this.controls.update();
    }

    createTransformControls() {
        if (this.disposed) {
            throw new Error("Cannot create controls on a disposed viewport.");
        }

        const transform = new TransformControls(this.camera, this.canvas);

        const onDraggingChanged = event => {
            this.controls.enabled = !event.value;
        };

        transform.addEventListener("dragging-changed", onDraggingChanged);

        this.session.scene.add(transform.getHelper());
        this.transformControls.set(transform, onDraggingChanged);

        return transform;
    }

    releaseTransformControls(transform) {
        if (!this.transformControls.has(transform)) return;

        const callback = this.transformControls.get(transform);

        transform.removeEventListener("dragging-changed", callback);
        transform.detach();

        const helper = transform.getHelper();
        helper.parent?.remove(helper);

        transform.dispose();

        this.transformControls.delete(transform);
        this.controls.enabled = true;
    }

    restoreCamera() {
        if (this.disposed) return;

        const state = this.session.cameraState;

        this.camera.position.fromArray(state.position);
        this.controls.target.fromArray(state.target);
        this.controls.update();
    }

    centerOn(object) {
        if (!object || this.disposed) {
            return;
        }

        object.updateWorldMatrix(true, false);

        const target = object.getWorldPosition(
            new THREE.Vector3()
        );

        const offset = this.camera.position
            .clone()
            .sub(this.controls.target);

        this.controls.target.copy(target);
        this.camera.position.copy(target).add(offset);

        this.controls.update();
        this.saveCamera();
    }

    saveCamera() {
        if (this.disposed) return;

        void this.session.setCameraState(
            this.camera.position,
            this.controls.target
        ).catch(console.error);
    }

    resize() {
        if (this.disposed) return;

        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const aspect = width / height;

        this.renderer.setSize(width, height, false);

        this.perspectiveCamera.aspect = aspect;
        this.perspectiveCamera.updateProjectionMatrix();

        this.orthographicCamera.left = -this.orthographicHeight * aspect / 2;
        this.orthographicCamera.right = this.orthographicHeight * aspect / 2;
        this.orthographicCamera.top = this.orthographicHeight / 2;
        this.orthographicCamera.bottom = -this.orthographicHeight / 2;
        this.orthographicCamera.updateProjectionMatrix();
    }

    render() {
        if (this.disposed) return;

        const now = performance.now();

        const delta = this.lastRenderTime === null
            ? 0
            : Math.min((now - this.lastRenderTime) / 1000, 0.05);

        this.lastRenderTime = now;

        if (!this.viewHelper.update(delta)) {
            this.controls.update();
        }

        this.renderer.clear();
        this.renderer.render(this.session.scene, this.camera);
        this.viewHelper.render(this.renderer);
    }

    dispose() {
        if (this.disposed) return;

        this.saveCamera();

        for (const transform of [...this.transformControls.keys()]) {
            this.releaseTransformControls(transform);
        }

        this.controls.removeEventListener("end", this.onCameraEnd);
        this.resizeObserver.disconnect();

        this.viewHelper.dispose();
        this.controls.dispose();

        this.renderer.dispose();
        this.renderer.forceContextLoss();

        this.disposed = true;
    }
}