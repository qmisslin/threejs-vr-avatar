import * as THREE from "three";
import readHandPosesFromGLB from "./HandPoseGLBImporter.js";

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const IDENTITY = [0, 0, 0, 1];

function createEntries() {
    const entries = [];

    for (let index = 1; index <= 3; index++) {
        for (const finger of FINGERS) {
            for (const side of ["Right", "Left"]) {
                entries.push({
                    name: `${side}Hand${finger}${index}`,
                    side: side.toLowerCase(),
                    joint: `${finger}${index}`,
                    kind: "finger"
                });
            }
        }
    }

    return entries;
}

function createHandState() {
    const state = {};

    for (const finger of FINGERS) {
        for (let index = 1; index <= 3; index++) {
            state[`${finger}${index}`] = [...IDENTITY];
        }
    }

    return state;
}

function readQuaternion(values) {
    if (
        !Array.isArray(values) ||
        values.length !== 4 ||
        !values.every(Number.isFinite)
    ) {
        return new THREE.Quaternion();
    }

    return new THREE.Quaternion()
        .fromArray(values)
        .normalize();
}

function normalizeHandState(state) {
    const result = createHandState();

    for (const joint of Object.keys(result)) {
        result[joint] = readQuaternion(
            state?.[joint]
        ).toArray();
    }

    return result;
}

export default class HandPoseController extends EventTarget {
    constructor(session) {
        super();

        this.session = session;

        this.entries = createEntries();

        this.entriesByName = new Map(
            this.entries.map(entry => [entry.name, entry])
        );

        this.bones = new Map();
        this.baselines = new Map();

        this.referenceQuaternions = new Map();
        this.referenceFrames = new Map();

        this.avatar = null;
        this.root = null;

        this.selectedId = null;
        this.visible = false;
        this.applied = false;

        this.onSessionChange = () => {
            if (this.avatar !== this.session.avatar) {
                this.rebuild();
            }
        };

        this.session.addEventListener(
            "change",
            this.onSessionChange
        );

        if (this.session.avatar) {
            this.rebuild();
        }
    }

    get records() {
        return Array.isArray(this.session.metadata.handPoses)
            ? this.session.metadata.handPoses
            : [];
    }

    get selectedRecord() {
        return this.records.find(record => {
            return record.id === this.selectedId;
        }) ?? null;
    }

    getEditableBones() {
        return this.entries
            .map(entry => ({
                ...entry,
                bone: this.bones.get(entry.name)
            }))
            .filter(entry => Boolean(entry.bone));
    }

    getCounterpart(name) {
        if (name.startsWith("Right")) {
            return `Left${name.slice(5)}`;
        }

        if (name.startsWith("Left")) {
            return `Right${name.slice(4)}`;
        }

        return null;
    }

    captureReferencePose() {
        this.referenceQuaternions.clear();
        this.referenceFrames.clear();

        if (!this.avatar) {
            return;
        }

        // Recover the original bind transforms from the skinning data.
        // Unlike live bone transforms, boneInverses are not animated.
        const bindMatrices = new Map();

        this.avatar.traverse(object => {
            if (!object.isSkinnedMesh || !object.skeleton) {
                return;
            }

            const skeleton = object.skeleton;

            for (let i = 0; i < skeleton.bones.length; i++) {
                const bone = skeleton.bones[i];
                const inverse = skeleton.boneInverses[i];

                if (
                    bone?.isBone &&
                    inverse &&
                    !bindMatrices.has(bone)
                ) {
                    bindMatrices.set(
                        bone,
                        inverse.clone().invert()
                    );
                }
            }
        });

        this.avatar.updateWorldMatrix(true, true);

        const rootRotation = this.root
            ? this.root.getWorldQuaternion(
                new THREE.Quaternion()
            )
            : new THREE.Quaternion();

        const inverseRootRotation = rootRotation
            .clone()
            .invert();

        for (const [name, bone] of this.bones) {
            const bindWorld = bindMatrices.get(bone);
            const parentBindWorld = bindMatrices.get(bone.parent);

            let localRotation;
            let worldRotation;

            if (bindWorld && parentBindWorld) {
                const localMatrix = parentBindWorld
                    .clone()
                    .invert()
                    .multiply(bindWorld);

                localRotation = new THREE.Quaternion();

                localMatrix.decompose(
                    new THREE.Vector3(),
                    localRotation,
                    new THREE.Vector3()
                );

                worldRotation = new THREE.Quaternion();

                bindWorld.decompose(
                    new THREE.Vector3(),
                    worldRotation,
                    new THREE.Vector3()
                );
            } else {
                // Fallback for skeletons without complete bind matrices.
                localRotation = bone.quaternion.clone();

                worldRotation = bone.getWorldQuaternion(
                    new THREE.Quaternion()
                );
            }

            localRotation.normalize();
            worldRotation.normalize();

            this.referenceQuaternions.set(
                name,
                localRotation
            );

            // Express the reference orientation in the avatar root frame.
            this.referenceFrames.set(
                name,
                inverseRootRotation
                    .clone()
                    .multiply(worldRotation)
                    .normalize()
            );
        }
    }

