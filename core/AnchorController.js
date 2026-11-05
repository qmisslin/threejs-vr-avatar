import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

const EPSILON = 1e-8;

function mirroredBoneName(name) {
    return name.replace(/left|right/i, match => {
        const opposite = match.toLowerCase() === "left"
            ? "Right"
            : "Left";

        if (match === match.toUpperCase()) {
            return opposite.toUpperCase();
        }

        if (match === match.toLowerCase()) {
            return opposite.toLowerCase();
        }

        return opposite;
    });
}

function nextCopyName(name, records) {
    const match = /^(.*?)(\d+)$/.exec(name);
    const prefix = match ? match[1] : `${name}-`;

    let number = match ? Number(match[2]) + 1 : 2;

    if (!Number.isSafeInteger(number)) {
        number = 2;
    }

    const names = new Set(records.map(record => record.name));

    while (names.has(`${prefix}${number}`)) {
        number++;
    }

    return `${prefix}${number}`;
}

function readVector(values, fallback) {
    return Array.isArray(values) &&
        values.length === fallback.length &&
        values.every(Number.isFinite)
        ? values
        : fallback;
}

export default class AnchorController extends EventTarget {
    constructor(session, assets) {
        super();

        this.session = session;
        this.assets = assets;

        this.avatar = null;
        this.root = null;

        this.instances = new Map();
        this.selectedId = null;
        this.visible = false;
        this.pendingMigration = false;

        this.previewAssetId = null;
        this.preview = null;
        this.previewWorldScale = new THREE.Vector3();

        this.highlight = new THREE.Mesh(
            new THREE.SphereGeometry(1, 16, 12),
            new THREE.MeshBasicMaterial({
                color: 0xffd166,
                depthTest: false,
                depthWrite: false,
                toneMapped: false
            })
        );

        this.highlight.name = "SelectedBoneHighlight";
        this.highlight.layers.set(1);
        this.highlight.renderOrder = 200;
        this.highlight.visible = false;

        this.onSessionChange = () => {
            if (this.avatar !== this.session.avatar) {
                this.rebuild();
                return;
            }

            for (const record of this.records) {
                const instance = this.instances.get(record.id);

                if (instance) {
                    instance.record = record;
                }
            }
        };

        this.onAssetsChange = () => {
            this.refreshAssetPreview();
        };

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        this.assets.addEventListener(
            "change",
            this.onAssetsChange
        );

        if (this.session.avatar) {
            this.rebuild();
        }
    }

    get records() {
        return Array.isArray(this.session.metadata.anchors)
            ? this.session.metadata.anchors
            : [];
    }

    get selectedRecord() {
        return this.records.find(record => {
            return record.id === this.selectedId;
        }) ?? null;
    }

    get selectedInstance() {
        return this.instances.get(this.selectedId) ?? null;
    }

    get selectedBone() {
        return this.selectedRecord?.bone ??
            this.getDefaultBoneName();
    }

    getBone(name) {
        if (name === "root") {
            return this.root;
        }

        // GLTFLoader can append numeric suffixes to duplicate joint names.
        const canonical = name?.replace(/_\d+$/, "");

        return this.session.getBone(canonical) ??
            (canonical !== name ? this.session.getBone(name) : null);
    }

    getDefaultBoneName() {
        return this.getBone("Hips") ? "Hips" : "root";
    }

    getBoneNames() {
        if (!this.root) {
            return [];
        }

        const excluded = /^(root|SourceRoot|CameraAnchor|HipsTarget|leftElbow|rightElbow|leftKnee|rightKnee)$/i;

        const names = [...new Set(
            [...this.session.bones.values()]
                .filter(bone => bone?.isBone)
                .map(bone => bone.name.replace(/_\d+$/, ""))
                .filter(name => name && !excluded.test(name))
        )];

        if (this.getBone("Hips") && !names.includes("Hips")) {
            names.push("Hips");
        }

        names.sort((a, b) => a.localeCompare(b));

        return ["root", ...names];
    }

    boneLocalToMeters(bone, localPosition) {
        bone.updateWorldMatrix(true, false);

        const origin = bone.getWorldPosition(
            new THREE.Vector3()
        );

        const rotation = bone.getWorldQuaternion(
            new THREE.Quaternion()
        );

        // Convert a bone-local position into a metric offset.
        // The offset remains aligned with the bone's orientation,
        // without inheriting the bone hierarchy's scale.
        return bone.localToWorld(localPosition.clone())
            .sub(origin)
            .applyQuaternion(rotation.invert());
    }

    metersToBoneLocal(bone, position) {
        bone.updateWorldMatrix(true, false);

        const origin = bone.getWorldPosition(
            new THREE.Vector3()
        );

        const rotation = bone.getWorldQuaternion(
            new THREE.Quaternion()
        );

        // Convert a metric offset back into the current bone's
        // local coordinate system, including its inherited scale.
        return bone.worldToLocal(
            origin.add(
                position.clone().applyQuaternion(rotation)
            )
        );
    }

