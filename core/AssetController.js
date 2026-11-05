import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const EPSILON = 1e-8;
const DEFAULT_ASSET_SIZE = 0.5;
const MIN_SCALE = 0.005;

const DEFAULT_CAMERA = {
    position: [1.2, 1.0, 1.5],
    target: [0, 0, 0]
};

function validVector(values, length) {
    return Array.isArray(values) &&
        values.length === length &&
        values.every(Number.isFinite);
}

function normalizeRecord(record) {
    const oldTransform = record.transform;

    return {
        id: record.id,
        fileId: record.fileId,
        type: record.type ?? "fbx",
        name: record.name ?? "Asset",
        origin: {
            position: validVector(record.origin?.position, 3)
                ? [...record.origin.position]
                : [0, 0, 0]
        },
        model: {
            position: validVector(record.model?.position, 3)
                ? [...record.model.position]
                : validVector(oldTransform?.position, 3)
                    ? [...oldTransform.position]
                    : [0, 0, 0],
            quaternion: validVector(record.model?.quaternion, 4)
                ? [...record.model.quaternion]
                : validVector(oldTransform?.quaternion, 4)
                    ? [...oldTransform.quaternion]
                    : [0, 0, 0, 1],
            scale: validVector(record.model?.scale, 3)
                ? [...record.model.scale]
                : validVector(oldTransform?.scale, 3)
                    ? [...oldTransform.scale]
                    : [
                        DEFAULT_ASSET_SIZE,
                        DEFAULT_ASSET_SIZE,
                        DEFAULT_ASSET_SIZE
                    ]
        }
    };
}

function disposeModel(object) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();

    object.traverse(child => {
        if (child.geometry) {
            geometries.add(child.geometry);
        }

        const assigned = Array.isArray(child.material)
            ? child.material
            : child.material ? [child.material] : [];

        for (const material of assigned) {
            materials.add(material);

            for (const value of Object.values(material)) {
                if (value?.isTexture) {
                    textures.add(value);
                }
            }
        }
    });

    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
}

function createDimensionLabel(axis) {
    if (typeof OffscreenCanvas !== "function") {
        return null;
    }

    const canvas = new OffscreenCanvas(320, 80);
    const context = canvas.getContext("2d");

    if (!context) {
        return null;
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
            sizeAttenuation: false
        })
    );

    sprite.name = `AssetDimension${axis}`;
    sprite.renderOrder = 200;
    sprite.scale.set(0.12, 0.03, 1);

    return { axis, canvas, context, texture, sprite };
}

function updateDimensionLabel(label, length) {
    const { context, canvas, texture, axis } = label;

    context.clearRect(0, 0, canvas.width, canvas.height);

    context.fillStyle = "rgba(17,24,35,0.88)";
    context.fillRect(0, 8, canvas.width, 64);

    context.strokeStyle = "#f7ca65";
    context.lineWidth = 3;
    context.strokeRect(2, 10, canvas.width - 4, 60);

    context.font = "bold 31px Arial";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#ffffff";

    context.fillText(
        `${axis}: ${length.toFixed(3)} m`,
        canvas.width / 2,
        canvas.height / 2
    );

    texture.needsUpdate = true;
}

export default class AssetController extends EventTarget {
    constructor(session) {
        super();

        this.session = session;

        this.scene = new THREE.Scene();
        this.scene.name = "AssetPreviewScene";
        this.scene.background = session.scene.background?.clone() ?? null;

        for (const object of session.scene.children) {
            if (
                object.isLight ||
                object.isGridHelper ||
                object.name === "GroundGrid" ||
                object.name === "GroundAxes"
            ) {
                this.scene.add(object.clone());
            }
        }

        const savedCamera = session.metadata.assetPreviewCamera;

        this.cameraState = (
            validVector(savedCamera?.position, 3) &&
            validVector(savedCamera?.target, 3)
        )
            ? structuredClone(savedCamera)
            : structuredClone(DEFAULT_CAMERA);

        this.viewportSession = {
            scene: this.scene,
            cameraState: this.cameraState,
            setCameraState: async (position, target) => {
                this.cameraState = {
                    position: position.toArray(),
                    target: target.toArray()
                };

                this.viewportSession.cameraState = this.cameraState;

                await this.session.setMetadata({
                    ...this.session.metadata,
                    assetPreviewCamera: this.cameraState
                });
            }
        };

        this.instances = new Map();
        this.errors = new Map();

        this.selectedId = null;
        this.avatar = null;
        this.revision = 0;
        this.rebuildPromise = Promise.resolve();

        this.selectionBounds = new THREE.Box3();

        this.selectionBox = new THREE.Box3Helper(
            this.selectionBounds,
            0xf7ca65
        );

        this.selectionBox.name = "AssetBoundingBox";
        this.selectionBox.material.depthTest = false;
        this.selectionBox.material.depthWrite = false;
        this.selectionBox.renderOrder = 100;
        this.selectionBox.visible = false;

        this.scene.add(this.selectionBox);

        this.labels = ["X", "Y", "Z"]
            .map(createDimensionLabel)
            .filter(Boolean);

        for (const label of this.labels) {
            label.sprite.visible = false;
            this.scene.add(label.sprite);
        }

        this.onSessionChange = () => {
            if (this.session.avatar !== this.avatar) {
                this.rebuildPromise = this.rebuild();
            }
        };

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        if (this.session.avatar) {
            this.rebuildPromise = this.rebuild();
        }
    }

