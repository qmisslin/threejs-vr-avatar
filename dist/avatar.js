import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const SIDES = ["left", "right"];

const CHAINS = {
    leftArm: ["LeftArm", "LeftForeArm", "LeftHand"],
    rightArm: ["RightArm", "RightForeArm", "RightHand"],
    leftLeg: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
    rightLeg: ["RightUpLeg", "RightLeg", "RightFoot"]
};

const EPSILON = 1e-7;

export default class Avatar {
    constructor() {
        this.origin = new THREE.Group();
        this.origin.name = "AvatarOrigin";

        this.model = null;
        this.eyes = null;
        this.root = null;
        this.hips = null;
        this.head = null;

        this.height = 1.75;
        this.metadata = null;

        this.bones = new Map();
        this.skin = new Map();
        this.accessories = new Map();
        this.anchors = new Map();
        this.instances = new Set();

        this.mixer = null;
        this.actions = new Map();
        this.action = null;

        this.chains = new Map();
        this.poles = new Map();

        this.handTargets = {
            left: null,
            right: null
        };

        this.handPoses = new Map();

        this.fingers = {
            left: new Map(),
            right: new Map()
        };

        this.poseState = {
            left: {
                name: null,
                from: null,
                duration: 0,
                elapsed: 0
            },
            right: {
                name: null,
                from: null,
                duration: 0,
                elapsed: 0
            }
        };

        this.headRotation = null;
        this.hipsHeight = 0;

        this._saved = new Map();
    }

    _name(name) {
        return name
            .replace(/^.*[|:]/, "")
            .replace(/^mixamorig\d*/i, "")
            .replace(/_\d+$/, "")
            .replace(/[^a-zA-Z0-9]/g, "")
            .toLowerCase();
    }

    _descends(bone, ancestor) {
        let current = bone;

        while (current) {
            if (current === ancestor) {
                return true;
            }

            current = current.parent;
        }

        return false;
    }

    _distance(ancestor, bone) {
        let distance = 0;
        let current = bone;

        while (current && current !== ancestor) {
            current = current.parent;
            distance++;
        }

        return current === ancestor
            ? distance
            : Infinity;
    }

    _candidates(name, ancestor = this.model) {
        const result = [];
        const key = this._name(name);

        ancestor.traverse(object => {
            if (
                object.isBone &&
                this._name(object.name) === key
            ) {
                result.push(object);
            }
        });

        return result;
    }

    _selectBone(name, ancestor) {
        const candidates = this._candidates(
            name,
            ancestor
        );

        candidates.sort((a, b) => {
            const score = bone => {
                return (
                    this._skinBones.has(bone) ? 100 : 0
                ) - this._distance(ancestor, bone);
            };

            return score(b) - score(a);
        });

        return candidates[0] ?? null;
    }

    _findChain(names, ancestor) {
        let best = null;
        let bestScore = -Infinity;

        for (const first of this._candidates(names[0], ancestor)) {
            for (const middle of this._candidates(names[1], first)) {
                for (const end of this._candidates(names[2], middle)) {
                    const score = [first, middle, end].reduce(
                        (sum, bone) => {
                            return sum + (
                                this._skinBones.has(bone)
                                    ? 100
                                    : 0
                            );
                        },
                        0
                    ) -
                        this._distance(ancestor, first) -
                        this._distance(first, middle) -
                        this._distance(middle, end);

                    if (score > bestScore) {
                        bestScore = score;
                        best = [first, middle, end];
                    }
                }
            }
        }

        return best;
    }

