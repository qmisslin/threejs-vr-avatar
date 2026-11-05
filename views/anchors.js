export default class AnchorsView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error(
                "Avatar Creator must be opened through index.html."
            );
        }

        this.session = this.app.session;
        this.anchors = this.app.anchors;
        this.assets = this.app.assets;

        this.dom = {
            canvas: document.getElementById("scene-canvas"),
            centerButton: document.getElementById("center-anchor"),
            anchorWrapper: document.getElementById("anchor-select-wrapper"),
            anchorSelect: document.getElementById("anchor-select"),
            boneWrapper: document.getElementById("bone-select-wrapper"),
            boneSelect: document.getElementById("bone-select"),
            assetWrapper: document.getElementById("asset-select-wrapper"),
            assetSelect: document.getElementById("asset-select"),
            add: document.getElementById("add-anchor"),
            mirror: document.getElementById("mirror-anchor"),
            copy: document.getElementById("copy-anchor"),
            rename: document.getElementById("rename-anchor"),
            remove: document.getElementById("remove-anchor"),
            animationToolbar: document.getElementById("animation-toolbar"),
            animationSelect: document.getElementById("animation-select"),
            animationToggle: document.getElementById("toggle-animation"),
            animationIcon: document.getElementById("animation-icon"),
            status: document.getElementById("status")
        };

        this.viewport = null;
        this.controls = [];
        this.attachedObject = null;
        this.busy = false;

        this.dom.add.onclick = () => {
            void this.addAnchor();
        };

        this.dom.anchorSelect.onchange = () => {
            if (this.busy) {
                return;
            }

            this.anchors.selectAnchor(
                this.dom.anchorSelect.value
            );
        };

        this.dom.boneSelect.onchange = () => {
            const id = this.anchors.selectedId;
            const bone = this.dom.boneSelect.value;

            if (!id) {
                return;
            }

            void this.perform(async () => {
                await this.anchors.setParentBone(id, bone);
            });
        };

        this.dom.mirror.onclick = () => {
            void this.mirrorAnchor();
        };

        this.dom.copy.onclick = () => {
            void this.copyAnchor();
        };

        this.dom.rename.onclick = () => {
            void this.renameAnchor();
        };

        this.dom.remove.onclick = () => {
            void this.removeAnchor();
        };

        this.dom.assetSelect.onchange = () => {
            try {
                this.anchors.setPreviewAsset(
                    this.dom.assetSelect.value
                );
            } catch (error) {
                console.error(error);
                this.showStatus(error.message, "error");
            }
        };

        this.dom.animationSelect.onchange = () => {
            const name = this.dom.animationSelect.value;

            if (name) {
                this.session.setAnimation(name);
            }
        };

        this.dom.animationToggle.onclick = () => {
            this.session.setPlaying(!this.session.playing);
        };

        this.onSessionChange = () => this.refresh();
        this.onAnchorsChange = () => this.refresh();
        this.onAssetsChange = () => this.refresh();

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
            this.dom.canvas
        );

        this.viewport.camera.layers.enable(1);

        this.createControls();

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.anchors.addEventListener(
            "change",
            this.onAnchorsChange
        );

        this.assets.addEventListener(
            "change",
            this.onAssetsChange
        );

        this.anchors.setVisible(true);
        this.refresh();
    }

    createControls() {

        document.getElementById("center-anchor").onclick = () => {
            this.viewport?.centerOn(
                this.anchors.selectedInstance?.object
            );
        };

        const definitions = [
            ["translate", 0.5, "local"],
            ["rotate", 0.8, "local"]
        ];

        for (const [mode, size, space] of definitions) {
            const control = this.viewport.createTransformControls();

            control.setMode(mode);
            control.setSpace(space);
            control.setSize(size);

            control.getHelper().traverse(object => {
                object.layers.set(1);
            });

            control.getRaycaster().layers.enable(1);

            control.addEventListener("objectChange", () => {
                this.anchors.onTransformChanged();
            });

            control.addEventListener("mouseUp", () => {
                void this.anchors.saveSelectedTransform().catch(error => {
                    console.error(error);
                    this.showStatus(error.message, "error");
                });
            });

            control.addEventListener("dragging-changed", event => {
                for (const other of this.controls) {
                    if (other !== control) {
                        other.enabled = !event.value;
                    }
                }
            });

            this.controls.push(control);
        }
    }

    attachControls() {
        const object = this.anchors.selectedInstance?.object ?? null;

        if (object === this.attachedObject) {
            return;
        }

        this.detachControls();
        this.attachedObject = object;

        if (!object) {
            return;
        }

        for (const control of this.controls) {
            control.attach(object);
        }
    }

    detachControls() {
        for (const control of this.controls) {
            control.detach();
        }

        this.attachedObject = null;
    }

    refreshSelect(select, items, emptyLabel, allowEmpty = false) {
        const options = [
            ...(allowEmpty
                ? [{ label: emptyLabel, value: "" }]
                : []),
            ...items
        ];

        if (!options.length) {
            options.push({
                label: emptyLabel,
                value: ""
            });
        }

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
                return new Option(item.label, item.value);
            })
        );
    }

    refreshAnimation() {
        const names = this.session.getAnimationNames();

        this.refreshSelect(
            this.dom.animationSelect,
            names.map(name => ({
                label: name,
                value: name
            })),
            "No animations"
        );

        const hasAnimations = names.length > 0;
        const hasAnchors = this.anchors.records.length > 0;

        this.dom.animationToolbar.hidden =
            !hasAnimations && !hasAnchors;

        this.dom.animationSelect.closest(".select-wrapper").hidden =
            !hasAnimations;

        this.dom.animationToggle.hidden = !hasAnimations;

        this.dom.animationSelect.value =
            this.session.selectedAnimation ?? "";

        this.dom.animationSelect.disabled =
            this.busy || !names.length;

        this.dom.animationToggle.disabled =
            this.busy || !names.length;

        this.dom.animationIcon.classList.toggle(
            "icon-play",
            !this.session.playing
        );

        this.dom.animationIcon.classList.toggle(
            "icon-pause",
            this.session.playing
        );

        this.dom.animationToggle.setAttribute(
            "aria-label",
            this.session.playing
                ? "Pause animation"
                : "Play animation"
        );
    }

    refresh() {
        const records = this.anchors.records;
        const bones = this.anchors.getBoneNames();
        const assets = this.assets.records;

        const hasAnchors = records.length > 0;
        const selected = this.anchors.selectedRecord;
        const hasSelection = Boolean(selected);

        this.refreshSelect(
            this.dom.anchorSelect,
            records.map(record => ({
                label: record.name,
                value: record.id
            })),
            "No anchors"
        );

        this.refreshSelect(
            this.dom.boneSelect,
            bones.map(name => ({
                label: name,
                value: name
            })),
            "No bones"
        );

        this.refreshSelect(
            this.dom.assetSelect,
            assets.map(asset => ({
                label: asset.name,
                value: asset.id
            })),
            "No asset",
            true
        );

        this.dom.anchorSelect.value =
            this.anchors.selectedId ?? "";

        this.dom.boneSelect.value =
            this.anchors.selectedBone;

        this.dom.assetSelect.value =
            this.anchors.previewAssetId ?? "";

        // Only Add remains in the property toolbar
        // until the first anchor has been created.
        this.dom.anchorWrapper.hidden = !hasAnchors;
        this.dom.centerButton.hidden = !hasAnchors;
        this.dom.boneWrapper.hidden = !hasAnchors;
        this.dom.mirror.hidden = !hasAnchors;
        this.dom.copy.hidden = !hasAnchors;
        this.dom.rename.hidden = !hasAnchors;
        this.dom.remove.hidden = !hasAnchors;
        this.dom.assetWrapper.hidden = !hasAnchors;

        this.dom.centerButton.disabled = 
            this.busy || !hasSelection;

        this.dom.add.disabled =
            this.busy || !bones.length;

        this.dom.anchorSelect.disabled =
            this.busy || !hasAnchors;

        this.dom.boneSelect.disabled =
            this.busy || !hasSelection;

        this.dom.mirror.disabled =
            this.busy || !hasSelection;

        this.dom.copy.disabled =
            this.busy || !hasSelection;

        this.dom.rename.disabled =
            this.busy || !hasSelection;

        this.dom.remove.disabled =
            this.busy || !hasSelection;

        this.dom.assetSelect.disabled =
            this.busy || !hasSelection;

        
        

        this.attachControls();
        this.refreshAnimation();
    }

    async perform(operation) {
        if (this.busy) {
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
                error.message ?? "Anchor operation failed.",
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async addAnchor() {
        if (!this.anchors.root) {
            return;
        }

        const name = window.prompt(
            "Anchor name",
            "New Anchor"
        );

        if (name === null) {
            return;
        }

        await this.perform(async () => {
            await this.anchors.add(name);
        });
    }

    async mirrorAnchor() {
        const id = this.anchors.selectedId;

        if (!id) {
            return;
        }

        await this.perform(async () => {
            await this.anchors.mirror(id);
        });
    }

    async copyAnchor() {
        const id = this.anchors.selectedId;

        if (!id) {
            return;
        }

        await this.perform(async () => {
            await this.anchors.copy(id);
        });
    }

    async renameAnchor() {
        const record = this.anchors.selectedRecord;

        if (!record) {
            return;
        }

        const name = window.prompt(
            "Anchor name",
            record.name
        );

        if (name === null) {
            return;
        }

        await this.perform(async () => {
            await this.anchors.rename(record.id, name);
        });
    }

    async removeAnchor() {
        const record = this.anchors.selectedRecord;

        if (!record) {
            return;
        }

        await this.perform(async () => {
            this.detachControls();
            await this.anchors.remove(record.id);
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

        this.anchors.removeEventListener(
            "change",
            this.onAnchorsChange
        );

        this.assets.removeEventListener(
            "change",
            this.onAssetsChange
        );

        this.detachControls();

        if (this.app.viewport === this.viewport) {
            for (const control of this.controls) {
                this.viewport.releaseTransformControls(
                    control
                );
            }

            this.app.detachViewport();
        }

        this.controls = [];
        this.anchors.setVisible(false);
        this.viewport = null;
    }
}

new AnchorsView().initialize().catch(console.error);