    get records() {
        return Array.isArray(this.session.metadata.assets)
            ? this.session.metadata.assets
            : [];
    }

    getInstance(id) {
        return this.instances.get(id) ?? null;
    }

    get selectedInstance() {
        return this.getInstance(this.selectedId);
    }

    async parseFile(file, type, assetId = null) {
        const buffer = new Uint8Array(
            await file.arrayBuffer()
        ).slice().buffer;

        let object;

        if (type === "fbx") {
            object = new FBXLoader().parse(buffer, "");
        } else if (type === "glb") {
            const gltf = await new GLTFLoader().parseAsync(
                buffer,
                ""
            );

            let container = null;

            if (assetId) {
                for (const scene of gltf.scenes) {
                    scene.traverse(child => {
                        if (
                            child.userData?.avatarAssetId === assetId
                        ) {
                            container = child;
                        }
                    });

                    if (container) {
                        break;
                    }
                }
            }

            if (container) {
                let source = null;

                container.traverse(child => {
                    if (
                        child !== container &&
                        child.userData?.avatarAssetSource === true
                    ) {
                        source = child;
                    }
                });

                if (!source) {
                    source = container.children[0] ?? null;
                }

                if (!source) {
                    throw new Error(
                        `Empty asset in GLB: ${assetId}`
                    );
                }

                source.parent?.remove(source);
                object = source;
            } else {
                // Legacy standalone GLB assets remain supported.
                if (
                    gltf.scene.userData?.avatarCreator?.format ===
                    "avatar-creator"
                ) {
                    throw new Error(
                        `Asset not found in GLB: ${assetId}`
                    );
                }

                object = gltf.scene;
            }
        } else {
            throw new Error(
                `Unsupported asset format: ${type}`
            );
        }

        let hasMesh = false;

        object.traverse(child => {
            if (child.isMesh) {
                hasMesh = true;
            }
        });

        if (!hasMesh) {
            disposeModel(object);

            throw new Error(
                "The imported asset contains no mesh."
            );
        }

        return object;
    }

    createInstance(record, source) {
        source.updateWorldMatrix(true, true);

        const sourceBounds = new THREE.Box3().setFromObject(
            source,
            true
        );

        if (sourceBounds.isEmpty()) {
            disposeModel(source);
            throw new Error(`Cannot measure asset: ${record.name}`);
        }

        const size = sourceBounds.getSize(new THREE.Vector3());
        const center = sourceBounds.getCenter(new THREE.Vector3());

        const largest = Math.max(size.x, size.y, size.z);

        if (!Number.isFinite(largest) || largest < EPSILON) {
            disposeModel(source);
            throw new Error(`Invalid asset dimensions: ${record.name}`);
        }

        const factor = 1 / largest;

        const origin = new THREE.Group();
        origin.name = `AssetOrigin:${record.name}`;

        const model = new THREE.Group();
        model.name = `AssetTransform:${record.name}`;

        const normalization = new THREE.Group();
        normalization.name = "AssetNormalization";

        normalization.position
            .copy(center)
            .multiplyScalar(-factor);

        normalization.scale.setScalar(factor);

        this.scene.add(origin);
        origin.add(model);
        model.add(normalization);
        normalization.add(source);

        origin.position.fromArray(record.origin.position);

        model.position.fromArray(record.model.position);
        model.quaternion.fromArray(record.model.quaternion).normalize();
        model.scale.fromArray(record.model.scale);

        const originAxes = new THREE.AxesHelper(0.09);
        originAxes.name = "AssetOriginAxes";
        origin.add(originAxes);

        const scaleHandle = new THREE.Object3D();
        scaleHandle.name = `AssetScaleHandle:${record.name}`;
        scaleHandle.scale.copy(model.scale);

        this.scene.add(scaleHandle);

        const instance = {
            record,
            source,
            origin,
            model,
            normalization,
            scaleHandle,
            originAxes,
            lastOriginPosition: origin.position.clone()
        };

        this.instances.set(record.id, instance);

        this.positionScaleHandle(instance);
        this.refreshVisibility();

        return instance;
    }