    _buildSkeleton() {
        this._skinBones = new Set();

        this.model.traverse(object => {
            if (object.isSkinnedMesh) {
                for (const bone of object.skeleton.bones) {
                    this._skinBones.add(bone);
                }
            }
        });

        let solution = null;
        let bestScore = -Infinity;

        for (const root of this._candidates("root")) {
            for (const hips of this._candidates("Hips", root)) {
                if (root === hips) {
                    continue;
                }

                const chains = new Map();
                let score = 0;

                for (const [name, names] of Object.entries(CHAINS)) {
                    const bones = this._findChain(
                        names,
                        hips
                    );

                    if (!bones) {
                        break;
                    }

                    chains.set(name, bones);

                    score += bones.filter(bone => {
                        return this._skinBones.has(bone);
                    }).length;
                }

                if (chains.size !== 4) {
                    continue;
                }

                score =
                    score * 100 -
                    this._distance(root, hips);

                if (score > bestScore) {
                    bestScore = score;
                    solution = {
                        root,
                        hips,
                        chains
                    };
                }
            }
        }

        if (!solution) {
            throw new Error(
                "Invalid Avatar Creator skeleton."
            );
        }

        this.root = solution.root;
        this.hips = solution.hips;
        this.chains = solution.chains;

        // GLB imports may contain nested duplicate wrist joints.
        // IK must use the proximal wrist in that case.
        for (const side of SIDES) {
            const chain = this.chains.get(
                `${side}Arm`
            );

            const handName = this._name(
                `${side}Hand`
            );

            while (
                chain[2].parent?.isBone &&
                this._name(chain[2].parent.name) === handName &&
                this._descends(chain[2].parent, chain[1])
            ) {
                chain[2] = chain[2].parent;
            }
        }

        this.bones.set("root", this.root);
        this.bones.set("hips", this.hips);

        for (const [key, bones] of this.chains) {
            CHAINS[key].forEach((name, index) => {
                this.bones.set(
                    this._name(name),
                    bones[index]
                );
            });
        }

        for (const bone of this._skinBones) {
            if (!this._descends(bone, this.hips)) {
                continue;
            }

            const key = this._name(bone.name);

            if (!this.bones.has(key)) {
                this.bones.set(key, bone);
            }
        }

        this.head = this._selectBone(
            "Head",
            this.hips
        );

        if (!this.head) {
            throw new Error("Missing Head bone.");
        }

        this.bones.set("head", this.head);

        for (const side of SIDES) {
            const wrist = this.chains.get(
                `${side}Arm`
            )[2];

            const hands = this._candidates(
                `${side}Hand`,
                wrist
            );

            hands.push(wrist);

            hands.sort((a, b) => {
                const count = hand => {
                    return this._candidates(
                        `${side}HandThumb1`,
                        hand
                    ).length;
                };

                return count(b) - count(a);
            });

            const fingerRoot = hands[0];

            this.bones.set(
                this._name(`${side}Hand`),
                fingerRoot
            );

            for (const finger of FINGERS) {
                let parent = fingerRoot;

                for (let i = 1; i <= 3; i++) {
                    const joint = `${finger}${i}`;

                    const bone = this._selectBone(
                        `${side}Hand${joint}`,
                        parent
                    );

                    if (!bone) {
                        throw new Error(
                            `Missing finger bone: ${side}.${joint}`
                        );
                    }

                    this.fingers[side].set(joint, {
                        bone,
                        reference: null
                    });

                    this.bones.set(
                        this._name(`${side}Hand${joint}`),
                        bone
                    );

                    parent = bone;
                }
            }
        }
    }

    _captureFingerReferences() {
        const bind = new Map();

        this.model.traverse(object => {
            if (!object.isSkinnedMesh) {
                return;
            }

            object.skeleton.bones.forEach((bone, index) => {
                if (!bind.has(bone)) {
                    bind.set(
                        bone,
                        object.skeleton.boneInverses[index]
                            .clone()
                            .invert()
                    );
                }
            });
        });

        this.model.updateWorldMatrix(true, true);

        for (const side of SIDES) {
            for (const entry of this.fingers[side].values()) {
                const boneWorld = bind.get(
                    entry.bone
                );

                const parentWorld = bind.get(
                    entry.bone.parent
                );

                if (!boneWorld || !parentWorld) {
                    entry.reference =
                        entry.bone.quaternion.clone();

                    continue;
                }

                const matrix = parentWorld
                    .clone()
                    .invert()
                    .multiply(boneWorld);

                entry.reference = new THREE.Quaternion();

                matrix.decompose(
                    new THREE.Vector3(),
                    entry.reference,
                    new THREE.Vector3()
                );

                entry.reference.normalize();
            }
        }
    }

