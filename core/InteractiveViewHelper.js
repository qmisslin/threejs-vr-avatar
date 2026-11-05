import * as THREE from "three";
import { ViewHelper } from "three/addons/helpers/ViewHelper.js";

const HELPER_SIZE = 128;
const CENTER_RADIUS = 13;

export default class InteractiveViewHelper {
    constructor(canvas, camera, target, { onAxis, onCenter, onAnimationEnd }) {
        this.canvas = canvas;
        this.onAxis = onAxis;
        this.onCenter = onCenter;
        this.onAnimationEnd = onAnimationEnd;
        this.pointerId = null;

        this.helper = new ViewHelper(camera, canvas);
        this.helper.center = target;
        this.helper.location.top = 12;
        this.helper.location.bottom = null;
        this.helper.location.right = 12;
        this.helper.location.left = null;
        this.helper.setLabels("X", "Y", "Z");

        // ViewHelper has no center button, so add a small visible target.
        this.centerMarker = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 12, 8),
            new THREE.MeshBasicMaterial({
                color: 0x8b95a5,
                depthTest: false,
                depthWrite: false,
                toneMapped: false
            })
        );

        this.centerMarker.renderOrder = 10;
        this.helper.add(this.centerMarker);

        this.onPointerDown = event => {
            if (event.button !== 0 || this.helper.animating) return;
            if (!this.getLocalPoint(event)) return;

            this.pointerId = event.pointerId;
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        this.onPointerUp = event => {
            if (event.pointerId !== this.pointerId) return;

            this.pointerId = null;
            event.preventDefault();
            event.stopImmediatePropagation();

            const point = this.getLocalPoint(event);
            if (!point || this.helper.animating) return;

            const dx = point.x - HELPER_SIZE / 2;
            const dy = point.y - HELPER_SIZE / 2;

            if (dx * dx + dy * dy <= CENTER_RADIUS * CENTER_RADIUS) {
                this.onCenter();
            } else if (this.helper.handleClick(event)) {
                this.onAxis();
            }
        };

        this.onPointerCancel = event => {
            if (event.pointerId !== this.pointerId) return;
            this.pointerId = null;
        };

        canvas.addEventListener("pointerdown", this.onPointerDown, true);
        canvas.addEventListener("pointerup", this.onPointerUp, true);
        canvas.addEventListener("pointercancel", this.onPointerCancel, true);
    }

    getLocalPoint(event) {
        const rect = this.canvas.getBoundingClientRect();
        const location = this.helper.location;

        const left = location.left !== null
            ? location.left
            : this.canvas.offsetWidth - HELPER_SIZE - location.right;

        const top = location.top !== null
            ? location.top
            : this.canvas.offsetHeight - HELPER_SIZE - location.bottom;

        const x = event.clientX - rect.left - left;
        const y = event.clientY - rect.top - top;

        return x >= 0 && y >= 0 && x <= HELPER_SIZE && y <= HELPER_SIZE
            ? { x, y }
            : null;
    }

    setCamera(camera) {
        this.helper.camera = camera;
    }

    update(delta) {
        if (!this.helper.animating) return false;

        this.helper.update(delta);

        if (!this.helper.animating) {
            this.onAnimationEnd();
        }

        return true;
    }

    render(renderer) {
        this.helper.render(renderer);
    }

    dispose() {
        this.canvas.removeEventListener("pointerdown", this.onPointerDown, true);
        this.canvas.removeEventListener("pointerup", this.onPointerUp, true);
        this.canvas.removeEventListener("pointercancel", this.onPointerCancel, true);

        this.centerMarker.geometry.dispose();
        this.centerMarker.material.dispose();
        this.helper.dispose();
    }
}