    getBounds(id) {
        const instance = this.getInstance(id);

        if (!instance) {
            return null;
        }

        instance.model.updateWorldMatrix(true, true);

        return new THREE.Box3().setFromObject(
            instance.model,
            true
        );
    }

    positionScaleHandle(instance) {
        const box = this.getBounds(instance.record.id);

        if (!box || box.isEmpty()) {
            return;
        }

        box.getCenter(instance.scaleHandle.position);
        instance.scaleHandle.updateMatrixWorld(true);
    }

    onOriginChanged(id) {
        const instance = this.getInstance(id);

        if (!instance) {
            return;
        }

        // Moving the origin must not move the asset geometry.
        const delta = instance.origin.position
            .clone()
            .sub(instance.lastOriginPosition);

        instance.model.position.sub(delta);

        instance.lastOriginPosition.copy(
            instance.origin.position
        );

        instance.model.updateWorldMatrix(true, true);
        this.updateBounds();
    }

    onScaleChanged(id) {
        const instance = this.getInstance(id);

        if (!instance) {
            return;
        }

        const proxyScale = instance.scaleHandle.scale;

        const scale = Math.max(MIN_SCALE, proxyScale.x);
        const previousScale = instance.model.scale.x;

        const ratio = Math.abs(previousScale) > EPSILON
            ? scale / previousScale
            : 1;

        // Scale the model offset relative to the editable origin.
        instance.model.position.multiplyScalar(ratio);

        // Apply uniform scaling.
        instance.model.scale.setScalar(scale);
        proxyScale.setScalar(scale);

        instance.model.updateWorldMatrix(true, true);

        this.updateBounds();
    }

    refreshVisibility() {
        for (const [id, instance] of this.instances) {
            instance.origin.visible = id === this.selectedId;
            instance.scaleHandle.visible = id === this.selectedId;
        }

        if (!this.ground) {
            this.ground = new THREE.Group();
            this.ground.name = "AssetGround";

            this.scene.add(this.ground);

            for (const object of [...this.scene.children]) {
                if (
                    object.isGridHelper ||
                    object.name === "GroundGrid" ||
                    object.name === "GroundAxes"
                ) {
                    this.ground.add(object);
                }
            }
        }

        // Attach the ground to the selected asset origin.
        const parent = this.selectedInstance?.origin ?? this.scene;

        if (this.ground.parent !== parent) {
            parent.add(this.ground);
        }

        // Keep the ground aligned with the origin.
        this.ground.position.set(0, 0, 0);
        this.ground.quaternion.identity();
        this.ground.scale.set(1, 1, 1);
    }

    select(id) {
        this.selectedId = this.instances.has(id)
            ? id
            : null;

        this.refreshVisibility();
        this.updateBounds();

        this.dispatchEvent(new Event("change"));
    }

    updateBounds() {
        const box = this.getBounds(this.selectedId);

        if (!box || box.isEmpty()) {
            this.selectionBox.visible = false;

            for (const label of this.labels) {
                label.sprite.visible = false;
            }

            return;
        }

        this.selectionBounds.copy(box);
        this.selectionBox.visible = true;
        this.selectionBox.updateMatrixWorld(true);

        const size = box.getSize(new THREE.Vector3());
        const middle = box.getCenter(new THREE.Vector3());

        const positions = {
            X: new THREE.Vector3(
                middle.x,
                box.min.y - 0.075,
                box.max.z
            ),
            Y: new THREE.Vector3(
                box.max.x + 0.085,
                middle.y,
                box.max.z
            ),
            Z: new THREE.Vector3(
                box.max.x,
                box.min.y - 0.075,
                middle.z
            )
        };

        for (const label of this.labels) {
            label.sprite.visible = true;
            label.sprite.position.copy(positions[label.axis]);

            updateDimensionLabel(
                label,
                size[label.axis.toLowerCase()]
            );
        }
    }