    _createPoles() {
        const saved = this.metadata.ik;

        const hipTarget = new THREE.Object3D();

        this.root.add(hipTarget);

        hipTarget.position.fromArray(
            saved.hipPosition
        );

        this._hipTarget = hipTarget;

        const offsets = {
            leftElbow: [0.18, -0.12],
            rightElbow: [-0.18, -0.12],
            leftKnee: [0.08, 0.18],
            rightKnee: [-0.08, 0.18]
        };

        for (const name of Object.keys(offsets)) {
            const pole = new THREE.Object3D();

            const parent = name.endsWith("Elbow")
                ? hipTarget
                : this.root;

            parent.add(pole);

            pole.position.fromArray(
                saved.poles[name]
            );

            this.poles.set(name, pole);
        }

        for (const side of SIDES) {
            const state = saved.hands[side];

            const target = new THREE.Object3D();

            target.position.fromArray(
                state.position
            );

            target.quaternion.fromArray(
                state.quaternion
            );

            this.root.add(target);

            this.handTargets[side] = target;
        }
    }

    _createAnchors() {
        this.model.updateWorldMatrix(true, true);

        for (const record of this.metadata.anchors) {
            const bone = this.bones.get(
                this._name(record.bone)
            );

            if (!bone) {
                throw new Error(
                    `Unknown anchor bone: ${record.bone}`
                );
            }

            if (record.positionSpace !== "meters") {
                throw new Error(
                    `Unsupported anchor position space: ${record.name}`
                );
            }

            const anchor = new THREE.Object3D();

            anchor.name = record.name;
            anchor.userData.avatarAnchor = true;

            bone.add(anchor);

            bone.updateWorldMatrix(true, false);

            const origin = bone.getWorldPosition(
                new THREE.Vector3()
            );

            const rotation = bone.getWorldQuaternion(
                new THREE.Quaternion()
            );

            const worldPosition = new THREE.Vector3()
                .fromArray(record.position)
                .applyQuaternion(rotation)
                .add(origin);

            anchor.position.copy(
                bone.worldToLocal(worldPosition)
            );

            anchor.quaternion
                .fromArray(record.quaternion)
                .normalize();

            anchor.scale.fromArray(
                record.scale
            );

            if (this.anchors.has(record.name)) {
                throw new Error(
                    `Duplicate anchor: ${record.name}`
                );
            }

            this.anchors.set(
                record.name,
                anchor
            );
        }
    }

    _createEyes() {
        const state = this.metadata.cameraAnchor;

        if (!state) {
            throw new Error(
                "Missing camera target metadata."
            );
        }

        this.model.updateWorldMatrix(true, true);

        const position = this.root.localToWorld(
            new THREE.Vector3().fromArray(
                state.position
            )
        );

        this.eyes = new THREE.Object3D();
        this.eyes.name = "AvatarEyes";

        this.origin.add(this.eyes);

        this.eyes.position.copy(
            this.origin.worldToLocal(position)
        );

        const camera = new THREE.Object3D();

        camera.position.fromArray(
            state.orbitPosition
        );

        camera.lookAt(0, 0, 0);

        const rootRotation = this.root.getWorldQuaternion(
            new THREE.Quaternion()
        );

        const originRotation = this.origin.getWorldQuaternion(
            new THREE.Quaternion()
        );

        this.eyes.quaternion
            .copy(originRotation.invert())
            .multiply(rootRotation)
            .multiply(camera.quaternion);
    }

    _createAccessories(gltf) {
        const library = gltf.scenes.find(scene => {
            return scene.userData.avatarCreatorAssets;
        });

        if (
            this.metadata.assets.length &&
            !library
        ) {
            throw new Error(
                "Missing Avatar Creator asset library."
            );
        }

        for (const record of this.metadata.assets) {
            let source = null;

            library.traverse(object => {
                if (
                    object.userData.avatarAssetId !== record.id
                ) {
                    return;
                }

                source = object.children.find(child => {
                    return child.userData.avatarAssetSource;
                }) ?? object.children[0];
            });

            if (!source) {
                throw new Error(
                    `Missing accessory: ${record.name}`
                );
            }

            if (this.accessories.has(record.name)) {
                throw new Error(
                    `Duplicate accessory: ${record.name}`
                );
            }

            this.accessories.set(record.name, {
                record,
                source
            });
        }
    }