    createInstance(record) {
        const parent = this.getBone(record.bone);

        if (!parent) {
            // Never apply an offset saved relative to a missing bone
            // directly to the avatar root.
            console.warn(
                `Anchor "${record.name}": unknown bone "${record.bone}".`
            );

            return null;
        }

        if (record.positionSpace !== "meters") {
            // Migrate legacy bone-local offsets to metric offsets.
            // This must be performed on the original avatar.
            const legacyPosition = new THREE.Vector3().fromArray(
                readVector(record.position, [0, 0, 0])
            );

            record.position = this.boneLocalToMeters(
                parent,
                legacyPosition
            ).toArray();

            record.positionSpace = "meters";
            this.pendingMigration = true;
        }

        const object = new THREE.Object3D();

        object.name = `Anchor:${record.name}`;
        object.userData.anchorId = record.id;
        object.userData.editorAnchor = true;

        parent.add(object);

        object.position.copy(
            this.metersToBoneLocal(
                parent,
                new THREE.Vector3().fromArray(
                    readVector(record.position, [0, 0, 0])
                )
            )
        );

        object.quaternion.fromArray(
            readVector(record.quaternion, [0, 0, 0, 1])
        ).normalize();

        object.scale.fromArray(
            readVector(record.scale, [1, 1, 1])
        );

        const instance = {
            record,
            object
        };

        this.instances.set(record.id, instance);

        return instance;
    }

    createAssetPreview(assetId) {
        const assetRecord = this.assets.records.find(record => {
            return record.id === assetId;
        });

        const assetInstance = this.assets.getInstance(assetId);

        if (!assetRecord || !assetInstance) {
            return null;
        }

        const source = SkeletonUtils.clone(
            assetInstance.source
        );

        source.updateWorldMatrix(true, true);

        const bounds = new THREE.Box3().setFromObject(
            source,
            true
        );

        if (bounds.isEmpty()) {
            return null;
        }

        const size = bounds.getSize(new THREE.Vector3());
        const largest = Math.max(size.x, size.y, size.z);

        if (!Number.isFinite(largest) || largest < EPSILON) {
            return null;
        }

        const center = bounds.getCenter(new THREE.Vector3());

        const modelState = assetRecord.model ??
            assetRecord.transform ?? {};

        const preview = new THREE.Group();
        preview.name = "AnchorAssetPreview";
        preview.userData.assetId = assetId;

        const model = new THREE.Group();
        model.name = `AttachedAsset:${assetRecord.name}`;

        model.position.fromArray(
            readVector(modelState.position, [0, 0, 0])
        );

        model.quaternion.fromArray(
            readVector(modelState.quaternion, [0, 0, 0, 1])
        ).normalize();

        model.scale.fromArray(
            readVector(modelState.scale, [0.5, 0.5, 0.5])
        );

        const normalization = new THREE.Group();
        normalization.name = "AssetNormalization";

        const factor = 1 / largest;

        normalization.position
            .copy(center)
            .multiplyScalar(-factor);

        normalization.scale.setScalar(factor);

        preview.add(model);
        model.add(normalization);
        normalization.add(source);

        return preview;
    }

    clearPreview() {
        if (!this.preview) {
            return;
        }

        this.preview.parent?.remove(this.preview);

        const skeletons = new Set();

        this.preview.traverse(object => {
            if (object.isSkinnedMesh && object.skeleton) {
                skeletons.add(object.skeleton);
            }
        });

        for (const skeleton of skeletons) {
            skeleton.dispose();
        }

        this.preview = null;
    }

    attachPreview() {
        if (!this.preview) {
            return;
        }

        const anchor = this.selectedInstance?.object;

        if (!anchor) {
            this.preview.parent?.remove(this.preview);
            this.preview.visible = false;
            return;
        }

        if (this.preview.parent !== anchor) {
            this.preview.parent?.remove(this.preview);
            anchor.add(this.preview);
        }

        this.preview.position.set(0, 0, 0);
        this.preview.quaternion.identity();

        this.updatePreviewScale();

        this.preview.visible = this.visible;
    }

    updatePreviewScale() {
        if (!this.preview?.parent) {
            return;
        }

        const anchor = this.preview.parent;

        anchor.updateWorldMatrix(true, false);
        anchor.getWorldScale(this.previewWorldScale);

        // Keep preview asset dimensions independent of the avatar scale.
        this.preview.scale.set(
            1 / Math.max(
                EPSILON,
                Math.abs(this.previewWorldScale.x)
            ),
            1 / Math.max(
                EPSILON,
                Math.abs(this.previewWorldScale.y)
            ),
            1 / Math.max(
                EPSILON,
                Math.abs(this.previewWorldScale.z)
            )
        );
    }