    async rebuild() {
        const revision = ++this.revision;

        this.clearInstances();
        this.errors.clear();

        this.avatar = this.session.avatar;

        const records = this.records.map(normalizeRecord);

        for (const record of records) {
            try {
                const file = await this.session.getAttachment(
                    record.fileId
                );

                if (!file) {
                    throw new Error(`Missing asset file: ${record.name}`);
                }

                const source = await this.parseFile(
                    file,
                    record.type,
                    record.id
                );

                if (revision !== this.revision) {
                    disposeModel(source);
                    return;
                }

                this.createInstance(record, source);
            } catch (error) {
                if (revision !== this.revision) {
                    return;
                }

                this.errors.set(record.id, error.message);
                console.error(`Asset ${record.name}:`, error);
            }
        }

        if (!this.instances.has(this.selectedId)) {
            this.selectedId = this.instances.keys().next().value ?? null;
        }

        this.refreshVisibility();
        this.updateBounds();

        this.dispatchEvent(new Event("change"));
    }

    async saveRecords(records) {
        await this.session.setMetadata({
            ...this.session.metadata,
            assets: records
        });

        this.dispatchEvent(new Event("change"));
    }

    async importFile(file) {
        await this.rebuildPromise;

        if (!file.name.toLowerCase().endsWith(".fbx")) {
            throw new Error("Expected an FBX asset.");
        }

        const source = await this.parseFile(file, "fbx");
        const fileId = await this.session.saveAttachment(file);

        const record = {
            id: crypto.randomUUID(),
            fileId,
            type: "fbx",
            name: file.name.replace(/\.fbx$/i, ""),
            origin: {
                position: [0, 0, 0]
            },
            model: {
                position: [0, 0, 0],
                quaternion: [0, 0, 0, 1],
                scale: [
                    DEFAULT_ASSET_SIZE,
                    DEFAULT_ASSET_SIZE,
                    DEFAULT_ASSET_SIZE
                ]
            }
        };

        this.createInstance(record, source);

        await this.saveRecords([
            ...this.records.map(normalizeRecord),
            record
        ]);

        this.select(record.id);

        return record.id;
    }

    async saveTransform(id) {
        const instance = this.getInstance(id);

        if (!instance) {
            return;
        }

        const updated = this.records
            .map(normalizeRecord)
            .map(record => {
                if (record.id !== id) {
                    return record;
                }

                return {
                    ...record,
                    origin: {
                        position: instance.origin.position.toArray()
                    },
                    model: {
                        position: instance.model.position.toArray(),
                        quaternion: instance.model.quaternion.toArray(),
                        scale: instance.model.scale.toArray()
                    }
                };
            });

        await this.saveRecords(updated);
    }

    async rename(id, name) {
        const value = name.trim();

        if (!value) {
            throw new Error("Asset name cannot be empty.");
        }

        const instance = this.getInstance(id);

        if (!instance) {
            return;
        }

        instance.origin.name = `AssetOrigin:${value}`;
        instance.model.name = `AssetTransform:${value}`;

        await this.saveRecords(
            this.records.map(normalizeRecord).map(record => {
                return record.id === id
                    ? { ...record, name: value }
                    : record;
            })
        );
    }

    async remove(id) {
        const record = this.records.find(item => item.id === id);

        if (!record) {
            return;
        }

        this.disposeInstance(id);

        const remaining = this.records
            .filter(item => item.id !== id)
            .map(normalizeRecord);

        if (this.selectedId === id) {
            this.selectedId = remaining[0]?.id ?? null;
        }

        this.refreshVisibility();
        this.updateBounds();

        await this.saveRecords(remaining);

        if (!remaining.some(item => item.fileId === record.fileId)) {
            await this.session.deleteAttachment(record.fileId);
        }
    }

    async reset() {
        const ids = [...new Set(
            this.records.map(record => record.fileId)
        )];

        this.clearInstances();
        this.selectedId = null;
        this.updateBounds();

        await this.saveRecords([]);

        for (const id of ids) {
            await this.session.deleteAttachment(id);
        }
    }

    disposeInstance(id) {
        const instance = this.instances.get(id);

        if (!instance) {
            return;
        }

        // Detach the ground before removing its parent asset.
        if (this.ground?.parent === instance.origin) {
            this.scene.add(this.ground);
            this.ground.position.set(0, 0, 0);
        }

        instance.origin.parent?.remove(instance.origin);
        instance.scaleHandle.parent?.remove(instance.scaleHandle);

        disposeModel(instance.source);

        instance.originAxes.geometry.dispose();
        instance.originAxes.material.dispose();

        this.instances.delete(id);
    }

    clearInstances() {
        for (const id of [...this.instances.keys()]) {
            this.disposeInstance(id);
        }

        this.instances.clear();
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        ++this.revision;
        this.clearInstances();

        this.selectionBox.parent?.remove(this.selectionBox);
        this.selectionBox.geometry.dispose();
        this.selectionBox.material.dispose();

        for (const label of this.labels) {
            label.sprite.parent?.remove(label.sprite);
            label.texture.dispose();
            label.sprite.material.dispose();
        }
    }
}