    async load(filepath) {
        const gltf = await new GLTFLoader().loadAsync(
            filepath
        );

        const manifest =
            gltf.scene.userData.avatarCreator;

        if (
            manifest?.format !== "avatar-creator" ||
            manifest.version !== 1
        ) {
            throw new Error(
                "Invalid Avatar Creator GLB."
            );
        }

        const metadata = manifest.metadata;

        if (
            !metadata?.ik ||
            !Array.isArray(metadata.assets) ||
            !Array.isArray(metadata.anchors) ||
            !Array.isArray(metadata.handPoses)
        ) {
            throw new Error(
                "Incomplete Avatar Creator metadata."
            );
        }

        this.mixer?.stopAllAction();

        this.origin.clear();

        this.model = gltf.scene;
        this.metadata = metadata;

        this.root = null;
        this.hips = null;
        this.head = null;
        this.eyes = null;

        this.bones.clear();
        this.skin.clear();
        this.accessories.clear();
        this.anchors.clear();
        this.instances.clear();
        this.actions.clear();
        this.chains.clear();
        this.poles.clear();

        this.fingers.left.clear();
        this.fingers.right.clear();

        this._saved.clear();

        this.poseState.left = {
            name: null,
            from: null,
            duration: 0,
            elapsed: 0
        };

        this.poseState.right = {
            name: null,
            from: null,
            duration: 0,
            elapsed: 0
        };

        this.headRotation = null;
        this.hipsHeight = 0;

        this.origin.scale.setScalar(1);
        this.origin.add(this.model);

        this._buildSkeleton();
        this._captureFingerReferences();

        this._createPoles();
        this._createAnchors();
        this._createEyes();
        this._createAccessories(gltf);

        this.model.traverse(object => {
            if (!object.isMesh) {
                return;
            }

            if (this.skin.has(object.name)) {
                throw new Error(
                    `Duplicate skin object: ${object.name}`
                );
            }

            this.skin.set(
                object.name,
                object
            );

            object.visible = true;
        });

        this.handPoses = new Map(
            metadata.handPoses.map(pose => [
                pose.name,
                pose
            ])
        );

        this.mixer = new THREE.AnimationMixer(
            this.model
        );

        for (const clip of gltf.animations) {
            if (this.actions.has(clip.name)) {
                throw new Error(
                    `Duplicate animation: ${clip.name}`
                );
            }

            this.actions.set(
                clip.name,
                this.mixer.clipAction(clip)
            );
        }

        this.action = null;

        this.height =
            metadata.avatarHeight || 1.75;

        this.setHeight(this.height);

        this.setHipsHeight(
            metadata.ik.hipsHeight || 0
        );

        if (this.actions.size) {
            const name = this.actions.has(
                manifest.selectedAnimation
            )
                ? manifest.selectedAnimation
                : this.actions.keys().next().value;

            this.setAnim(name, 0);
        }

        this.update(0);

        return this;
    }

    setHeight(value) {
        if (!(value > 0)) {
            throw new Error(
                "Height must be positive."
            );
        }

        this.origin.scale.setScalar(
            value /
            (this.metadata?.avatarHeight || 1.75)
        );

        this.height = value;
    }

    setHipsHeight(value) {
        if (!Number.isFinite(value)) {
            throw new Error(
                "Invalid hips height."
            );
        }

        this.hipsHeight = value;
    }

    setRightHandTransform(rightworldTransform) {
        this.handTargets.right = rightworldTransform;
    }

    setLeftHandTransform(leftworldTransform) {
        this.handTargets.left = leftworldTransform;
    }

    setHeadRotation(rotation) {
        if (rotation === null) {
            this.headRotation = null;
            return;
        }

        this.headRotation = rotation.isEuler
            ? new THREE.Quaternion().setFromEuler(rotation)
            : Array.isArray(rotation)
                ? new THREE.Quaternion()
                    .fromArray(rotation)
                    .normalize()
                : rotation.clone().normalize();
    }

    setAnim(name, transition = 0) {
        const next = this.actions.get(name);

        if (!next) {
            throw new Error(
                `Unknown animation: ${name}`
            );
        }

        if (this.action === next) {
            return;
        }

        const previous = this.action;

        this.action = next;

        next.reset()
            .setEffectiveTimeScale(1)
            .setEffectiveWeight(1)
            .play();

        if (previous && transition > 0) {
            next.crossFadeFrom(
                previous,
                transition / 1000,
                true
            );
        } else {
            previous?.stop();
        }
    }

