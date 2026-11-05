import * as THREE from "three";
import AvatarSession from "../core/AvatarSession.js";
import AvatarViewport from "../core/AvatarViewport.js";
import ViewCameraController from "../core/ViewCameraController.js";
import FirstPersonViewport from "../core/FirstPersonViewport.js";
import AssetController from "../core/AssetController.js";
import AnchorController from "../core/AnchorController.js";
import HandPoseController from "../core/HandPoseController.js";
import AvatarGLBExporter from "../core/AvatarGLBExporter.js";

class AvatarCreator {
    constructor() {
        this.THREE = THREE;

        this.dom = {
            frame: document.getElementById("view-frame"),
            navigation: document.getElementById("navigation"),
            loader: document.getElementById("nav-loader"),
            ik: document.getElementById("nav-ik"),
            view: document.getElementById("nav-view"),
            assets: document.getElementById("nav-assets"),
            anchors: document.getElementById("nav-anchors"),
            hands: document.getElementById("nav-hands"),
            export: document.getElementById("nav-export")
        };

        this.routes = {
            loader: "./loader.html",
            ik: "./ik.html",
            view: "./view.html",
            assets: "./assets.html",
            anchors: "./anchors.html",
            hands: "./hands.html",
            export: "./export.html"
        };

        this.session = new AvatarSession();

        this.viewCamera = new ViewCameraController(
            this.session
        );

        this.assets = new AssetController(
            this.session
        );

        this.anchors = new AnchorController(
            this.session,
            this.assets
        );

        this.hands = new HandPoseController(this.session);
        
        this.exporter = new AvatarGLBExporter(this);

        this.viewport = null;
        this.secondaryViewport = null;

        this.currentPage = null;

        this.running = false;
        this.previousTimestamp = null;

        for (const page of Object.keys(this.routes)) {
            this.dom[page].onclick = () => {
                this.navigate(page);
            };
        }

        window.addEventListener("pagehide", () => {
            this.stop();
            this.detachViewport();
        });

        this.ready = this.initialize();
    }

    async initialize() {
        try {
            await this.session.initialize();
        } catch (error) {
            this.session.error = error.message;
            console.error(error);
        }

        const requestedPage = new URLSearchParams(
            window.location.search
        ).get("page");

        this.navigate(
            Object.hasOwn(this.routes, requestedPage)
                ? requestedPage
                : "loader"
        );

        this.running = true;

        requestAnimationFrame(timestamp => {
            this.animate(timestamp);
        });

        return this;
    }

    navigate(page) {
        if (!Object.hasOwn(this.routes, page)) {
            throw new Error(`Unknown view: ${page}`);
        }

        const url = new URL(window.location.href);

        url.searchParams.set("page", page);

        window.history.replaceState(
            window.history.state,
            "",
            url
        );

        if (this.currentPage === page) {
            return;
        }

        if (page !== "view") {
            this.viewCamera.setVisible(false);
        }

        if (page !== "ik") {
            this.session.ik?.setVisible(false);
        }

        if (page !== "anchors") {
            this.anchors.setVisible(false);
        }

        if (page !== "hands") {
            this.hands.setVisible(false);
        }

        this.detachViewport();

        this.currentPage = page;

        for (const name of Object.keys(this.routes)) {
            const active = name === page;

            this.dom[name].classList.toggle(
                "is-active",
                active
            );

            if (active) {
                this.dom[name].setAttribute(
                    "aria-current",
                    "page"
                );
            } else {
                this.dom[name].removeAttribute(
                    "aria-current"
                );
            }
        }

        this.dom.frame.src = this.routes[page];
    }

    attachViewport(canvas, viewportSession = this.session) {
        this.detachViewport();

        this.viewport = new AvatarViewport(
            viewportSession,
            canvas
        );

        return this.viewport;
    }

    attachFirstPersonViewports(avatarCanvas, cameraCanvas) {
        this.detachViewport();

        const editor = new AvatarViewport(
            this.session,
            avatarCanvas
        );

        try {
            const firstPerson = new FirstPersonViewport(
                this.session,
                cameraCanvas,
                this.viewCamera
            );

            this.viewport = editor;
            this.secondaryViewport = firstPerson;

            return {
                editor,
                firstPerson
            };
        } catch (error) {
            editor.dispose();
            throw error;
        }
    }

    detachViewport() {
        if (this.secondaryViewport) {
            this.secondaryViewport.dispose();
            this.secondaryViewport = null;
        }

        if (this.viewport) {
            this.viewport.dispose();
            this.viewport = null;
        }
    }

    animate(timestamp) {
        if (!this.running) {
            return;
        }

        requestAnimationFrame(nextTimestamp => {
            this.animate(nextTimestamp);
        });

        let delta = 0;

        if (this.previousTimestamp !== null) {
            delta = Math.min(
                Math.max(
                    (timestamp - this.previousTimestamp) / 1000,
                    0
                ),
                0.05
            );
        }

        this.previousTimestamp = timestamp;

        this.secondaryViewport?.update();

        // Restore the original skeleton rotations before animation.
        this.hands.beforeAnimation();

        // Evaluate the avatar animation.
        this.session.update(delta);

        // Apply hand pose rotations over the animated skeleton.
        this.hands.afterAnimation();

        // Update anchor visuals after the final skeleton pose.
        this.anchors.update();

        this.viewport?.render();
        this.secondaryViewport?.render();
    }

    stop() {
        this.running = false;
        this.previousTimestamp = null;
    }
}

window.avatarApp = new AvatarCreator();