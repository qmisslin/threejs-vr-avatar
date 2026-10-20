
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Avatar } from './avatar.js';

export class Scene {
    constructor({
        avatarUrl = './avatar.fbx',
        animationUrls = {
            walk: './walk.fbx',
            idle: './idle.fbx'
        },
        characterHeight = 1.8,
        minCrouch = 0.0,
        maxCrouch = 0.5
    } = {}) {
        this.avatarUrl = avatarUrl;
        this.animationUrls = animationUrls;

        this.viewport = document.getElementById('viewport');
        this.controlsContainer = document.getElementById('controls');

        // Scene.

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x202020);

        // Camera.

        this.camera = new THREE.PerspectiveCamera(
            45,
            this.viewport.clientWidth / this.viewport.clientHeight,
            0.01,
            100
        );

        this.camera.position.set(2.8, 1.8, 3.5);

        // Renderer.

        this.renderer = new THREE.WebGLRenderer({
            antialias: true
        });

        this.renderer.setPixelRatio(
            Math.min(window.devicePixelRatio, 2)
        );

        this.renderer.setSize(
            this.viewport.clientWidth,
            this.viewport.clientHeight
        );

        this.viewport.appendChild(this.renderer.domElement);

        // Lighting.

        this.scene.add(
            new THREE.HemisphereLight(0xffffff, 0x555555, 2)
        );

        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(3, 6, 4);
        this.scene.add(light);

        // Orbit controls.

        this.orbit = new OrbitControls(
            this.camera,
            this.renderer.domElement
        );

        this.orbit.target.set(0, 0.95, 0);
        this.orbit.enableDamping = true;
        this.orbit.update();

        // Avatar.

        this.avatar = new Avatar({
            height: characterHeight,
            minCrouch,
            maxCrouch
        });

        // Timer.

        this.timer = new THREE.Timer();
        this.timer.connect(document);