    _setHandPose(side, name, transition) {
        if (!name || name === "default") {
            name = null;
        }

        if (
            name &&
            !this.handPoses.has(name)
        ) {
            throw new Error(
                `Unknown hand pose: ${name}`
            );
        }

        const state = this.poseState[side];

        if (state.name === name) {
            return;
        }

        state.name = name;
        state.duration = Math.max(
            0,
            transition
        ) / 1000;

        state.elapsed = 0;

        state.from = state.duration
            ? new Map(
                [...this.fingers[side]].map(
                    ([joint, { bone }]) => [
                        joint,
                        bone.quaternion.clone()
                    ]
                )
            )
            : null;
    }

    setLeftHandPose(name, transition = 0) {
        this._setHandPose(
            "left",
            name,
            transition
        );
    }

    setRighHandPose(name, transition = 0) {
        this._setHandPose(
            "right",
            name,
            transition
        );
    }

    setRightHandPose(name, transition = 0) {
        this.setRighHandPose(
            name,
            transition
        );
    }

    setSkin(name, visible) {
        const object = this.skin.get(name);

        if (!object) {
            throw new Error(
                `Unknown skin object: ${name}`
            );
        }

        object.visible = Boolean(visible);

        return null;
    }

    createInstance(name) {
        const asset = this.accessories.get(name);

        if (!asset) {
            throw new Error(
                `Unknown accessory: ${name}`
            );
        }

        const clone = cloneSkeleton(
            asset.source
        );

        clone.updateWorldMatrix(true, true);

        const bounds = new THREE.Box3()
            .setFromObject(clone, true);

        if (bounds.isEmpty()) {
            throw new Error(
                `Empty accessory: ${name}`
            );
        }

        const size = bounds.getSize(
            new THREE.Vector3()
        );

        const extent = Math.max(
            size.x,
            size.y,
            size.z
        );

        if (extent < EPSILON) {
            throw new Error(
                `Invalid accessory bounds: ${name}`
            );
        }

        const center = bounds.getCenter(
            new THREE.Vector3()
        );

        const ref = new THREE.Group();
        ref.name = name;

        const model = new THREE.Group();
        const state = asset.record.model;

        model.position.fromArray(
            state.position
        );

        model.quaternion.fromArray(
            state.quaternion
        );

        model.scale.fromArray(
            state.scale
        );

        const normal = new THREE.Group();

        normal.scale.setScalar(
            1 / extent
        );

        normal.position
            .copy(center)
            .multiplyScalar(-1 / extent);

        normal.add(clone);
        model.add(normal);
        ref.add(model);

        this.instances.add(ref);

        return ref;
    }

    atachInstance(ref, anchorname) {
        const anchor = this.anchors.get(
            anchorname
        );

        if (!anchor) {
            throw new Error(
                `Unknown anchor: ${anchorname}`
            );
        }

        anchor.add(ref);

        ref.position.set(0, 0, 0);
        ref.quaternion.identity();

        if (this.instances.has(ref)) {
            this._updateInstanceScale(ref);
        }

        return ref;
    }

    attachInstance(ref, anchorname) {
        return this.atachInstance(
            ref,
            anchorname
        );
    }

    _updateInstanceScale(ref) {
        if (!ref.parent) {
            return;
        }

        ref.parent.updateWorldMatrix(true, false);

        const parentScale = ref.parent.getWorldScale(
            new THREE.Vector3()
        );

        const originScale = this.origin.getWorldScale(
            new THREE.Vector3()
        );

        ref.scale.set(
            originScale.x / parentScale.x,
            originScale.y / parentScale.y,
            originScale.z / parentScale.z
        );
    }

    detachInstance(ref) {
        ref.updateWorldMatrix(true, false);

        const matrix = ref.matrixWorld.clone();

        ref.removeFromParent();

        matrix.decompose(
            ref.position,
            ref.quaternion,
            ref.scale
        );

        return ref;
    }

    removeInstance(ref) {
        if (!this.instances.delete(ref)) {
            throw new Error(
                "Unknown instance."
            );
        }

        ref.removeFromParent();

        ref.traverse(object => {
            if (object.isSkinnedMesh) {
                object.skeleton.dispose();
            }
        });
    }

    getOriginTransform() {
        return this.origin;
    }

    getEyesTransforms() {
        return this.eyes;
    }

    getSkinNames() {
        return [...this.skin.keys()];
    }

    getAccessoriesNames() {
        return [...this.accessories.keys()];
    }

    getAnimationsNames() {
        return [...this.actions.keys()];
    }

    getHandPoseNames() {
        return [...this.handPoses.keys()];
    }

    getInstances() {
        return [...this.instances];
    }

