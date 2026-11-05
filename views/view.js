export default class ViewView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error(
                "Avatar Creator must be opened through index.html."
            );
        }

        this.session = this.app.session;

        this.dom = {
            avatarCanvas: document.getElementById("avatar-canvas"),
            cameraCanvas: document.getElementById("camera-canvas"),
            reset: document.getElementById("reset-camera"),
            animationToolbar: document.getElementById("animation-toolbar"),
            animationSelect: document.getElementById("animation-select"),
            animationToggle: document.getElementById("toggle-animation"),
            animationIcon: document.getElementById("animation-icon"),
            status: document.getElementById("status")
        };

        this.cameraController = null;

        this.editorViewport = null;
        this.firstPersonViewport = null;

        this.transform = null;
        this.attachedAnchor = null;

        this.busy = false;

        this.dom.reset.disabled = true;

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

        this.onSessionChange = () => {
            if (!this.cameraController) {
                return;
            }

            this.refresh();

            if (this.cameraController.anchor !== this.attachedAnchor) {
                this.attachCameraGizmo();
            }
        };

        window.addEventListener("pagehide", () => {
            this.dispose();
        }, { once: true });
    }

    async initialize() {
        await this.app.ready;

        this.cameraController = this.app.viewCamera;

        // The first-person camera editor never applies IK.
        this.session.ik?.setVisible(false);

        if (!this.cameraController?.ready) {
            this.showStatus(
                this.cameraController?.error ??
                "No compatible camera anchor is available.",
                "error"
            );

            this.refresh();
            return;
        }

        const viewports = this.app.attachFirstPersonViewports(
            this.dom.avatarCanvas,
            this.dom.cameraCanvas
        );

        this.editorViewport = viewports.editor;
        this.firstPersonViewport = viewports.firstPerson;

        // The left camera also displays editor-only objects.
        this.editorViewport.camera.layers.enable(1);

        this.transform = this.editorViewport
            .createTransformControls();

        this.transform.setMode("translate");
        this.transform.setSpace("local");
        this.transform.setSize(0.55);

        this.transform.showX = false;
        this.transform.showY = true;
        this.transform.showZ = true;

        // Editor helpers are not rendered by the right camera.
        this.transform.getHelper().traverse(object => {
            object.layers.set(1);
        });

        // Keep layer 0 enabled for other controls.
        this.transform.getRaycaster().layers.enable(1);

        this.transform.addEventListener(
            "objectChange",
            () => {
                this.cameraController.onAnchorChanged();
            }
        );

        this.transform.addEventListener(
            "mouseUp",
            () => {
                void this.cameraController.persist().catch(error => {
                    this.showStatus(error.message, "error");
                });
            }
        );

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.cameraController.setVisible(true);

        this.attachCameraGizmo();
        this.refresh();
    }

    attachCameraGizmo() {
        if (!this.transform) {
            return;
        }

        this.transform.detach();

        this.attachedAnchor = null;

        if (!this.cameraController.ready) {
            this.showStatus(
                this.cameraController.error ??
                "Camera anchor is unavailable.",
                "error"
            );

            return;
        }

        this.attachedAnchor = this.cameraController.anchor;

        this.transform.attach(this.attachedAnchor);

        this.transform.setMode("translate");
        this.transform.setSpace("local");

        this.transform.showX = false;
        this.transform.showY = true;
        this.transform.showZ = true;

        this.hideStatus();
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
        } else {
            select.selectedIndex = 0;
        }

        this.dom.animationToolbar.hidden = names.length === 0;

        return names.length;
    }

    refresh() {
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
            this.busy || !this.cameraController?.ready;
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
        if (
            this.busy ||
            !this.cameraController?.ready
        ) {
            return;
        }

        this.busy = true;
        this.refresh();

        try {
            await this.cameraController.reset();

            this.hideStatus();
        } catch (error) {
            console.error(error);

            this.showStatus(
                error.message,
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.cameraController?.setVisible(false);

        if (this.transform && this.editorViewport) {
            this.editorViewport.releaseTransformControls(
                this.transform
            );
        }

        this.transform = null;
        this.attachedAnchor = null;

        if (this.app.viewport === this.editorViewport) {
            this.app.detachViewport();
        }

        this.editorViewport = null;
        this.firstPersonViewport = null;
    }
}

new ViewView().initialize().catch(console.error);