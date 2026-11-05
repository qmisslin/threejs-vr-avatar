import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import InteractiveViewHelper from "./InteractiveViewHelper.js";

export default class FirstPersonViewport {
    constructor(session, canvas, cameraController) {
        this.session = session;
        this.canvas = canvas;
        this.cameraController = cameraController;
        this.disposed = false;
        this.lastUpdateTime = null;

        this.worldPosition = new THREE.Vector3();
        this.worldQuaternion = new THREE.Quaternion();
        this.orthographicHeight = 1;

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

        this.perspectiveCamera = new THREE.PerspectiveCamera(65, 1, 0.015, 100);
        this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.015, 100);
        this.camera = this.perspectiveCamera;

        this.perspectiveCamera.name = "FirstPersonCamera";
        this.orthographicCamera.name = "FirstPersonOrthographicCamera";
        this.perspectiveCamera.layers.set(0);
        this.orthographicCamera.layers.set(0);

        this.lookPerspectiveCamera = new THREE.PerspectiveCamera(65, 1, 0.01, 10);
        this.lookOrthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
        this.lookCamera = this.lookPerspectiveCamera;

        this.lookControls = new OrbitControls(this.lookCamera, this.canvas);
        this.lookControls.enableRotate = true;
        this.lookControls.enableZoom = false;
        this.lookControls.enablePan = false;
        this.lookControls.enableDamping = false;
        this.lookControls.rotateSpeed = 0.65;
        this.lookControls.minPolarAngle = 0;
        this.lookControls.maxPolarAngle = Math.PI;

        this.viewHelper = new InteractiveViewHelper(
            this.canvas,
            this.lookCamera,
            this.lookControls.target,
            {
                onAxis: () => {
                    this.setProjection("orthographic");
                    this.lookControls.enabled = false;
                },
                onCenter: () => {
                    this.setProjection(
                        this.camera.isPerspectiveCamera
                            ? "orthographic"
                            : "perspective"
                    );
                },
                onAnimationEnd: () => {
                    this.lookControls.update();
                    this.lookControls.enabled = true;
                    this.saveOrientation();
                }
            }
        );

        this.frustumPerspectiveCamera = new THREE.PerspectiveCamera(
            65, 1, 0.015, 0.3
        );

        this.frustumOrthographicCamera = new THREE.OrthographicCamera(
            -1, 1, 1, -1, 0.015, 0.3
        );

        this.frustumCamera = this.frustumPerspectiveCamera;

        this.cameraHelper = new THREE.CameraHelper(this.frustumCamera);
        this.cameraHelper.name = "FirstPersonCameraHelper";
        this.cameraHelper.layers.set(1);
        this.cameraHelper.material.depthTest = false;
        this.cameraHelper.material.depthWrite = false;
        this.cameraHelper.renderOrder = 50;

        this.session.scene.add(this.cameraHelper);

        this.onLookEnd = () => this.saveOrientation();
        this.onCameraReset = () => this.restoreOrientation();