    _save(bone) {
        if (this._saved.has(bone)) {
            return;
        }

        this._saved.set(bone, {
            position: bone.position.clone(),
            quaternion: bone.quaternion.clone(),
            scale: bone.scale.clone()
        });
    }

    _restore() {
        for (const [bone, state] of this._saved) {
            bone.position.copy(
                state.position
            );

            bone.quaternion.copy(
                state.quaternion
            );

            bone.scale.copy(
                state.scale
            );
        }

        this._saved.clear();
    }

    _transform(value) {
        if (value?.isObject3D) {
            return {
                position: value.getWorldPosition(
                    new THREE.Vector3()
                ),
                quaternion: value.getWorldQuaternion(
                    new THREE.Quaternion()
                )
            };
        }

        if (value?.isMatrix4) {
            const position = new THREE.Vector3();
            const quaternion = new THREE.Quaternion();

            value.decompose(
                position,
                quaternion,
                new THREE.Vector3()
            );

            return {
                position,
                quaternion
            };
        }

        const position = value.position?.isVector3
            ? value.position.clone()
            : new THREE.Vector3().fromArray(
                value.position
            );

        const quaternion = value.quaternion?.isQuaternion
            ? value.quaternion.clone()
            : new THREE.Quaternion().fromArray(
                value.quaternion
            );

        return {
            position,
            quaternion: quaternion.normalize()
        };
    }

    _pole(name, axis, rootPosition, middlePosition) {
        const poleObject = this.poles.get(name);

        const pole = poleObject
            ? poleObject.getWorldPosition(
                new THREE.Vector3()
            ).sub(rootPosition)
            : middlePosition.clone().sub(rootPosition);

        pole.addScaledVector(
            axis,
            -pole.dot(axis)
        );

        if (pole.lengthSq() < EPSILON) {
            pole.set(0, 0, 1);
            pole.addScaledVector(
                axis,
                -axis.z
            );
        }

        if (pole.lengthSq() < EPSILON) {
            pole.set(1, 0, 0);
            pole.addScaledVector(
                axis,
                -axis.x
            );
        }

        return pole.normalize();
    }

    _rotateTo(bone, origin, current, desired) {
        const from = current
            .clone()
            .sub(origin)
            .normalize();

        const to = desired
            .clone()
            .sub(origin)
            .normalize();

        if (
            from.lengthSq() < EPSILON ||
            to.lengthSq() < EPSILON
        ) {
            return;
        }

        this._save(bone);

        const delta = new THREE.Quaternion()
            .setFromUnitVectors(from, to);

        const world = bone.getWorldQuaternion(
            new THREE.Quaternion()
        );

        const parent = bone.parent.getWorldQuaternion(
            new THREE.Quaternion()
        );

        bone.quaternion
            .copy(parent.invert())
            .multiply(delta)
            .multiply(world)
            .normalize();

        bone.updateWorldMatrix(true, true);
    }

    _solve(key, targetPosition, targetRotation, poleName) {
        const [root, middle, end] = this.chains.get(key);

        const a = root.getWorldPosition(
            new THREE.Vector3()
        );

        const b = middle.getWorldPosition(
            new THREE.Vector3()
        );

        const c = end.getWorldPosition(
            new THREE.Vector3()
        );

        const upper = a.distanceTo(b);
        const lower = b.distanceTo(c);

        if (
            upper < EPSILON ||
            lower < EPSILON
        ) {
            return;
        }

        const axis = targetPosition
            .clone()
            .sub(a);

        const requested = axis.length();

        if (requested < EPSILON) {
            axis.set(0, -1, 0);
        } else {
            axis.divideScalar(requested);
        }

        const minimum = Math.abs(upper - lower);
        const maximum = upper + lower;

        const distance = THREE.MathUtils.clamp(
            requested,
            minimum + EPSILON,
            Math.max(
                minimum + EPSILON,
                maximum - EPSILON
            )
        );

        const desiredEnd = a
            .clone()
            .addScaledVector(axis, distance);

        const pole = this._pole(
            poleName,
            axis,
            a,
            b
        );

        const along = (
            upper * upper -
            lower * lower +
            distance * distance
        ) / (2 * distance);

        const height = Math.sqrt(
            Math.max(
                0,
                upper * upper - along * along
            )
        );

        const desiredMiddle = a
            .clone()
            .addScaledVector(axis, along)
            .addScaledVector(pole, height);

        this._rotateTo(
            root,
            a,
            b,
            desiredMiddle
        );

        this._rotateTo(
            middle,
            middle.getWorldPosition(
                new THREE.Vector3()
            ),
            end.getWorldPosition(
                new THREE.Vector3()
            ),
            desiredEnd
        );

        if (targetRotation) {
            this._save(end);

            const parent = end.parent.getWorldQuaternion(
                new THREE.Quaternion()
            );

            end.quaternion
                .copy(parent.invert())
                .multiply(targetRotation)
                .normalize();

            end.updateWorldMatrix(true, true);
        }
    }