    setPreviewAsset(assetId) {
        const id = assetId || null;

        if (
            id &&
            !this.assets.records.some(record => record.id === id)
        ) {
            throw new Error("Unknown asset.");
        }

        if (id === this.previewAssetId && this.preview) {
            return;
        }

        const nextPreview = id
            ? this.createAssetPreview(id)
            : null;

        this.clearPreview();

        this.previewAssetId = id;
        this.preview = nextPreview;

        this.attachPreview();
        this.dispatchEvent(new Event("change"));
    }

    refreshAssetPreview() {
        const id = this.previewAssetId;

        if (!id) {
            this.dispatchEvent(new Event("change"));
            return;
        }

        if (!this.assets.records.some(record => record.id === id)) {
            this.setPreviewAsset(null);
            return;
        }

        const nextPreview = this.createAssetPreview(id);

        this.clearPreview();

        this.preview = nextPreview;
        this.attachPreview();

        this.dispatchEvent(new Event("change"));
    }

    disposeInstance(instance) {
        if (this.preview?.parent === instance.object) {
            this.preview.parent.remove(this.preview);
        }

        instance.object.parent?.remove(instance.object);
    }

    clearInstances() {
        for (const instance of this.instances.values()) {
            this.disposeInstance(instance);
        }

        this.instances.clear();
    }

    rebuild() {
        this.preview?.parent?.remove(this.preview);

        this.clearInstances();
        this.highlight.parent?.remove(this.highlight);

        this.avatar = this.session.avatar;
        this.root = this.session.getBone("root") ??
            this.avatar;

        if (!this.root) {
            this.selectedId = null;
            this.attachPreview();
            this.dispatchEvent(new Event("change"));
            return;
        }

        this.pendingMigration = false;

        for (const record of this.records) {
            this.createInstance(record);
        }

        const hasLegacyFields = this.records.some(record => {
            return Object.hasOwn(record, "assetId") ||
                Object.hasOwn(record, "mirror");
        });

        if (this.pendingMigration || hasLegacyFields) {
            void this.persist().catch(console.error);
        }

        if (!this.instances.has(this.selectedId)) {
            this.selectedId =
                this.instances.keys().next().value ?? null;
        }

        this.updateHighlight();
        this.attachPreview();
        this.refreshVisibility();

        this.dispatchEvent(new Event("change"));
    }

    updateHighlight() {
        const bone = this.selectedRecord
            ? this.getBone(this.selectedBone)
            : null;

        if (!bone) {
            this.highlight.parent?.remove(this.highlight);
            this.highlight.visible = false;
            return;
        }

        if (this.highlight.parent !== bone) {
            bone.add(this.highlight);
        }

        bone.updateWorldMatrix(true, false);

        const scale = bone.getWorldScale(
            new THREE.Vector3()
        );

        this.highlight.scale.set(
            0.007 / Math.max(EPSILON, Math.abs(scale.x)),
            0.007 / Math.max(EPSILON, Math.abs(scale.y)),
            0.007 / Math.max(EPSILON, Math.abs(scale.z))
        );

        this.highlight.visible = this.visible;
    }

    refreshVisibility() {
        for (const instance of this.instances.values()) {
            instance.object.visible = this.visible;
        }

        this.highlight.visible =
            this.visible && Boolean(this.highlight.parent);

        if (this.preview) {
            this.preview.visible =
                this.visible && Boolean(this.preview.parent);
        }
    }

    setVisible(value) {
        this.visible = Boolean(value);

        this.refreshVisibility();
        this.updateHighlight();
    }

    selectAnchor(id) {
        this.selectedId = this.instances.has(id)
            ? id
            : null;

        this.attachPreview();
        this.updateHighlight();

        this.dispatchEvent(new Event("change"));
    }

    syncRecord(instance) {
        instance.record.position = this.boneLocalToMeters(
            instance.object.parent,
            instance.object.position
        ).toArray();

        instance.record.positionSpace = "meters";

        instance.record.quaternion =
            instance.object.quaternion.toArray();

        instance.record.scale =
            instance.object.scale.toArray();
    }

    async persist() {
        const anchors = this.records.map(record => ({
            id: record.id,
            name: record.name,
            bone: record.bone,
            position: [
                ...readVector(record.position, [0, 0, 0])
            ],
            quaternion: [
                ...readVector(record.quaternion, [0, 0, 0, 1])
            ],
            scale: [
                ...readVector(record.scale, [1, 1, 1])
            ],
            positionSpace: record.positionSpace === "meters"
                ? "meters"
                : undefined
        }));

        await this.session.setMetadata({
            ...this.session.metadata,
            anchors
        });

        this.dispatchEvent(new Event("change"));
    }