        this.lookControls.addEventListener("end", this.onLookEnd);
        this.cameraController.addEventListener("reset", this.onCameraReset);

        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.canvas);

        this.restoreOrientation();
        this.resize();
        this.update();
    }

    setProjection(type) {
        if (this.disposed) return;

        const nextCamera = type === "orthographic"
            ? this.orthographicCamera
            : this.perspectiveCamera;

        if (this.camera === nextCamera) return;

        const nextLook = type === "orthographic"
            ? this.lookOrthographicCamera
            : this.lookPerspectiveCamera;

        if (nextCamera.isOrthographicCamera) {
            const distance = Math.max(
                0.01,
                this.lookCamera.position.distanceTo(this.lookControls.target)
            );

            this.orthographicHeight = 2 * distance * Math.tan(
                THREE.MathUtils.degToRad(this.lookPerspectiveCamera.fov / 2)
            );

            nextLook.zoom = 1;
            nextCamera.zoom = 1;
        }

        nextLook.position.copy(this.lookCamera.position);
        nextLook.quaternion.copy(this.lookCamera.quaternion);
        nextLook.up.copy(this.lookCamera.up);
        nextLook.updateMatrixWorld(true);

        nextCamera.position.copy(this.camera.position);
        nextCamera.quaternion.copy(this.camera.quaternion);
        nextCamera.updateMatrixWorld(true);

        this.lookCamera = nextLook;
        this.camera = nextCamera;
        this.lookControls.object = nextLook;
        this.viewHelper.setCamera(nextLook);

        this.frustumCamera = type === "orthographic"
            ? this.frustumOrthographicCamera
            : this.frustumPerspectiveCamera;

        this.cameraHelper.camera = this.frustumCamera;
        this.cameraHelper.matrix = this.frustumCamera.matrixWorld;

        this.resize();
        this.lookControls.update();
        this.updateCamera();
    }

    restoreOrientation() {
        if (this.disposed) return;

        this.lookControls.target.set(0, 0, 0);
        this.lookCamera.position.copy(this.cameraController.orbitPosition);
        this.lookCamera.lookAt(this.lookControls.target);
        this.lookControls.update();

        this.updateCamera();
    }

    saveOrientation() {
        if (this.disposed || !this.cameraController.ready) return;

        this.cameraController.setOrbitPosition(this.lookCamera.position);

        void this.cameraController.persist().catch(console.error);
    }

    resize() {
        if (this.disposed) return;

        const rect = this.canvas.getBoundingClientRect();
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const aspect = width / height;

        this.renderer.setSize(width, height, false);

        for (const camera of [
            this.perspectiveCamera,
            this.lookPerspectiveCamera,
            this.frustumPerspectiveCamera
        ]) {
            camera.aspect = aspect;
            camera.updateProjectionMatrix();
        }

        for (const camera of [
            this.orthographicCamera,
            this.lookOrthographicCamera,
            this.frustumOrthographicCamera
        ]) {
            camera.left = -this.orthographicHeight * aspect / 2;
            camera.right = this.orthographicHeight * aspect / 2;
            camera.top = this.orthographicHeight / 2;
            camera.bottom = -this.orthographicHeight / 2;
            camera.updateProjectionMatrix();
        }

        this.cameraHelper.update();
    }

    updateCamera() {
        const anchor = this.cameraController.anchor;
        const root = this.cameraController.root;

        if (!anchor || !root) return;

        this.cameraController.setLookQuaternion(this.lookCamera.quaternion);

        anchor.updateWorldMatrix(true, false);
        anchor.getWorldPosition(this.worldPosition);
        root.getWorldQuaternion(this.worldQuaternion);

        this.camera.position.copy(this.worldPosition);

        this.camera.quaternion
            .copy(this.worldQuaternion)
            .multiply(this.lookCamera.quaternion);

        this.camera.updateMatrixWorld(true);

        this.frustumCamera.position.copy(this.camera.position);
        this.frustumCamera.quaternion.copy(this.camera.quaternion);
        this.frustumCamera.updateMatrixWorld(true);

        this.cameraHelper.update();
    }

    update() {
        if (this.disposed) return;

        const now = performance.now();

        const delta = this.lastUpdateTime === null
            ? 0
            : Math.min((now - this.lastUpdateTime) / 1000, 0.05);

        this.lastUpdateTime = now;

        if (!this.viewHelper.update(delta)) {
            this.lookControls.update();
        }

        this.updateCamera();
    }

    render() {
        if (this.disposed) return;

        this.renderer.clear();
        this.renderer.render(this.session.scene, this.camera);
        this.viewHelper.render(this.renderer);
    }

    dispose() {
        if (this.disposed) return;

        this.saveOrientation();

        this.lookControls.removeEventListener("end", this.onLookEnd);
        this.cameraController.removeEventListener("reset", this.onCameraReset);

        this.resizeObserver.disconnect();
        this.session.scene.remove(this.cameraHelper);
        this.cameraHelper.dispose();

        this.viewHelper.dispose();
        this.lookControls.dispose();

        this.renderer.dispose();
        this.renderer.forceContextLoss();

        this.disposed = true;
    }
}