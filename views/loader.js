export default class LoaderView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error("Avatar Creator must be opened through index.html.");
        }

        this.session = this.app.session;

        this.dom = {
            canvas: document.getElementById("scene-canvas"),
            load: document.getElementById("load-fbx"),
            open: document.getElementById("open-glb"),
            reset: document.getElementById("reset-scene"),
            fbxInput: document.getElementById("fbx-input"),
            glbInput: document.getElementById("glb-input"),
            animationToolbar: document.getElementById("animation-toolbar"),
            animationSelect: document.getElementById("animation-select"),
            animationToggle: document.getElementById("toggle-animation"),
            animationIcon: document.getElementById("animation-icon"),
            status: document.getElementById("status")
        };

        this.busy = false;

        this.session.ik?.setVisible(false);
        this.app.attachViewport(this.dom.canvas);

        this.dom.load.onclick = () => {
            this.dom.fbxInput.click();
        };

        this.dom.open.onclick = () => {
            this.dom.glbInput.click();
        };

        this.dom.reset.onclick = () => {
            void this.reset();
        };

        this.dom.fbxInput.onchange = () => {
            void this.importFBXFiles();
        };

        this.dom.glbInput.onchange = () => {
            void this.importGLBFile();
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
            this.refresh();
        };

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        window.addEventListener("pagehide", () => {
            this.dispose();
        }, { once: true });

        this.refresh();

        if (this.session.error) {
            this.showStatus(this.session.error, "error");
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

        this.dom.load.disabled = this.busy;
        this.dom.open.disabled = this.busy;
        this.dom.reset.disabled = this.busy;
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

    async runOperation(operation) {
        if (this.busy) {
            return;
        }

        this.busy = true;
        this.refresh();

        try {
            await operation();
        } catch (error) {
            console.error(error);

            this.showStatus(
                error.message || "An unexpected error occurred.",
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    async importFBXFiles() {
        const files = [...this.dom.fbxInput.files];

        this.dom.fbxInput.value = "";

        if (!files.length) {
            return;
        }

        await this.runOperation(async () => {
            this.showStatus("Importing FBX files...");

            let avatarCount = 0;
            let animationCount = 0;

            for (const file of files) {
                const result = await this.session.importFBX(file);

                if (result.avatar) {
                    avatarCount++;
                }

                if (result.animation) {
                    animationCount++;
                }
            }

            this.showStatus(
                `Imported ${avatarCount} avatar(s) and ${animationCount} animation(s).`,
                "success"
            );
        });
    }

    async importGLBFile() {
        const file = this.dom.glbInput.files?.[0];

        this.dom.glbInput.value = "";

        if (!file) {
            return;
        }

        await this.runOperation(async () => {
            this.showStatus("Opening GLB...");

            await this.session.importGLB(file);

            await this.app.assets.rebuildPromise;

            this.app.viewport?.restoreCamera();

            const errors = [
                ...this.app.assets.errors.values()
            ];

            if (errors.length) {
                throw new Error(
                    `Avatar loaded, but ${errors.length} asset(s) could not be restored: ${errors.join("; ")}`
                );
            }

            this.showStatus(
                `Loaded ${file.name}: avatar, assets, anchors, IK, camera and hand poses.`,
                "success"
            );
        });
    }

    async reset() {
        await this.runOperation(async () => {
            this.showStatus("Restoring default avatar...");

            await this.session.reset();

            this.app.viewport?.restoreCamera();

            this.showStatus(
                "Default avatar and animations restored.",
                "success"
            );
        });
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.app.detachViewport();
    }
}

new LoaderView();