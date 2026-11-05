export default class IKView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error("Avatar Creator must be opened through index.html.");
        }

        this.session = this.app.session;

        this.dom = {
            canvas: document.getElementById("scene-canvas"),
            reset: document.getElementById("reset-ik"),
            animationToolbar: document.getElementById("animation-toolbar"),
            animationSelect: document.getElementById("animation-select"),
            animationToggle: document.getElementById("toggle-animation"),
            animationIcon: document.getElementById("animation-icon"),
            status: document.getElementById("status")
        };

        this.THREE = this.app.THREE;

        this.viewport = null;

        this.translation = null;
        this.rotation = null;

        this.raycaster = new this.THREE.Raycaster();
        this.pointer = new this.THREE.Vector2();

        this.ik = null;
        this.selectedKey = null;
        this.loadedAvatar = null;

        this.busy = false;
        this.dragChanged = false;

        this.onPointerDown = event => {
            this.handlePointerDown(event);
        };

        this.onSessionChange = () => {
            if (!this.ik || !this.translation) {
                return;
            }

            this.refresh();

            if (this.ik.avatar !== this.loadedAvatar) {
                this.loadedAvatar = this.ik.avatar;

                this.detachControls();

                if (this.ik.ready) {
                    this.selectTarget("hips");
                    this.hideStatus();
                    this.ik.logDefaults();
                } else {
                    this.selectedKey = null;

                    this.showStatus(
                        this.ik.error ?? "No IK-compatible avatar is loaded.",
                        "error"
                    );
                }
            }
        };

        this.dom.reset.onclick = () => {
            void this.reset();
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

        window.addEventListener("pagehide", () => {
            this.dispose();
        }, { once: true });
    }

    async initialize() {
        await this.app.ready;

        this.ik = this.session.ik;

        if (!this.ik) {
            throw new Error("IKController is not registered in AvatarSession.");
        }

        this.viewport = this.app.attachViewport(this.dom.canvas);

        this.initializeControls();

        this.dom.canvas.addEventListener(
            "pointerdown",
            this.onPointerDown,
            true
        );

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.ik.setVisible(true);
        this.loadedAvatar = this.ik.avatar;

        if (this.ik.ready) {
            this.selectTarget("hips");
            this.ik.logDefaults();
        } else {
            this.showStatus(
                this.ik.error ?? "No IK-compatible avatar is loaded.",
                "error"
            );
        }

        this.refresh();
    }

    initializeControls() {
        this.translation = this.viewport.createTransformControls();
        this.rotation = this.viewport.createTransformControls();

        this.translation.setMode("translate");
        this.translation.setSpace("world");
        this.translation.setSize(0.5);

        this.rotation.setMode("rotate");
        this.rotation.setSpace("local");
        this.rotation.setSize(0.8);

        const controls = [
            this.translation,
            this.rotation
        ];

        for (const control of controls) {
            control.addEventListener("objectChange", () => {
                if (!this.selectedKey || !this.ik?.ready) {
                    return;
                }

                this.ik.onObjectChange(this.selectedKey);

                this.dragChanged = true;
            });

            control.addEventListener("mouseUp", () => {
                if (!this.dragChanged) {
                    return;
                }

                this.dragChanged = false;

                this.ik.logDefaults();

                void this.ik.persist().catch(error => {
                    this.showStatus(error.message, "error");
                });
            });

            control.addEventListener("dragging-changed", event => {
                const other = control === this.translation
                    ? this.rotation
                    : this.translation;

                if (other) {
                    other.enabled = !event.value;
                }
            });
        }
    }

    detachControls() {
        this.translation?.detach();
        this.rotation?.detach();
    }

    handlePointerDown(event) {
        if (
            event.button !== 0 ||
            !this.ik?.ready ||
            !this.viewport ||
            !this.translation ||
            !this.rotation
        ) {
            return;
        }

        if (
            this.translation.dragging ||
            this.rotation.dragging ||
            this.translation.axis !== null ||
            this.rotation.axis !== null
        ) {
            return;
        }

        const rect = this.dom.canvas.getBoundingClientRect();

        if (rect.width === 0 || rect.height === 0) {
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

        const meshes = this.ik.markers
            .map(entry => entry.mesh)
            .filter(mesh => mesh.visible);

        const intersections = this.raycaster.intersectObjects(
            meshes,
            false
        );

        if (!intersections.length) {
            return;
        }

        const key = intersections[0].object.userData.ikKey;

        if (!key) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        this.selectTarget(key);
    }

    selectTarget(key) {
        if (!this.translation || !this.rotation || !this.ik?.ready) {
            return;
        }

        const target = this.ik.targets.get(key);

        this.detachControls();

        if (!target) {
            this.selectedKey = null;
            return;
        }

        this.selectedKey = key;
        this.ik.selectedKey = key;

        const isHips = key === "hips";
        const isHand = key.endsWith("Hand");

        this.translation.enabled = true;
        this.rotation.enabled = true;

        this.translation.showX = !isHips;
        this.translation.showY = true;
        this.translation.showZ = !isHips;

        this.translation.attach(target);

        if (isHand) {
            // Display rotation and translation simultaneously.
            this.rotation.attach(target);
        }
    }

    refreshAnimationOptions() {
        const names = this.session.getAnimationNames();
        const select = this.dom.animationSelect;

        const changed =
            select.options.length !== names.length ||
            names.some((name, index) => {
                return select.options[index]?.value !== name;
            });

        if (changed) {
            const options = names.map(name => {
                return new Option(name, name);
            });

            if (!options.length) {
                const option = new Option("No animations", "");

                option.disabled = true;
                options.push(option);
            }

            select.replaceChildren(...options);
        }

        if (this.session.selectedAnimation) {
            select.value = this.session.selectedAnimation;
        }

        this.dom.animationToolbar.hidden = names.length === 0;

        return names.length;
    }

    refresh() {
        if (!this.ik) {
            return;
        }

        const animationCount = this.refreshAnimationOptions();

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

        this.dom.animationSelect.disabled =
            this.busy || animationCount === 0;

        this.dom.animationToggle.disabled =
            this.busy || animationCount === 0;

        this.dom.reset.disabled =
            this.busy || !this.ik.ready;
    }

    showStatus(message, kind = "info") {
        this.dom.status.textContent = message;
        this.dom.status.dataset.kind = kind;
        this.dom.status.hidden = false;
    }

    hideStatus() {
        this.dom.status.hidden = true;
        this.dom.status.textContent = "";
    }

    async reset() {
        if (this.busy || !this.ik?.ready) {
            return;
        }

        this.busy = true;
        this.refresh();

        try {
            await this.ik.reset();

            this.hideStatus();
        } catch (error) {
            console.error(error);
            this.showStatus(error.message, "error");
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    dispose() {
        if (this.ik) {
            // Restore the original animation before leaving this view.
            this.ik.setVisible(false);
        }

        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.dom.canvas.removeEventListener(
            "pointerdown",
            this.onPointerDown,
            true
        );

        this.detachControls();

        if (this.viewport) {
            if (this.translation) {
                this.viewport.releaseTransformControls(
                    this.translation
                );
            }

            if (this.rotation) {
                this.viewport.releaseTransformControls(
                    this.rotation
                );
            }
        }

        this.translation = null;
        this.rotation = null;

        if (this.app.viewport === this.viewport) {
            this.app.detachViewport();
        }

        this.viewport = null;
    }
}

new IKView().initialize().catch(console.error);