    _applyHips() {
        const displacement = new THREE.Vector3(
            0,
            this.hipsHeight,
            0
        ).applyQuaternion(
            this.root.getWorldQuaternion(
                new THREE.Quaternion()
            )
        );

        this._save(this.hips);

        const previous = this.hips.getWorldPosition(
            new THREE.Vector3()
        );

        this.hips.parent.updateWorldMatrix(
            true,
            false
        );

        this.hips.position.copy(
            this.hips.parent.worldToLocal(
                previous.clone().add(displacement)
            )
        );

        this.hips.updateWorldMatrix(true, true);

        this._hipTarget.position.fromArray(
            this.metadata.ik.hipPosition
        );

        this._hipTarget.position.y +=
            this.hipsHeight /
            this.root.getWorldScale(
                new THREE.Vector3()
            ).y;
    }

    _applyHead() {
        if (!this.headRotation) {
            return;
        }

        this._save(this.head);

        const rootWorld = this.root.getWorldQuaternion(
            new THREE.Quaternion()
        );

        const parentWorld = this.head.parent.getWorldQuaternion(
            new THREE.Quaternion()
        );

        this.head.quaternion
            .copy(parentWorld.invert())
            .multiply(rootWorld)
            .multiply(this.headRotation)
            .normalize();

        this.head.updateWorldMatrix(true, true);
    }

    _applyHandPoses(delta) {
        for (const side of SIDES) {
            const state = this.poseState[side];

            state.elapsed += delta;

            const ratio = state.duration > 0
                ? Math.min(
                    1,
                    state.elapsed / state.duration
                )
                : 1;

            const pose = state.name
                ? this.handPoses.get(state.name)
                : null;

            for (const [joint, { bone, reference }] of this.fingers[side]) {
                if (!pose && ratio === 1) {
                    continue;
                }

                const destination = pose
                    ? reference.clone()
                        .multiply(
                            new THREE.Quaternion().fromArray(
                                pose[side][joint]
                            )
                        )
                        .normalize()
                    : bone.quaternion.clone();

                this._save(bone);

                bone.quaternion.copy(
                    state.from
                        ? state.from.get(joint)
                            .clone()
                            .slerp(destination, ratio)
                        : destination
                );
            }

            if (ratio === 1) {
                state.from = null;
            }
        }
    }

    update(delta) {
        if (!this.model) {
            return;
        }

        // Restore the previous animation-owned transforms.
        this._restore();

        this.mixer.update(delta);
        this.origin.updateWorldMatrix(true, true);

        if (this.hipsHeight !== 0) {
            const feet = {};

            for (const side of SIDES) {
                const end = this.chains.get(
                    `${side}Leg`
                )[2];

                feet[side] = {
                    position: end.getWorldPosition(
                        new THREE.Vector3()
                    ),
                    quaternion: end.getWorldQuaternion(
                        new THREE.Quaternion()
                    )
                };
            }

            this._applyHips();

            for (const side of SIDES) {
                this._solve(
                    `${side}Leg`,
                    feet[side].position,
                    feet[side].quaternion,
                    `${side}Knee`
                );
            }
        }

        for (const side of SIDES) {
            if (this.handTargets[side]) {
                const target = this._transform(
                    this.handTargets[side]
                );

                this._solve(
                    `${side}Arm`,
                    target.position,
                    target.quaternion,
                    `${side}Elbow`
                );
            }
        }

        this._applyHead();
        this._applyHandPoses(delta);

        this.origin.updateWorldMatrix(true, true);

        for (const instance of this.instances) {
            if (
                instance.parent &&
                instance.parent.userData.avatarAnchor
            ) {
                this._updateInstanceScale(instance);
            }
        }
    }
}