    async add(name) {
        const value = name.trim();

        if (!value) {
            throw new Error("Anchor name cannot be empty.");
        }

        const bone = this.getDefaultBoneName();

        if (!this.getBone(bone)) {
            throw new Error("Avatar skeleton is unavailable.");
        }

        const record = {
            id: crypto.randomUUID(),
            name: value,
            bone,
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 1, 1],
            positionSpace: "meters"
        };

        this.session.metadata.anchors = [
            ...this.records,
            record
        ];

        this.createInstance(record);
        this.selectAnchor(record.id);
        this.refreshVisibility();

        await this.persist();

        return record.id;
    }

    async setParentBone(id, boneName) {
        const instance = this.instances.get(id);
        const record = this.records.find(item => item.id === id);
        const targetBone = this.getBone(boneName);

        if (!instance || !record) {
            return;
        }

        if (!targetBone) {
            throw new Error(`Unknown bone: ${boneName}`);
        }

        if (instance.object.parent === targetBone) {
            return;
        }

        this.session.avatar?.updateWorldMatrix(true, true);

        // Preserve the world transform when changing the parent bone.
        targetBone.attach(instance.object);

        record.bone = boneName.replace(/_\d+$/, "");
        this.syncRecord(instance);

        this.attachPreview();
        this.updateHighlight();

        await this.persist();
    }

    async mirror(id) {
        const instance = this.instances.get(id);
        const record = this.records.find(item => item.id === id);

        if (!instance || !record) {
            return;
        }

        const sourceBone = this.getBone(record.bone);

        if (!sourceBone) {
            throw new Error(`Unknown bone: ${record.bone}`);
        }

        const oppositeName = mirroredBoneName(record.bone);
        const targetBone = this.getBone(oppositeName) ??
            sourceBone;

        // Mirror the normalized metric offset.
        const position = new THREE.Vector3().fromArray(
            record.position
        );

        const quaternion = instance.object.quaternion.clone();

        position.x = -position.x;

        quaternion.set(
            quaternion.x,
            -quaternion.y,
            -quaternion.z,
            quaternion.w
        ).normalize();

        if (instance.object.parent !== targetBone) {
            targetBone.add(instance.object);
        }

        instance.object.position.copy(
            this.metersToBoneLocal(targetBone, position)
        );

        instance.object.quaternion.copy(quaternion);
        instance.object.updateWorldMatrix(true, true);

        record.bone = targetBone === this.root
            ? "root"
            : targetBone.name.replace(/_\d+$/, "");

        this.syncRecord(instance);

        this.attachPreview();
        this.updateHighlight();

        await this.persist();
    }

    async copy(id) {
        const original = this.records.find(record => {
            return record.id === id;
        });

        if (!original) {
            return null;
        }

        const record = {
            id: crypto.randomUUID(),
            name: nextCopyName(original.name, this.records),
            bone: original.bone,
            position: [
                ...readVector(original.position, [0, 0, 0])
            ],
            quaternion: [
                ...readVector(original.quaternion, [0, 0, 0, 1])
            ],
            scale: [
                ...readVector(original.scale, [1, 1, 1])
            ],
            positionSpace: "meters"
        };

        this.session.metadata.anchors = [
            ...this.records,
            record
        ];

        this.createInstance(record);
        this.selectAnchor(record.id);
        this.refreshVisibility();

        await this.persist();

        return record.id;
    }

    async rename(id, name) {
        const record = this.records.find(item => {
            return item.id === id;
        });

        const value = name.trim();

        if (!record || !value) {
            throw new Error("Invalid anchor name.");
        }

        record.name = value;

        const instance = this.instances.get(id);

        if (instance) {
            instance.object.name = `Anchor:${value}`;
        }

        await this.persist();
    }

    async remove(id) {
        const instance = this.instances.get(id);

        if (!instance) {
            return;
        }

        this.disposeInstance(instance);
        this.instances.delete(id);

        this.session.metadata.anchors = this.records.filter(record => {
            return record.id !== id;
        });

        if (this.selectedId === id) {
            this.selectedId =
                this.instances.keys().next().value ?? null;
        }

        this.attachPreview();
        this.updateHighlight();

        await this.persist();
    }

    onTransformChanged() {
        const instance = this.selectedInstance;

        if (instance) {
            this.syncRecord(instance);
        }
    }

    async saveSelectedTransform() {
        if (!this.selectedInstance) {
            return;
        }

        this.onTransformChanged();
        await this.persist();
    }

    update() {
        if (!this.visible || !this.root) {
            return;
        }

        this.updateHighlight();
        this.updatePreviewScale();
    }

    dispose() {
        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.assets.removeEventListener(
            "change",
            this.onAssetsChange
        );

        this.clearPreview();
        this.clearInstances();

        this.highlight.parent?.remove(this.highlight);
        this.highlight.geometry.dispose();
        this.highlight.material.dispose();
    }
}