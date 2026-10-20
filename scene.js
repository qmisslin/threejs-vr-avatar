
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Avatar } from './avatar.js';
import { Player } from './player.js';

export class Scene {
    constructor({
        avatarUrl = './avatar.fbx',
        animationUrls = {
            walk: './walk.fbx',
            idle: './idle.fbx'
        },
        characterHeight = 1.8,
        capsuleHeight = 1.8,
        capsuleRadius = 0.3,
        capsuleYaw = 0,
        minCrouch = 0,
        maxCrouch = 0.5
    } = {}) {
        this.avatarUrl = avatarUrl;
        this.animationUrls = animationUrls;
        this.viewport = document.getElementById('viewport');
        this.controlsContainer = document.getElementById('controls');

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x202020);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        this.camera.position.set(2.8, 1.8, 3.5);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.viewport.appendChild(this.renderer.domElement);

        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 2));
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(3, 6, 4);
        this.scene.add(light);

        this.grid = new THREE.GridHelper(20, 20, 0x777777, 0x444444);
        this.grid.position.y = -0.004;
        this.scene.add(this.grid);

        this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
        this.orbit.target.set(0, 0.95, 0);
        this.orbit.enableDamping = true;
        this.orbit.update();

        this.avatar = new Avatar({
            height: characterHeight,
            minCrouch,
            maxCrouch
        });

        this.player = new Player({
            avatar: this.avatar,
            height: capsuleHeight,
            radius: capsuleRadius,
            yaw: capsuleYaw
        });
        this.scene.add(this.player);

        this.ui = {};
        this.timer = new THREE.Timer();
        this.timer.connect(document);

        window.addEventListener('resize', () => this.resize());
        this.resize();
    }

    // Scene owns FBX loading; Avatar receives loaded objects.
    async start() {
        this.renderer.setAnimationLoop(() => this.animate());

        const loader = new FBXLoader();
        const entries = Object.entries(this.animationUrls);
        const [model, ...sources] = await Promise.all([
            loader.loadAsync(this.avatarUrl),
            ...entries.map(([, url]) => loader.loadAsync(url))
        ]);

        const animations = Object.fromEntries(
            entries.map(([name], i) => [name, sources[i]])
        );

        this.player.origin.scale.setScalar(1);
        this.player.origin.updateWorldMatrix(true, true);
        this.avatar.initialize(this.player.origin, model, animations);
        this.player.applyDimensions();
        this.player.setHeadOverride(true);
        this.player.setEyesRotation({ x: 0, y: 0, z: 0 });

        this.buildControls();
        this.resize();
    }

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

        const span = document.createElement('span');
        span.textContent = label;
        input.addEventListener('change', () => onChange(input.checked));

        wrapper.append(input, span);
        section.appendChild(wrapper);
        return input;
    }

    createVectorInput({
        section,
        label,
        values,
        axes = ['x', 'y', 'z'],
        step = 0.01,
        min,
        max,
        axisSettings = {},
        onChange
    }) {
        const group = document.createElement('div');
        group.className = 'field-group';

        const title = document.createElement('span');
        title.className = 'field-title';
        title.textContent = label;

        const row = document.createElement('div');
        row.className = axes.length === 1
            ? 'vector-inputs single'
            : 'vector-inputs';

        const inputs = {};

        for (const axis of axes) {
            const settings = axisSettings[axis] || {};
            const axisStep = settings.step ?? step;
            const axisMin = settings.min ?? min;
            const axisMax = settings.max ?? max;

            const field = document.createElement('label');
            field.className = 'axis-field';

            const caption = document.createElement('span');
            caption.className = 'axis-label';
            caption.textContent = axis;

            const input = document.createElement('input');
            input.type = 'number';
            input.step = String(axisStep);
            input.value = this.formatNumber(values[axis]);
            if (axisMin !== undefined) input.min = String(axisMin);
            if (axisMax !== undefined) input.max = String(axisMax);
            inputs[axis] = input;

            const apply = (value, normalizeInput) => {
                if (!Number.isFinite(value)) return;
                const result = onChange(axis, value);
                const actual = Number.isFinite(result) ? result : value;
                values[axis] = actual;
                if (normalizeInput) input.value = this.formatNumber(actual);
            };

            input.addEventListener('input', () => {
                if (input.value !== '' && Number.isFinite(input.valueAsNumber)) {
                    apply(input.valueAsNumber, false);
                }
            });

            input.addEventListener('change', () => {
                if (input.value === '' || !Number.isFinite(input.valueAsNumber)) {
                    input.value = this.formatNumber(values[axis]);
                } else {
                    apply(input.valueAsNumber, true);
                }
            });

            // Wheel changes only the hovered input, not the sidebar scroll.
            input.addEventListener('wheel', event => {
                event.preventDefault();
                event.stopPropagation();
                if (!event.deltaY) return;

                const direction = event.deltaY < 0 ? 1 : -1;
                const next = Number(
                    (values[axis] + direction * axisStep).toFixed(6)
                );
                apply(next, true);
            }, { passive: false });

            field.append(caption, input);
            row.appendChild(field);
        }

        group.append(title, row);
        section.appendChild(group);

        return {
            inputs,
            sync: (updated, { preserveActive = false } = {}) => {
                for (const axis of axes) {
                    values[axis] = updated[axis];
                    if (!preserveActive || document.activeElement !== inputs[axis]) {
                        inputs[axis].value = this.formatNumber(updated[axis]);
                    }
                }
            },
            setLimits: (lower, upper) => {
                for (const input of Object.values(inputs)) {
                    if (lower !== undefined) input.min = String(lower);
                    if (upper !== undefined) input.max = String(upper);
                }
            }
        };
    }

    formatNumber(value) {
        return String(Number(value.toFixed(4)));
    }

    createAnimationControls(section, state) {
        const group = document.createElement('div');
        group.className = 'field-group';

        const title = document.createElement('span');
        title.className = 'field-title';
        title.textContent = 'Animation';

        const row = document.createElement('div');
        row.className = 'animation-row';
        const select = document.createElement('select');
        select.className = 'animation-select';

        for (const name of state.available) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name[0].toUpperCase() + name.slice(1);
            select.appendChild(option);
        }

        select.value = state.current;
        select.addEventListener('change', () => {
            this.avatar.setAnimation(select.value);
        });

        const button = document.createElement('button');
        button.className = 'animation-button';
        button.type = 'button';

        const refresh = () => {
            button.textContent = this.avatar.isPlaying() ? 'Pause' : 'Play';
        };

        button.addEventListener('click', () => {
            this.avatar.setPlaying(!this.avatar.isPlaying());
            refresh();
        });

        refresh();
        row.append(select, button);
        group.append(title, row);
        section.appendChild(group);
    }

    syncCapsuleDependentFields() {
        const state = this.player.getControlState();

        // All three capsule parameters live in the same input group.
        this.ui.capsuleParameters.sync(state.capsule, { preserveActive: true });
        this.ui.capsuleParameters.inputs.radius.min = '0.05';
        this.ui.capsuleParameters.inputs.radius.max = String(
            state.capsule.height / 2
        );

        this.ui.eyesPosition.sync(state.eyes.position);
        this.ui.eyesPosition.inputs.y.min = String(state.eyes.yLimits.min);
        this.ui.eyesPosition.inputs.y.max = String(state.eyes.yLimits.max);
    }

    buildControls() {
        this.controlsContainer.replaceChildren();
        const state = this.player.getControlState();

        const view = this.createSection('View');
        this.createCheckbox(
            view,
            'Display transform',
            state.view.displayTransforms,
            visible => this.avatar.setDisplayTransforms(visible)
        );
        this.createCheckbox(
            view,
            'Display skeleton',
            state.view.displaySkeleton,
            visible => this.avatar.setDisplaySkeleton(visible)
        );
        this.createCheckbox(
            view,
            'Display capsule',
            state.view.displayCapsule,
            visible => this.player.setDisplayCapsule(visible)
        );

        this.createAnimationControls(
            this.createSection('Animation'),
            state.animation
        );

        const capsule = this.createSection('Player capsule');

        // One title, one row, three fields: Height / Radius / Yaw.
        this.ui.capsuleParameters = this.createVectorInput({
            section: capsule,
            label: 'Capsule parameters',
            values: state.capsule,
            axes: ['height', 'radius', 'yaw'],
            axisSettings: {
                height: { step: 0.01, min: 0.3 },
                radius: { step: 0.01, min: 0.05, max: state.capsule.height / 2 },
                yaw: { step: 1 }
            },
            onChange: (axis, value) => {
                if (axis === 'height') {
                    const actual = this.player.setCapsuleHeight(value);
                    this.syncCapsuleDependentFields();
                    return actual;
                }
                if (axis === 'radius') return this.player.setCapsuleRadius(value);
                if (axis === 'yaw') return this.player.setCapsuleYaw(value);
            }
        });

        const eyes = this.createSection('Avatar eyes');
        this.ui.eyesPosition = this.createVectorInput({
            section: eyes,
            label: 'Position (world)',
            values: state.eyes.position,
            onChange: (axis, value) =>
                this.player.setEyesPosition({ [axis]: value })[axis]
        });

        this.ui.eyesPosition.inputs.y.min = String(state.eyes.yLimits.min);
        this.ui.eyesPosition.inputs.y.max = String(state.eyes.yLimits.max);

        this.createVectorInput({
            section: eyes,
            label: 'Head rotation (degrees)',
            values: state.eyes.rotation,
            step: 1,
            onChange: (axis, value) =>
                this.player.setEyesRotation({ [axis]: value })[axis]
        });

        this.createCheckbox(
            eyes,
            'Override head animation (X / Y / Z)',
            state.eyes.headOverride,
            enabled => this.player.setHeadOverride(enabled)
        );

        for (const side of ['left', 'right']) {
            const hand = this.createSection(
                `${side === 'left' ? 'Left' : 'Right'} hand`
            );

            this.createCheckbox(
                hand,
                'Enable arm IK',
                state.ik[side],
                enabled => this.avatar.setArmIKEnabled(side, enabled)
            );

            this.createVectorInput({
                section: hand,
                label: 'Position (origin local)',
                values: state.hands[side].position,
                onChange: (axis, value) =>
                    this.avatar.setHandPosition(side, { [axis]: value })
            });

            this.createVectorInput({
                section: hand,
                label: 'Pole (origin local)',
                values: state.hands[side].pole,
                onChange: (axis, value) =>
                    this.avatar.setHandPolePosition(side, { [axis]: value })
            });

            this.createVectorInput({
                section: hand,
                label: 'Rotation (degrees)',
                values: state.hands[side].rotation,
                step: 1,
                onChange: (axis, value) =>
                    this.avatar.setHandRotation(side, { [axis]: value })
            });
        }

        for (const side of ['left', 'right']) {
            const leg = this.createSection(
                `${side === 'left' ? 'Left' : 'Right'} leg`
            );

            this.createVectorInput({
                section: leg,
                label: 'Pole (origin local)',
                values: state.legs[side].pole,
                onChange: (axis, value) =>
                    this.avatar.setLegPolePosition(side, { [axis]: value })
            });
        }
    }

    animate() {
        this.timer.update();
        const deltaTime = Math.min(this.timer.getDelta(), 0.05);
        if (this.avatar.mixer) this.avatar.update(deltaTime);
        this.orbit.update();
        this.renderer.render(this.scene, this.camera);
    }

    resize() {
        const width = this.viewport.clientWidth;
        const height = this.viewport.clientHeight;
        if (!width || !height) return;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }
}
