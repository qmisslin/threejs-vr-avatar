export default class HandsView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error(
                "Avatar Creator must be opened through index.html."
            );
        }

        this.session = this.app.session;
        this.hands = this.app.hands;
        this.anchors = this.app.anchors;
        this.assets = this.app.assets;

        this.dom = {
            canvas: document.getElementById("scene-canvas"),
            add: document.getElementById("add-pose"),
            load: document.getElementById("load-pose"),
            loadInput: document.getElementById("load-pose-input"),
            poseWrapper: document.getElementById("pose-wrapper"),
            poseSelect: document.getElementById("pose-select"),
            reset: document.getElementById("reset-pose"),
            remove: document.getElementById("remove-pose"),
            anchorWrapper: document.getElementById("anchor-wrapper"),
            anchorSelect: document.getElementById("anchor-select"),
            center: document.getElementById("center-anchor"),
            assetWrapper: document.getElementById("asset-wrapper"),
            assetSelect: document.getElementById("asset-select"),
            animationToolbar: document.getElementById("animation-toolbar"),
            animationSelect: document.getElementById("animation-select"),
            animationToggle: document.getElementById("toggle-animation"),
            animationIcon: document.getElementById("animation-icon"),
            status: document.getElementById("status")
        };

        this.viewport = null;
        this.controls = new Map();
        this.boundAvatar = null;
        this.busy = false;

        this.dom.add.onclick = () => {
            void this.addPose();
        };

        this.dom.load.onclick = () => {
            this.dom.loadInput.click();
        };

        this.dom.loadInput.onchange = () => {
            const file = this.dom.loadInput.files[0];
            this.dom.loadInput.value = "";

            if (file) {
                void this.loadPoses(file);
            }
        };

        this.dom.poseSelect.onchange = () => {
            if (this.busy) {
                return;
            }

            this.hands.selectPose(
                this.dom.poseSelect.value
            );
        };

        this.dom.reset.onclick = () => {
            void this.resetPose();
        };

        this.dom.remove.onclick = () => {
            void this.removePose();
        };

        this.dom.anchorSelect.onchange = () => {
            if (this.busy) {
                return;
            }

            this.anchors.selectAnchor(
                this.dom.anchorSelect.value
            );
        };

        this.dom.center.onclick = () => {
            this.viewport?.centerOn(
                this.anchors.selectedInstance?.object
            );
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
            this.session.setPlaying(
                !this.session.playing
            );
        };

        this.onSessionChange = () => {
            if (this.boundAvatar !== this.session.avatar) {
                this.bindControls();
            }

            this.refresh();
        };

        this.onHandsChange = () => this.refresh();
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

        if (this.hands.avatar !== this.session.avatar) {
            this.hands.rebuild();
        }

        this.viewport = this.app.attachViewport(
            this.dom.canvas
        );

        this.viewport.camera.layers.enable(1);

        this.bindControls();

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.hands.addEventListener(
            "change",
            this.onHandsChange
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
        this.hands.setVisible(true);

        this.refresh();
    }

    bindControls() {
        if (!this.viewport) {
            return;
        }

        this.detachControls();

        for (const control of this.controls.values()) {
            this.viewport.releaseTransformControls(control);
        }

        this.controls.clear();
        this.boundAvatar = this.session.avatar;

        for (const entry of this.hands.getEditableBones()) {
            const control = this.viewport.createTransformControls();

            control.setMode("rotate");
            control.setSpace("local");
            control.setSize(0.23);

            control.getHelper().traverse(object => {
                object.layers.set(1);
            });

            control.getRaycaster().layers.enable(1);

            control.addEventListener("objectChange", () => {
                this.hands.onBoneChanged(entry.name);
            });

            control.addEventListener("mouseUp", () => {
                void this.hands.saveSelectedPose().catch(error => {
                    console.error(error);
                    this.showStatus(error.message, "error");
                });
            });

            control.addEventListener("dragging-changed", event => {
                for (const other of this.controls.values()) {
                    if (other !== control) {
                        other.enabled = !event.value;
                    }
                }
            });

            this.controls.set(entry.name, control);
        }

        this.attachControls();
    }

    attachControls() {
        const editable = Boolean(
            this.hands.selectedRecord &&
            this.hands.visible
        );

        const bones = new Map(
            this.hands.getEditableBones().map(entry => [
                entry.name,
                entry.bone
            ])
        );

        for (const [name, control] of this.controls) {
            const bone = editable
                ? bones.get(name)
                : null;

            if (!bone) {
                if (control.object) {
                    control.detach();
                }

                continue;
            }

            if (control.object !== bone) {
                control.attach(bone);
            }
        }
    }

    detachControls() {
        for (const control of this.controls.values()) {
            control.detach();
        }
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

        if (changed) {
            select.replaceChildren(
                ...options.map(item => {
                    return new Option(item.label, item.value);
                })
            );
        }
    }

    refreshAnimation() {
        const names = this.session.getAnimationNames();
        const hasAnimations = names.length > 0;

        this.refreshSelect(
            this.dom.animationSelect,
            names.map(name => ({
                label: name,
                value: name
            })),
            "No animations"
        );

        this.dom.animationToolbar.hidden = !hasAnimations;

        this.dom.animationSelect.value =
            this.session.selectedAnimation ?? "";

        this.dom.animationSelect.disabled =
            this.busy || !hasAnimations;

        this.dom.animationToggle.disabled =
            this.busy || !hasAnimations;

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
        const poses = this.hands.records;
        const selected = this.hands.selectedRecord;
        const hasPoses = poses.length > 0;

        const anchors = this.anchors.records;
        const assets = this.assets.records;

        this.refreshSelect(
            this.dom.poseSelect,
            poses.map(record => ({
                label: record.name,
                value: record.id
            })),
            "default",
            true
        );

        this.refreshSelect(
            this.dom.anchorSelect,
            anchors.map(record => ({
                label: record.name,
                value: record.id
            })),
            "No anchor",
            true
        );

        this.refreshSelect(
            this.dom.assetSelect,
            assets.map(record => ({
                label: record.name,
                value: record.id
            })),
            "No asset",
            true
        );

        this.dom.poseSelect.value =
            this.hands.selectedId ?? "";

        this.dom.anchorSelect.value =
            this.anchors.selectedId ?? "";

        this.dom.assetSelect.value =
            this.anchors.previewAssetId ?? "";

        this.dom.poseWrapper.hidden = false;

        this.dom.reset.hidden = !selected;
        this.dom.remove.hidden = !selected;

        this.dom.anchorWrapper.hidden = !hasPoses;
        this.dom.assetWrapper.hidden = !hasPoses;
        this.dom.center.hidden = !hasPoses;

        this.dom.add.disabled =
            this.busy || !this.hands.bones.size;

        this.dom.load.disabled = this.busy;

        this.dom.poseSelect.disabled = this.busy;

        this.dom.reset.disabled =
            this.busy || !selected;

        this.dom.remove.disabled =
            this.busy || !selected;

        this.dom.anchorSelect.disabled =
            this.busy || !anchors.length;

        this.dom.assetSelect.disabled =
            this.busy || !assets.length;

        this.dom.center.disabled =
            this.busy || !this.anchors.selectedInstance;

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
            const result = await operation();

            if (typeof result === "string") {
                this.showStatus(result, "success");
            } else {
                this.hideStatus();
            }
        } catch (error) {
            console.error(error);

            this.showStatus(
                error.message ?? "Hand pose operation failed.",
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async addPose() {
        const name = window.prompt(
            "Pose name",
            "New Pose"
        );

        if (name === null) {
            return;
        }

        await this.perform(async () => {
            await this.hands.add(name);
        });
    }

    async loadPoses(file) {
        await this.perform(async () => {
            this.showStatus(
                `Reading hand poses from ${file.name}...`
            );

            const { added, replaced, skipped } =
                await this.hands.importGLB(file);

            return [
                `${added} pose(s) added`,
                `${replaced} replaced`,
                `${skipped} incomplete or invalid pose(s) skipped`
            ].join(", ");
        });
    }

    async resetPose() {
        if (!this.hands.selectedRecord) {
            return;
        }

        await this.perform(async () => {
            await this.hands.reset();
        });
    }

    async removePose() {
        const id = this.hands.selectedId;

        if (!id) {
            return;
        }

        await this.perform(async () => {
            this.detachControls();
            await this.hands.remove(id);
        });
    }

    showStatus(message, kind = "info") {
        clearTimeout(this.statusTimeout);

        this.dom.status.textContent = message;
        this.dom.status.dataset.kind = kind;
        this.dom.status.hidden = false;

        if (kind !== "info") {
            this.statusTimeout = setTimeout(() => {
                this.hideStatus();
            }, 5000);
        }
    }

    hideStatus() {
        clearTimeout(this.statusTimeout);
        this.statusTimeout = null;

        this.dom.status.textContent = "";
        this.dom.status.hidden = true;
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.hands.removeEventListener(
            "change",
            this.onHandsChange
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
            for (const control of this.controls.values()) {
                this.viewport.releaseTransformControls(control);
            }

            this.app.detachViewport();
        }

        this.controls.clear();

        this.hands.setVisible(false);
        this.anchors.setVisible(false);

        this.viewport = null;
    }
}

new HandsView().initialize().catch(console.error);