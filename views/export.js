export default class ExportView {
    constructor() {
        this.app = window.parent.avatarApp;

        if (!this.app) {
            throw new Error(
                "Avatar Creator must be opened through index.html."
            );
        }

        this.session = this.app.session;
        this.assets = this.app.assets;
        this.exporter = this.app.exporter;

        this.dom = {
            inventory: document.getElementById("export-inventory"),
            export: document.getElementById("export-glb"),
            status: document.getElementById("status")
        };

        this.busy = false;

        this.dom.export.onclick = () => {
            void this.exportGLB();
        };

        this.onChange = () => this.refresh();

        window.addEventListener("pagehide", () => {
            this.dispose();
        }, { once: true });
    }

    async initialize() {
        await this.app.ready;
        await this.assets.rebuildPromise;

        this.session.addEventListener(
            "change",
            this.onChange
        );

        this.assets.addEventListener(
            "change",
            this.onChange
        );

        this.refresh();
    }

    refresh() {
        const inventory = this.exporter.getInventory();
        const fragment = document.createDocumentFragment();

        for (const category of inventory) {
            const section = document.createElement("section");
            section.className = "export-section";

            const heading = document.createElement("div");
            heading.className = "export-section-heading";

            const title = document.createElement("h2");
            title.textContent = category.label;

            const count = document.createElement("span");
            count.className = "export-count";
            count.textContent = category.items.length;

            heading.append(title, count);

            if (category.required) {
                const required = document.createElement("span");
                required.className = "export-required";
                required.textContent = "Required";

                heading.append(required);
            }

            section.append(heading);

            if (category.items.length === 0) {
                const empty = document.createElement("p");
                empty.className = "export-empty";
                empty.textContent = "No items";

                section.append(empty);
            } else {
                const list = document.createElement("ul");
                list.className = "export-items";

                for (const name of category.items) {
                    const item = document.createElement("li");
                    item.className = "export-item";
                    item.textContent = name;
                    item.title = name;

                    list.append(item);
                }

                section.append(list);
            }

            fragment.append(section);
        }

        this.dom.inventory.replaceChildren(fragment);

        this.dom.export.disabled =
            this.busy ||
            !this.session.avatar ||
            !this.session.getBone("root");
    }

    async exportGLB() {
        if (this.busy) {
            return;
        }

        this.busy = true;
        this.refresh();

        try {
            this.showStatus("Building GLB...");

            const blob = await this.exporter.export();

            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");

            link.href = url;
            link.download = "avatar-export.glb";

            document.body.append(link);
            link.click();
            link.remove();

            setTimeout(() => {
                URL.revokeObjectURL(url);
            }, 1000);

            this.showStatus(
                "Avatar exported successfully.",
                "success"
            );
        } catch (error) {
            console.error(error);

            this.showStatus(
                error.message ?? "GLB export failed.",
                "error"
            );
        } finally {
            this.busy = false;
            this.refresh();
        }
    }

    showStatus(message, kind = "info") {
        this.dom.status.textContent = message;
        this.dom.status.dataset.kind = kind;
        this.dom.status.hidden = false;
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onChange
        );

        this.assets.removeEventListener(
            "change",
            this.onChange
        );
    }
}

new ExportView().initialize().catch(console.error);