    rebuild() {
        this.restoreBaselines();

        this.avatar = this.session.avatar;

        this.root = this.session.getBone("root") ??
            this.avatar;

        this.bones.clear();
        this.baselines.clear();

        for (const entry of this.entries) {
            const bone = this.session.getBone(entry.name);

            if (bone?.isBone) {
                this.bones.set(entry.name, bone);
            }
        }

        this.captureReferencePose();

        if (
            this.selectedId !== null &&
            !this.records.some(record => {
                return record.id === this.selectedId;
            })
        ) {
            this.selectedId = null;
        }

        this.applied = false;

        this.dispatchEvent(new Event("change"));
    }

    setVisible(value) {
        const next = Boolean(value);

        if (next === this.visible) {
            return;
        }

        this.restoreBaselines();
        this.visible = next;

        if (next) {
            this.applyPose();
        }

        this.dispatchEvent(new Event("change"));
    }

    selectPose(id) {
        this.restoreBaselines();

        this.selectedId = this.records.some(record => {
            return record.id === id;
        }) ? id : null;

        this.applyPose();

        this.dispatchEvent(new Event("change"));
    }

    restoreBaselines() {
        if (!this.applied) {
            return;
        }

        for (const [name, quaternion] of this.baselines) {
            const bone = this.bones.get(name);

            if (bone) {
                bone.quaternion.copy(quaternion);
            }
        }

        this.avatar?.updateWorldMatrix(true, true);

        this.baselines.clear();
        this.applied = false;
    }

    beforeAnimation() {
        // Restore animated finger rotations before evaluating the mixer.
        this.restoreBaselines();
    }

    applyPose() {
        const pose = this.selectedRecord;

        // "default" always leaves the fingers controlled by animation.
        if (
            !this.visible ||
            !pose ||
            !this.bones.size ||
            this.applied
        ) {
            return;
        }

        this.baselines.clear();

        for (const [name, bone] of this.bones) {
            // Remember the actual animated rotation only for restoration.
            this.baselines.set(
                name,
                bone.quaternion.clone()
            );
        }

        for (const entry of this.entries) {
            const bone = this.bones.get(entry.name);

            const reference = this.referenceQuaternions.get(
                entry.name
            );

            if (!bone || !reference) {
                continue;
            }

            const delta = readQuaternion(
                pose[entry.side]?.[entry.joint]
            );

            // Completely replace the animation's finger quaternion.
            // Never multiply a pose onto the animated quaternion.
            bone.quaternion
                .copy(reference)
                .multiply(delta)
                .normalize();
        }

        this.avatar?.updateWorldMatrix(true, true);
        this.applied = true;
    }

    afterAnimation() {
        this.applyPose();
    }

    getDelta(name) {
        const entry = this.entriesByName.get(name);

        if (!entry) {
            return new THREE.Quaternion();
        }

        return readQuaternion(
            this.selectedRecord?.[entry.side]?.[entry.joint]
        );
    }

    setDelta(name, quaternion) {
        const entry = this.entriesByName.get(name);
        const record = this.selectedRecord;

        if (!entry || !record) {
            return;
        }

        if (!record[entry.side]) {
            record[entry.side] = createHandState();
        }

        record[entry.side][entry.joint] =
            quaternion.clone().normalize().toArray();
    }

    mirrorDelta(sourceName, targetName, delta) {
        const sourceFrame = this.referenceFrames.get(sourceName);
        const targetFrame = this.referenceFrames.get(targetName);

        if (!sourceFrame || !targetFrame) {
            return new THREE.Quaternion();
        }

        // Convert the source delta to the reference skeleton frame.
        const rootDelta = sourceFrame.clone()
            .multiply(delta)
            .multiply(sourceFrame.clone().invert())
            .normalize();

        // Reflect the rotation across the skeleton's local YZ plane.
        const reflected = new THREE.Quaternion(
            rootDelta.x,
            -rootDelta.y,
            -rootDelta.z,
            rootDelta.w
        ).normalize();

        // Convert the mirrored delta to the opposite bone's local frame.
        return targetFrame.clone()
            .invert()
            .multiply(reflected)
            .multiply(targetFrame)
            .normalize();
    }

