export default class AssetsView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error(
                "Avatar Creator must be opened through index.html."
            );
        }

        this.session = this.app.session;
        this.assets = this.app.assets;
        this.THREE = this.app.THREE;

        this.dom = {
            canvas: document.getElementById("scene-canvas"),
            importButton: document.getElementById("import-asset"),
            fileInput: document.getElementById("asset-file"),
            assetSelectWrapper: document.getElementById("asset-select-wrapper"),
            assetSelect: document.getElementById("asset-select"),
            remove: document.getElementById("remove-asset"),
            reset: document.getElementById("reset-assets"),
            rename: document.getElementById("rename-asset"),
            status: document.getElementById("status")
        };

        this.viewport = null;
        this.originControl = null;
        this.attachedOrigin = null;

        this.scaleSphere = null;
        this.scaleLine = null;
        this.scaleResizeObserver = null;
        this.scaleDrag = null;

        this.raycaster = new this.THREE.Raycaster();
        this.pointer = new this.THREE.Vector2();

        this.busy = false;
        this.dirtyOrigin = false;

        this.onAssetsChange = () => this.refresh();
        this.onSessionChange = () => this.refresh();
        this.onOrbitChange = () => this.updateScaleGizmo();

        this.onPointerDown = event => {
            this.handleScalePointerDown(event);
        };

        this.onPointerMove = event => {
            this.handleScalePointerMove(event);
        };

        this.onPointerUp = event => {
            void this.handleScalePointerUp(event);
        };

        this.dom.importButton.onclick = () => {
            this.dom.fileInput.click();
        };

        this.dom.fileInput.onchange = () => {
            const files = [...this.dom.fileInput.files];

            this.dom.fileInput.value = "";

            void this.importFiles(files);
        };

        this.dom.assetSelect.onchange = () => {
            this.selectAsset(this.dom.assetSelect.value);
        };

        this.dom.remove.onclick = () => {
            void this.removeSelected();
        };

        this.dom.reset.onclick = () => {
            void this.resetAssets();
        };

        this.dom.rename.onclick = () => {
            void this.renameSelected();
        };

        window.addEventListener("pagehide", () => {
            this.dispose();
        }, { once: true });
    }

    async initialize() {
        await this.app.ready;
        await this.assets.rebuildPromise;

        this.session.ik?.setVisible(false);
        this.app.viewCamera?.setVisible(false);

        this.viewport = this.app.attachViewport(
            this.dom.canvas,
            this.assets.viewportSession
        );

        this.createOriginControl();
        this.createScaleGizmo();

        this.viewport.controls.addEventListener(
            "change",
            this.onOrbitChange
        );

        this.dom.canvas.addEventListener(
            "pointerdown",
            this.onPointerDown,
            true
        );

        this.dom.canvas.addEventListener(
            "pointermove",
            this.onPointerMove,
            true
        );

        this.dom.canvas.addEventListener(
            "pointerup",
            this.onPointerUp,
            true
        );

        this.dom.canvas.addEventListener(
            "pointercancel",
            this.onPointerUp,
            true
        );

        this.scaleResizeObserver = new ResizeObserver(() => {
            this.updateScaleGizmo();
        });

        this.scaleResizeObserver.observe(this.dom.canvas);

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.assets.addEventListener(
            "change",
            this.onAssetsChange
        );

        if (!this.assets.selectedInstance && this.assets.instances.size) {
            this.assets.select(
                this.assets.instances.keys().next().value
            );
        }

        this.refresh();
    }

    createOriginControl() {
        this.originControl = this.viewport.createTransformControls();

        this.originControl.setMode("translate");
        this.originControl.setSpace("world");
        this.originControl.setSize(0.5);

        this.originControl.addEventListener("objectChange", () => {
            const id = this.assets.selectedId;

            if (!id) {
                return;
            }

            this.assets.onOriginChanged(id);
            this.updateScaleGizmo();

            this.dirtyOrigin = true;
        });

        this.originControl.addEventListener("mouseUp", () => {
            void this.persistOrigin();
        });
    }

    createScaleGizmo() {
        const sphereGeometry = new this.THREE.SphereGeometry(
            1,
            20,
            16
        );

        const sphereMaterial = new this.THREE.MeshBasicMaterial({
            color: 0xf0bd57,
            depthTest: false,
            depthWrite: false,
            toneMapped: false
        });

        this.scaleSphere = new this.THREE.Mesh(
            sphereGeometry,
            sphereMaterial
        );

        this.scaleSphere.name = "AssetUniformScaleHandle";
        this.scaleSphere.renderOrder = 201;
        this.scaleSphere.visible = false;

        const lineGeometry = new this.THREE.BufferGeometry();

        lineGeometry.setAttribute(
            "position",
            new this.THREE.Float32BufferAttribute(
                new Float32Array(6),
                3
            )
        );

        const lineMaterial = new this.THREE.LineBasicMaterial({
            color: 0xf0bd57,
            depthTest: false,
            depthWrite: false,
            toneMapped: false
        });

        this.scaleLine = new this.THREE.Line(
            lineGeometry,
            lineMaterial
        );

        this.scaleLine.name = "AssetUniformScaleAxis";
        this.scaleLine.renderOrder = 200;
        this.scaleLine.visible = false;

        this.assets.scene.add(this.scaleLine);
        this.assets.scene.add(this.scaleSphere);
    }

    updateScaleGizmo() {
        if (!this.viewport || !this.scaleSphere || !this.scaleLine) {
            return;
        }

        const instance = this.assets.selectedInstance;

        const visible = Boolean(
            instance &&
            instance.origin.visible
        );

        this.scaleSphere.visible = visible;
        this.scaleLine.visible = visible;

        if (!visible) {
            return;
        }

        const origin = instance.origin.getWorldPosition(
            new this.THREE.Vector3()
        );

        const camera = this.viewport.camera;
        const height = Math.max(1, this.dom.canvas.clientHeight);

        let worldPerPixel;

        if (camera.isOrthographicCamera) {
            // Orthographic scale depends on frustum height and zoom.
            worldPerPixel = (
                camera.top - camera.bottom
            ) / (camera.zoom * height);
        } else if (camera.isPerspectiveCamera) {
            // Perspective scale depends on distance, FOV and zoom.
            const distance = Math.max(
                camera.near,
                camera.position.distanceTo(origin)
            );

            worldPerPixel = (
                2 *
                distance *
                Math.tan(
                    this.THREE.MathUtils.degToRad(camera.fov / 2)
                )
            ) / (camera.zoom * height);
        } else {
            return;
        }

        if (!Number.isFinite(worldPerPixel) || worldPerPixel <= 0) {
            this.scaleSphere.visible = false;
            this.scaleLine.visible = false;
            return;
        }

        const offset = worldPerPixel * 85;
        const radius = worldPerPixel * 14;

        let dragOffset = 0;

        if (
            this.scaleDrag &&
            this.scaleDrag.id === this.assets.selectedId
        ) {
            dragOffset = (
                this.scaleDrag.startY -
                this.scaleDrag.currentY
            ) * worldPerPixel;
        }

        this.scaleSphere.position.set(
            origin.x,
            origin.y - offset + dragOffset,
            origin.z
        );

        this.scaleSphere.scale.setScalar(radius);

        const position = this.scaleLine.geometry.getAttribute(
            "position"
        );

        position.setXYZ(
            0,
            origin.x,
            origin.y,
            origin.z
        );

        position.setXYZ(
            1,
            this.scaleSphere.position.x,
            this.scaleSphere.position.y,
            this.scaleSphere.position.z
        );

        position.needsUpdate = true;

        this.scaleLine.geometry.computeBoundingSphere();
        this.scaleSphere.updateWorldMatrix(true, false);
    }

    handleScalePointerDown(event) {
        if (
            event.button !== 0 ||
            this.busy ||
            this.scaleDrag ||
            !this.scaleSphere?.visible
        ) {
            return;
        }

        this.updateScaleGizmo();

        const rect = this.dom.canvas.getBoundingClientRect();

        if (!rect.width || !rect.height) {
            return;
        }

        this.pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1
        );

        this.raycaster.setFromCamera(
            this.pointer,
            this.viewport.camera
        );

        const intersections = this.raycaster.intersectObject(
            this.scaleSphere,
            false
        );

        if (!intersections.length) {
            return;
        }

        const instance = this.assets.selectedInstance;

        if (!instance) {
            return;
        }

        this.scaleDrag = {
            id: instance.record.id,
            pointerId: event.pointerId,
            startY: event.clientY,
            currentY: event.clientY,
            startScale: Math.max(
                0.005,
                Math.abs(instance.model.scale.x)
            )
        };

        this.viewport.controls.enabled = false;
        this.dom.canvas.setPointerCapture(event.pointerId);

        event.preventDefault();
        event.stopImmediatePropagation();

        this.refresh();
    }

    handleScalePointerMove(event) {
        const drag = this.scaleDrag;

        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        const instance = this.assets.getInstance(drag.id);

        if (!instance) {
            return;
        }

        drag.currentY = event.clientY;

        // Moving upward increases the uniform scale.
        const factor = Math.exp(
            (drag.startY - drag.currentY) * 0.01
        );

        const scale = this.THREE.MathUtils.clamp(
            drag.startScale * factor,
            0.005,
            100
        );

        instance.scaleHandle.scale.setScalar(scale);

        // AssetController updates the model and its bounding box.
        this.assets.onScaleChanged(drag.id);

        this.updateScaleGizmo();
    }

    async handleScalePointerUp(event) {
        const drag = this.scaleDrag;

        if (!drag || drag.pointerId !== event.pointerId) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        this.scaleDrag = null;

        if (this.dom.canvas.hasPointerCapture(event.pointerId)) {
            this.dom.canvas.releasePointerCapture(event.pointerId);
        }

        if (this.viewport) {
            this.viewport.controls.enabled = true;
        }

        const instance = this.assets.getInstance(drag.id);

        if (instance) {
            this.assets.positionScaleHandle(instance);
        }

        this.updateScaleGizmo();
        this.refresh();

        try {
            await this.assets.saveTransform(drag.id);
        } catch (error) {
            console.error(error);
            this.showStatus(error.message, "error");
        }
    }

    async persistOrigin() {
        if (!this.dirtyOrigin || !this.assets.selectedId) {
            return;
        }

        this.dirtyOrigin = false;

        try {
            await this.assets.saveTransform(
                this.assets.selectedId
            );
        } catch (error) {
            console.error(error);
            this.showStatus(error.message, "error");
        }
    }

    attachControls() {
        const instance = this.assets.selectedInstance;
        const origin = instance?.origin ?? null;

        if (origin !== this.attachedOrigin) {
            this.originControl?.detach();
            this.attachedOrigin = origin;

            this.dirtyOrigin = false;

            if (origin) {
                this.originControl?.attach(origin);
            }
        }

        this.updateScaleGizmo();
    }

    detachControls() {
        this.originControl?.detach();
        this.attachedOrigin = null;
        this.dirtyOrigin = false;
    }

    selectAsset(id) {
        if (this.busy || this.scaleDrag) {
            return;
        }

        this.assets.select(id);
    }

    refreshSelect(select, items, emptyLabel) {
        const options = items.length
            ? items
            : [{ label: emptyLabel, value: "" }];

        const changed =
            select.options.length !== options.length ||
            options.some((item, index) => {
                return select.options[index]?.value !== item.value ||
                    select.options[index]?.text !== item.label;
            });

        if (!changed) {
            return;
        }

        select.replaceChildren(
            ...options.map(item => {
                const option = new Option(item.label, item.value);

                if (!items.length) {
                    option.disabled = true;
                }

                return option;
            })
        );
    }

    refresh() {
        const records = this.assets.records;
        const hasAssets = records.length > 0;
        const editing = this.busy || Boolean(this.scaleDrag);

        this.refreshSelect(
            this.dom.assetSelect,
            records.map(record => ({
                label: record.name,
                value: record.id
            })),
            "No assets"
        );

        this.dom.assetSelect.value =
            this.assets.selectedId ?? "";

        // Only Import Asset remains visible when the list is empty.
        this.dom.assetSelectWrapper.hidden = !hasAssets;
        this.dom.remove.hidden = !hasAssets;
        this.dom.reset.hidden = !hasAssets;
        this.dom.rename.hidden = !hasAssets;

        this.attachControls();

        const selected = Boolean(
            this.assets.selectedInstance
        );

        this.dom.importButton.disabled = editing;
        this.dom.assetSelect.disabled = editing || !hasAssets;
        this.dom.remove.disabled = editing || !selected;
        this.dom.rename.disabled = editing || !selected;
        this.dom.reset.disabled = editing || !hasAssets;
    }

    async perform(operation) {
        if (this.busy || this.scaleDrag) {
            return;
        }

        this.busy = true;
        this.refresh();

        try {
            await operation();
            this.hideStatus();
        } catch (error) {
            console.error(error);

            this.showStatus(
                error.message ?? "Asset operation failed.",
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async importFiles(files) {
        if (!files.length) {
            return;
        }

        await this.perform(async () => {
            for (let i = 0; i < files.length; i++) {
                this.showStatus(
                    `Importing ${i + 1}/${files.length}: ${files[i].name}`
                );

                const id = await this.assets.importFile(
                    files[i]
                );

                this.assets.select(id);
            }
        });
    }

    async removeSelected() {
        if (!this.assets.selectedId) {
            return;
        }

        await this.perform(async () => {
            const id = this.assets.selectedId;

            this.detachControls();
            await this.assets.remove(id);
        });
    }

    async resetAssets() {
        if (!this.assets.records.length) {
            return;
        }

        if (!window.confirm("Remove all imported assets?")) {
            return;
        }

        await this.perform(async () => {
            this.detachControls();

            await this.assets.reset();
        });
    }

    async renameSelected() {
        const selected = this.assets.records.find(record => {
            return record.id === this.assets.selectedId;
        });

        if (!selected) {
            return;
        }

        const name = window.prompt(
            "Asset name",
            selected.name
        );

        if (name === null) {
            return;
        }

        await this.perform(async () => {
            await this.assets.rename(selected.id, name);
        });
    }

    showStatus(message, kind = "info") {
        this.dom.status.textContent = message;
        this.dom.status.dataset.kind = kind;
        this.dom.status.hidden = false;
    }

    hideStatus() {
        this.dom.status.textContent = "";
        this.dom.status.hidden = true;
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.assets.removeEventListener(
            "change",
            this.onAssetsChange
        );

        this.dom.canvas.removeEventListener(
            "pointerdown",
            this.onPointerDown,
            true
        );

        this.dom.canvas.removeEventListener(
            "pointermove",
            this.onPointerMove,
            true
        );

        this.dom.canvas.removeEventListener(
            "pointerup",
            this.onPointerUp,
            true
        );

        this.dom.canvas.removeEventListener(
            "pointercancel",
            this.onPointerUp,
            true
        );

        this.scaleResizeObserver?.disconnect();

        if (this.viewport) {
            this.viewport.controls.removeEventListener(
                "change",
                this.onOrbitChange
            );

            if (this.scaleDrag) {
                this.viewport.controls.enabled = true;
                this.scaleDrag = null;
            }

            if (this.originControl) {
                this.viewport.releaseTransformControls(
                    this.originControl
                );
            }
        }

        this.detachControls();

        for (const object of [
            this.scaleSphere,
            this.scaleLine
        ]) {
            if (!object) {
                continue;
            }

            object.parent?.remove(object);
            object.geometry.dispose();
            object.material.dispose();
        }

        this.scaleSphere = null;
        this.scaleLine = null;
        this.originControl = null;

        if (this.app.viewport === this.viewport) {
            this.app.detachViewport();
        }

        this.viewport = null;
    }
}

new AssetsView().initialize().catch(console.error);