        window.addEventListener('resize', () => this.resize());
    }

    // --------------------------------------------------
    // Loading
    // --------------------------------------------------

    async start() {
        this.renderer.setAnimationLoop(() => this.animate());

        const loader = new FBXLoader();
        const entries = Object.entries(this.animationUrls);

        const [model, ...animationModels] = await Promise.all([
            loader.loadAsync(this.avatarUrl),
            ...entries.map(([, url]) => loader.loadAsync(url))
        ]);

        const animations = Object.fromEntries(
            entries.map(([name], index) => [
                name,
                animationModels[index]
            ])
        );

        this.avatar.initialize(
            this.scene,
            model,
            animations
        );

        this.buildControls();
        this.resize();
    }

    // --------------------------------------------------
    // UI utilities
    // --------------------------------------------------

    createSection(title) {
        const section = document.createElement('section');

        const heading = document.createElement('h2');
        heading.textContent = title;

        section.appendChild(heading);
        this.controlsContainer.appendChild(section);

        return section;
    }

    createCheckbox(section, label, checked, onChange) {
        const wrapper = document.createElement('label');
        wrapper.className = 'checkbox-field';

        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;

        const text = document.createElement('span');
        text.textContent = label;

        input.addEventListener('change', () => {
            onChange(input.checked);
        });

        wrapper.append(input, text);
        section.appendChild(wrapper);

        return input;
    }

    // --------------------------------------------------
    // Animation controls
    // --------------------------------------------------

    createAnimationControls(section, state) {
        const group = document.createElement('div');
        group.className = 'field-group';

        const title = document.createElement('span');
        title.className = 'field-title';
        title.textContent = 'Animation';

        group.appendChild(title);

        const row = document.createElement('div');
        row.className = 'animation-row';

        const select = document.createElement('select');
        select.className = 'animation-select';

        for (const name of state.available) {
            const option = document.createElement('option');

            option.value = name;
            option.textContent =
                name[0].toUpperCase() + name.slice(1);

            select.appendChild(option);
        }

        select.value = state.current;

        select.addEventListener('change', () => {
            this.avatar.setAnimation(select.value);
        });

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'animation-button';

        const refreshButton = () => {
            button.textContent = this.avatar.isPlaying()
                ? 'Pause'
                : 'Play';
        };

        button.addEventListener('click', () => {
            this.avatar.setPlaying(!this.avatar.isPlaying());
            refreshButton();
        });

        refreshButton();

        row.append(select, button);
        group.appendChild(row);
        section.appendChild(group);
    }

    // --------------------------------------------------
    // Numeric inputs
    // --------------------------------------------------

    createVectorInput({
        section,
        label,
        values,
        axes = ['x', 'y', 'z'],
        step = 0.01,
        onChange,
        min,
        max
    }) {
        const group = document.createElement('div');
        group.className = 'field-group';

        const title = document.createElement('span');
        title.className = 'field-title';
        title.textContent = label;

        group.appendChild(title);

        const row = document.createElement('div');
        row.className = axes.length === 1
            ? 'vector-inputs single'
            : 'vector-inputs';

        for (const axis of axes) {
            const field = document.createElement('label');
            field.className = 'axis-field';

            const axisLabel = document.createElement('span');
            axisLabel.className = 'axis-label';
            axisLabel.textContent = axis;

            const input = document.createElement('input');
            input.type = 'number';
            input.step = String(step);
            input.value = this.formatNumber(values[axis]);

            if (min !== undefined) {
                input.min = String(min);
            }

            if (max !== undefined) {
                input.max = String(max);
            }

            const applyValue = (value) => {
                if (!Number.isFinite(value)) return;

                const result = onChange(axis, value);

                const actual = Number.isFinite(result)
                    ? result
                    : value;

                values[axis] = actual;
                input.value = this.formatNumber(actual);
            };

            input.addEventListener('input', () => {
                if (input.value === '') return;

                const value = input.valueAsNumber;
                if (!Number.isFinite(value)) return;

                const result = onChange(axis, value);

                values[axis] = Number.isFinite(result)
                    ? result
                    : value;
            });

            input.addEventListener('change', () => {
                if (
                    input.value === '' ||
                    !Number.isFinite(input.valueAsNumber)
                ) {
                    input.value = this.formatNumber(values[axis]);
                } else {
                    applyValue(input.valueAsNumber);
                }
            });

            // Mouse wheel changes the hovered numeric input.
            // Sidebar scrolling is blocked only over that input.

            input.addEventListener('wheel', (event) => {
                event.preventDefault();
                event.stopPropagation();

                if (event.deltaY === 0) return;

                const direction = event.deltaY < 0 ? 1 : -1;

                const next = Number(
                    (values[axis] + direction * step).toFixed(6)
                );

                applyValue(next);
            }, { passive: false });

            field.append(axisLabel, input);
            row.appendChild(field);
        }

        group.appendChild(row);
        section.appendChild(group);
    }

    formatNumber(value) {
        return String(Number(value.toFixed(4)));
    }

    // --------------------------------------------------
    // Sidebar
    // --------------------------------------------------

    buildControls() {
        this.controlsContainer.replaceChildren();

        const state = this.avatar.getControlState();

        // View.

        const view = this.createSection('View');

        this.createCheckbox(
            view,
            'Display transform',
            state.view.displayTransforms,
            (visible) => this.avatar.setDisplayTransforms(visible)
        );

        this.createCheckbox(
            view,
            'Display skeleton',
            state.view.displaySkeleton,
            (visible) => this.avatar.setDisplaySkeleton(visible)
        );

        // Animation.

        const animation = this.createSection('Animation');

        this.createAnimationControls(
            animation,
            state.animation
        );

        // Avatar.

        const avatar = this.createSection('Avatar');

        this.createVectorInput({
            section: avatar,
            label: 'Position',
            values: state.avatar.position,
            axes: ['y'],
            min: state.avatar.positionLimits.min,
            max: state.avatar.positionLimits.max,
            onChange: (_, value) => this.avatar.setPositionY(value)
        });

        // Hands, each with independent IK control.

        for (const side of ['left', 'right']) {
            const name = side === 'left' ? 'Left' : 'Right';

            const hand = this.createSection(`${name} hand`);

            this.createCheckbox(
                hand,
                'Enable arm IK',
                state.ik[side],
                (enabled) => this.avatar.setArmIKEnabled(side, enabled)
            );

            this.createVectorInput({
                section: hand,
                label: 'Position',
                values: state.hands[side].position,
                onChange: (axis, value) => {
                    this.avatar.setHandPosition(side, {
                        [axis]: value
                    });
                }
            });

            this.createVectorInput({
                section: hand,
                label: 'Pole',
                values: state.hands[side].pole,
                onChange: (axis, value) => {
                    this.avatar.setHandPolePosition(side, {
                        [axis]: value
                    });
                }
            });

            this.createVectorInput({
                section: hand,
                label: 'Rotation (degrees)',
                values: state.hands[side].rotation,
                step: 1,
                onChange: (axis, value) => {
                    this.avatar.setHandRotation(side, {
                        [axis]: value
                    });
                }
            });
        }

        // Legs.

        for (const side of ['left', 'right']) {
            const leg = this.createSection(
                `${side === 'left' ? 'Left' : 'Right'} leg`
            );

            this.createVectorInput({
                section: leg,
                label: 'Pole',
                values: state.legs[side].pole,
                onChange: (axis, value) => {
                    this.avatar.setLegPolePosition(side, {
                        [axis]: value
                    });
                }
            });
        }
    }

    // --------------------------------------------------
    // Rendering
    // --------------------------------------------------

    animate() {
        this.timer.update();

        const deltaTime = Math.min(
            this.timer.getDelta(),
            0.05
        );

        if (this.avatar.mixer) {
            this.avatar.update(deltaTime);
        }

        this.orbit.update();
        this.renderer.render(this.scene, this.camera);
    }

    resize() {
        const width = this.viewport.clientWidth;
        const height = this.viewport.clientHeight;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height);
    }
}