    onBoneChanged(name) {
        if (
            !this.visible ||
            !this.selectedRecord ||
            !this.applied
        ) {
            return;
        }

        const bone = this.bones.get(name);

        const reference = this.referenceQuaternions.get(
            name
        );

        if (!bone || !reference) {
            return;
        }

        // The edited bone is already in its custom pose, not its animation pose.
        const delta = reference.clone()
            .invert()
            .multiply(bone.quaternion)
            .normalize();

        this.setDelta(name, delta);

        const oppositeName = this.getCounterpart(name);

        const oppositeBone = this.bones.get(oppositeName);

        const oppositeReference = this.referenceQuaternions.get(
            oppositeName
        );

        if (!oppositeBone || !oppositeReference) {
            return;
        }

        const mirroredDelta = this.mirrorDelta(
            name,
            oppositeName,
            delta
        );

        this.setDelta(oppositeName, mirroredDelta);

        oppositeBone.quaternion
            .copy(oppositeReference)
            .multiply(mirroredDelta)
            .normalize();

        this.avatar?.updateWorldMatrix(true, true);
    }

    async persist() {
        const records = this.records.map(record => ({
            id: record.id,
            name: record.name,
            right: normalizeHandState(record.right),
            left: normalizeHandState(record.left)
        }));

        await this.session.setMetadata({
            ...this.session.metadata,
            handPoses: records
        });

        this.dispatchEvent(new Event("change"));
    }

    async add(name) {
        const value = name.trim();

        if (!value) {
            throw new Error("Pose name cannot be empty.");
        }

        // A new pose always starts with all fingers neutral.
        const record = {
            id: crypto.randomUUID(),
            name: value,
            right: createHandState(),
            left: createHandState()
        };

        this.session.metadata.handPoses = [
            ...this.records,
            record
        ];

        this.selectPose(record.id);

        await this.persist();

        return record.id;
    }

    async reset() {
        const record = this.selectedRecord;

        if (!record) {
            return;
        }

        this.restoreBaselines();

        // Identity deltas restore the neutral bind pose of all fingers.
        record.right = createHandState();
        record.left = createHandState();

        this.applyPose();

        await this.persist();
    }

    async remove(id) {
        if (!this.records.some(record => record.id === id)) {
            return;
        }

        this.restoreBaselines();

        this.session.metadata.handPoses =
            this.records.filter(record => record.id !== id);

        if (this.selectedId === id) {
            // After removing the active pose, return to "default".
            this.selectedId = null;
        }

        this.applyPose();

        await this.persist();
    }

    async importGLB(file) {
        const { poses, skipped } = await readHandPosesFromGLB(file);

        const records = this.records.map(record => ({
            ...record,
            right: normalizeHandState(record.right),
            left: normalizeHandState(record.left)
        }));

        const indices = new Map(
            records.map((record, index) => [
                record.name,
                index
            ])
        );

        let added = 0;
        let replaced = 0;

        for (const pose of poses) {
            const index = indices.get(pose.name);

            if (index !== undefined) {
                // Preserve the existing pose identifier.
                records[index] = {
                    ...records[index],
                    right: pose.right,
                    left: pose.left
                };

                replaced++;
            } else {
                const record = {
                    id: crypto.randomUUID(),
                    name: pose.name,
                    right: pose.right,
                    left: pose.left
                };

                indices.set(record.name, records.length);
                records.push(record);
                added++;
            }
        }

        // Restore the animation-owned rotations before changing poses.
        this.restoreBaselines();

        // Persist only the merged hand poses.
        await this.session.setMetadata({
            ...this.session.metadata,
            handPoses: records
        });

        // Reapply the selected custom pose if it was replaced.
        this.applyPose();

        this.dispatchEvent(new Event("change"));

        return {
            added,
            replaced,
            skipped
        };
    }

    async saveSelectedPose() {
        if (!this.selectedRecord) {
            return;
        }

        await this.persist();
    }

    dispose() {
        this.restoreBaselines();

        this.session.removeEventListener(
            "change",
            this.onSessionChange
        );

        this.bones.clear();
        this.baselines.clear();
        this.referenceQuaternions.clear();
        this.referenceFrames.clear();
    }
}