import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import IKController from "./IKController.js";

const EPSILON = 1e-6;
const AVATAR_HEIGHT = 1.75;

const DEFAULT_AVATAR = {
    type: "default"
};

const DEFAULT_ANIMATIONS = [
    { name: "idle", type: "default" },
    { name: "walk", type: "default" }
];

const DEFAULT_CAMERA = {
    position: [2.45, 1.925, 3.15],
    target: [0, 0.875, 0]
};

const DEFAULT_METADATA = {
    avatarHeight: AVATAR_HEIGHT,
    anchors: [],
    assets: [],
    handPoses: [],
    ik: {},
    cameraAnchor: null
};

function cloneData(value) {
    return structuredClone(value);
}

function normalizeBoneName(name) {
    return name
        .replace(/^.*[|:]/, "")
        .replace(/^mixamorig\d*/i, "")
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase();
}

function collectBones(object) {
    const result = new Map();

    object.traverse(child => {
        if (!child.isBone) return;

        const name = normalizeBoneName(child.name);

        if (!result.has(name)) {
            result.set(name, child);
        }
    });

    return result;
}

function resolveGLBSkeleton(avatar) {
    const allBones = [];
    const skinBones = new Set();

    avatar.traverse(object => {
        if (object.isBone) {
            allBones.push(object);
        }

        if (object.isSkinnedMesh && object.skeleton) {
            for (const bone of object.skeleton.bones) {
                skinBones.add(bone);
            }
        }
    });

    const matches = (bone, name) => {
        const actual = normalizeBoneName(bone.name);
        const expected = normalizeBoneName(name);

        return actual === expected ||
            (
                actual.startsWith(expected) &&
                /^\d+$/.test(actual.slice(expected.length))
            );
    };

    const distance = (ancestor, bone) => {
        let depth = 0;
        let current = bone;

        while (current && current !== ancestor) {
            current = current.parent;
            depth++;
        }

        return current === ancestor ? depth : Infinity;
    };

    const descendants = (ancestor, name) => {
        return allBones.filter(bone => {
            return bone !== ancestor &&
                matches(bone, name) &&
                Number.isFinite(distance(ancestor, bone));
        });
    };

    const quality = (bone, name) => {
        return (skinBones.has(bone) ? 100 : 0) +
            (normalizeBoneName(bone.name) ===
                normalizeBoneName(name) ? 10 : 0);
    };

    const getChain = (hips, names) => {
        let result = null;
        let bestScore = -Infinity;

        for (const first of descendants(hips, names[0])) {
            for (const middle of descendants(first, names[1])) {
                for (const last of descendants(middle, names[2])) {
                    const score =
                        quality(first, names[0]) +
                        quality(middle, names[1]) +
                        quality(last, names[2]) -
                        distance(hips, first) -
                        distance(first, middle) -
                        distance(middle, last);

                    if (score > bestScore) {
                        bestScore = score;
                        result = [first, middle, last];
                    }
                }
            }
        }

        return {
            bones: result,
            score: bestScore
        };
    };

    const chains = {
        leftArm: ["LeftArm", "LeftForeArm", "LeftHand"],
        rightArm: ["RightArm", "RightForeArm", "RightHand"],
        leftLeg: ["LeftUpLeg", "LeftLeg", "LeftFoot"],
        rightLeg: ["RightUpLeg", "RightLeg", "RightFoot"]
    };

    const roots = allBones.filter(bone => matches(bone, "root"));
    const hipsCandidates = allBones.filter(bone => matches(bone, "Hips"));

    let selected = null;
    let bestScore = -Infinity;

    for (const root of roots) {
        for (const hips of hipsCandidates) {
            if (root === hips || Number.isFinite(distance(hips, root))) {
                continue;
            }

            const resolvedChains = {};
            let score = 0;
            let valid = true;

            for (const [key, names] of Object.entries(chains)) {
                const result = getChain(hips, names);

                if (!result.bones) {
                    valid = false;
                    break;
                }

                resolvedChains[key] = result.bones;
                score += result.score;
            }

            if (!valid) {
                continue;
            }

            if (Number.isFinite(distance(root, hips))) {
                score += 1000;
            }

            score += quality(root, "root");
            score += quality(hips, "Hips");

            if (score > bestScore) {
                bestScore = score;
                selected = {
                    root,
                    hips,
                    chains: resolvedChains
                };
            }
        }
    }

    if (!selected) {
        console.table(
            allBones.map(bone => ({
                name: bone.name,
                parent: bone.parent?.name ?? "",
                skinJoint: skinBones.has(bone)
            }))
        );

        throw new Error(
            "Invalid GLB skeleton: no complete, connected Mixamo IK hierarchy found."
        );
    }

    const rigRoot = selected.root;
    const hips = selected.hips;

    if (hips.parent !== rigRoot) {
        avatar.updateWorldMatrix(true, true);

        const previousParent = hips.parent?.name ?? "unknown";

        rigRoot.attach(hips);

        avatar.updateWorldMatrix(true, true);

        console.warn(
            `GLB skeleton normalized: ${hips.name} moved from "${previousParent}" to "${rigRoot.name}".`
        );
    }

    // Prefer bones from the selected coherent skeleton branch.
    const bones = collectBones(avatar);

    for (const [name, bone] of collectBones(hips)) {
        bones.set(name, bone);
    }

    bones.set("root", rigRoot);
    bones.set("hips", hips);

    for (const [key, names] of Object.entries(chains)) {
        const resolved = selected.chains[key];

        for (let i = 0; i < names.length; i++) {
            bones.set(
                normalizeBoneName(names[i]),
                resolved[i]
            );
        }
    }

    // Finger joints must belong to the selected hand hierarchy.
    for (const side of ["Left", "Right"]) {
        const hand = bones.get(normalizeBoneName(`${side}Hand`));

        if (!hand) {
            continue;
        }

        for (const finger of [
            "Thumb",
            "Index",
            "Middle",
            "Ring",
            "Pinky"
        ]) {
            let parent = hand;

            for (let index = 1; index <= 3; index++) {
                const name = `${side}Hand${finger}${index}`;

                const candidates = descendants(parent, name);

                candidates.sort((a, b) => {
                    const scoreA =
                        quality(a, name) - distance(parent, a);

                    const scoreB =
                        quality(b, name) - distance(parent, b);

                    return scoreB - scoreA;
                });

                const bone = candidates[0];

                if (!bone) {
                    break;
                }

                bones.set(normalizeBoneName(name), bone);
                parent = bone;
            }
        }
    }

    validateSkeleton(bones);

    return {
        bones,
        root: rigRoot
    };
}

function normalizeMixamoNames(object) {
    object.traverse(child => {
        if (!child.isBone) return;

        child.name = child.name
            .replace(/^.*[|:]/, "")
            .replace(/^mixamorig\d*/i, "")
            .replace(/[^a-zA-Z0-9]/g, "");
    });
}

function hasSkinnedMesh(object) {
    let found = false;

    object.traverse(child => {
        if (child.isSkinnedMesh) {
            found = true;
        }
    });

    return found;
}

function hasMesh(object) {
    let found = false;

    object.traverse(child => {
        if (child.isMesh) {
            found = true;
        }
    });

    return found;
}

function validateSkeleton(bones) {
    const required = [
        "hips",
        "head",
        "leftupleg",
        "leftleg",
        "leftfoot",
        "rightupleg",
        "rightleg",
        "rightfoot",
        "leftarm",
        "leftforearm",
        "lefthand",
        "rightarm",
        "rightforearm",
        "righthand"
    ];

    const missing = required.filter(name => !bones.has(name));

    if (missing.length) {
        throw new Error(`Missing Mixamo bones: ${missing.join(", ")}`);
    }

    const chains = [
        ["leftupleg", "leftleg", "leftfoot"],
        ["rightupleg", "rightleg", "rightfoot"],
        ["leftarm", "leftforearm", "lefthand"],
        ["rightarm", "rightforearm", "righthand"]
    ];

    for (const chain of chains) {
        for (let i = 1; i < chain.length; i++) {
            let parent = bones.get(chain[i]).parent;
            let valid = false;

            while (parent) {
                if (parent === bones.get(chain[i - 1])) {
                    valid = true;
                    break;
                }

                parent = parent.parent;
            }

            if (!valid) {
                throw new Error(`Invalid IK hierarchy: ${chain.join(" -> ")}`);
            }
        }
    }
}

function measureSkeleton(object) {
    object.updateWorldMatrix(true, true);

    const bones = collectBones(object);

    validateSkeleton(bones);

    const bounds = new THREE.Box3().makeEmpty();
    const point = new THREE.Vector3();

    for (const bone of bones.values()) {
        bone.getWorldPosition(point);
        bounds.expandByPoint(point);
    }

    const height = bounds.max.y - bounds.min.y;

    if (!Number.isFinite(height) || height <= EPSILON) {
        throw new Error("Invalid Mixamo skeleton height.");
    }

    return {
        height,
        ground: bounds.min.y
    };
}

function prepareFBXAvatar(model) {
    if (!hasSkinnedMesh(model)) {
        throw new Error("The FBX does not contain a skinned avatar.");
    }

    normalizeMixamoNames(model);

    const sourceBones = collectBones(model);
    const hips = sourceBones.get("hips");

    const { height, ground } = measureSkeleton(model);
    const factor = AVATAR_HEIGHT / height;

    const avatar = new THREE.Group();

    avatar.name = "Avatar";

    const root = new THREE.Bone();

    root.name = "root";
    root.position.set(0, 0, 0);
    root.scale.set(1, 1, 1);

    avatar.add(root);

    // Scale the visual geometry and skeleton consistently.
    // Root always remains at scale (1, 1, 1).
    const originalModelY = model.position.y;

    model.scale.multiplyScalar(factor);

    model.position.y -= (
        originalModelY +
        factor * (ground - originalModelY)
    );

    model.name = "Visual";

    root.add(model);
    avatar.updateWorldMatrix(true, true);

    // Preserve the Hips world transform while separating
    // the skeleton from the visual hierarchy.
    // The normalization scale is now carried by Hips.
    root.attach(hips);

    if (
        sourceBones.has("root") &&
        sourceBones.get("root") !== root
    ) {
        sourceBones.get("root").name = "SourceRoot";
    }

    avatar.updateWorldMatrix(true, true);

    // Preserve the FBX skinning bindings.
    // Bone inverse matrices must not be recalculated here.
    avatar.traverse(child => {
        if (child.isSkinnedMesh) {
            child.frustumCulled = false;
        }
    });

    avatar.userData.avatarCreator = {
        version: 3,
        normalized: true,
        skeletonHeight: AVATAR_HEIGHT,
        sourceSkeletonHeight: height,
        normalizationFactor: factor,
        skeleton: "mixamo"
    };

    return {
        object: avatar,
        bones: collectBones(avatar),
        root,
        normalizationFactor: factor
    };
}

function boneDistance(a, b) {
    if (!a || !b) {
        return 0;
    }

    return a.getWorldPosition(
        new THREE.Vector3()
    ).distanceTo(
        b.getWorldPosition(new THREE.Vector3())
    );
}

function retargetAnimation(sourceClip, sourceObject, targetBones, name) {
    const sourceBones = collectBones(sourceObject);

    const sourceLength = boneDistance(
        sourceBones.get("leftupleg"),
        sourceBones.get("leftleg")
    );

    const targetLength = boneDistance(
        targetBones.get("leftupleg"),
        targetBones.get("leftleg")
    );

    const motionScale = sourceLength > EPSILON
        ? targetLength / sourceLength
        : 1;

    const targetHips = targetBones.get("hips");
    const hipRest = targetHips.position.clone();

    const quaternion = new THREE.Quaternion();
    const tracks = [];

    for (const sourceTrack of sourceClip.tracks) {
        const separator = sourceTrack.name.lastIndexOf(".");

        if (separator < 0) {
            continue;
        }

        let sourceName = sourceTrack.name.slice(0, separator);
        const property = sourceTrack.name.slice(separator + 1);

        const boneMatch = sourceName.match(/\.bones\[([^\]]+)\]/);

        if (boneMatch) {
            sourceName = boneMatch[1];
        }

        const boneName = normalizeBoneName(sourceName);
        const targetBone = targetBones.get(boneName);

        if (!targetBone) {
            continue;
        }

        if (property === "quaternion") {
            const track = sourceTrack.clone();

            track.name = `${targetBone.uuid}.quaternion`;

            const sourceBone = sourceBones.get(boneName);

            const isArmBone =
                /^(left|right)(shoulder|arm|forearm|hand)/.test(boneName);

            if (sourceBone && !isArmBone) {
                const offset = targetBone.quaternion
                    .clone()
                    .multiply(
                        sourceBone.quaternion.clone().invert()
                    );

                for (let i = 0; i < track.values.length; i += 4) {
                    quaternion
                        .fromArray(track.values, i)
                        .premultiply(offset)
                        .normalize()
                        .toArray(track.values, i);
                }
            }

            tracks.push(track);
        } else if (
            property === "position" &&
            targetBone === targetHips
        ) {
            const track = sourceTrack.clone();

            track.name = `${targetBone.uuid}.position`;

            const [baseX, baseY, baseZ] = track.values;

            for (let i = 0; i < track.values.length; i += 3) {
                track.values[i] =
                    hipRest.x +
                    (track.values[i] - baseX) * motionScale;

                track.values[i + 1] =
                    hipRest.y +
                    (track.values[i + 1] - baseY) * motionScale;

                track.values[i + 2] =
                    hipRest.z +
                    (track.values[i + 2] - baseZ) * motionScale;
            }

            tracks.push(track);
        }
    }

    if (!tracks.length) {
        throw new Error(
            `No compatible animation tracks in "${name}".`
        );
    }

    return new THREE.AnimationClip(
        name,
        sourceClip.duration,
        tracks
    );
}


class AvatarDatabase {
    constructor() {
        this.ready = new Promise((resolve, reject) => {
            const request = indexedDB.open("avatar-creator", 1);

            request.onupgradeneeded = () => {
                const database = request.result;

                if (!database.objectStoreNames.contains("files")) {
                    database.createObjectStore("files");
                }

                if (!database.objectStoreNames.contains("settings")) {
                    database.createObjectStore("settings");
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);

            request.onblocked = () => {
                reject(new Error("IndexedDB is blocked."));
            };
        });
    }

    async request(store, mode, operation) {
        const database = await this.ready;

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(store, mode);
            const request = operation(transaction.objectStore(store));

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    get(store, key) {
        return this.request(
            store,
            "readonly",
            objectStore => objectStore.get(key)
        );
    }

    put(store, key, value) {
        return this.request(
            store,
            "readwrite",
            objectStore => objectStore.put(value, key)
        );
    }

    async saveFile(file) {
        const id = crypto.randomUUID();

        await this.put("files", id, file);

        return id;
    }

    getFile(id) {
        return this.get("files", id);
    }

    deleteFile(id) {
        return this.request(
            "files",
            "readwrite",
            objectStore => objectStore.delete(id)
        );
    }

    async clear() {
        const database = await this.ready;

        return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                ["files", "settings"],
                "readwrite"
            );

            transaction.objectStore("files").clear();
            transaction.objectStore("settings").clear();

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }
}

export default class AvatarSession extends EventTarget {
    constructor() {
        super();

        this.database = new AvatarDatabase();
        this.scene = new THREE.Scene();

        const styles = getComputedStyle(document.documentElement);
        const color = name => styles.getPropertyValue(name).trim();

        this.scene.background = new THREE.Color(
            color("--scene-background")
        );

        this.scene.add(
            new THREE.HemisphereLight(
                0xffffff,
                0x44516b,
                2.2
            )
        );

        const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);

        keyLight.position.set(2, 4, 3);
        this.scene.add(keyLight);

        const fillLight = new THREE.DirectionalLight(0xffffff, 1);

        fillLight.position.set(-2, 2, -3);
        this.scene.add(fillLight);

        const gridSize = 10;
        const gridDivisions = 20;
        const gridHalfSize = gridSize / 2;
        const gridStep = gridSize / gridDivisions;

        const gridPositions = [];

        for (let i = 0; i <= gridDivisions; i++) {
            const coordinate = -gridHalfSize + i * gridStep;

            // The two central grid lines are replaced by colored axes.
            if (Math.abs(coordinate) < 1e-8) {
                continue;
            }

            gridPositions.push(
                -gridHalfSize, 0, coordinate,
                gridHalfSize, 0, coordinate
            );

            gridPositions.push(
                coordinate, 0, -gridHalfSize,
                coordinate, 0, gridHalfSize
            );
        }

        const gridGeometry = new THREE.BufferGeometry();

        gridGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(gridPositions, 3)
        );

        const gridMaterial = new THREE.LineBasicMaterial({
            color: color("--scene-grid-minor"),
            toneMapped: false
        });

        const grid = new THREE.LineSegments(
            gridGeometry,
            gridMaterial
        );

        grid.name = "GroundGrid";

        this.scene.add(grid);

        // Explicit ground axes.
        const axisXColor = new THREE.Color(
            color("--scene-axis-x")
        );

        const axisZColor = new THREE.Color(
            color("--scene-axis-z")
        );

        const axesGeometry = new THREE.BufferGeometry();

        axesGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute([
                -gridHalfSize, 0.001, 0,
                gridHalfSize, 0.001, 0,
                0, 0.001, -gridHalfSize,
                0, 0.001, gridHalfSize
            ], 3)
        );

        axesGeometry.setAttribute(
            "color",
            new THREE.Float32BufferAttribute([
                ...axisXColor.toArray(),
                ...axisXColor.toArray(),
                ...axisZColor.toArray(),
                ...axisZColor.toArray()
            ], 3)
        );

        const axesMaterial = new THREE.LineBasicMaterial({
            vertexColors: true,
            toneMapped: false,
            depthWrite: false
        });

        const groundAxes = new THREE.LineSegments(
            axesGeometry,
            axesMaterial
        );

        groundAxes.name = "GroundAxes";

        this.scene.add(groundAxes);

        grid.position.y = -0.002;
        this.scene.add(grid);

        this.avatar = null;
        this.rigRoot = null;
        this.bones = new Map();

        this.normalizationFactor = 1;
        this.legacyReferenceScale = 1;

        this.mixer = null;
        this.clips = new Map();
        this.currentAction = null;

        this.avatarSource = cloneData(DEFAULT_AVATAR);
        this.animationSources = cloneData(DEFAULT_ANIMATIONS);

        this.selectedAnimation = null;
        this.playing = true;

        this.cameraState = cloneData(DEFAULT_CAMERA);
        this.metadata = cloneData(DEFAULT_METADATA);

        this.beforeAnimation = null;
        this.afterAnimation = null;

        this.error = null;
        this.saveQueue = Promise.resolve();

        this.ik = new IKController(this);
    }

    async initialize() {
        const saved = await this.database.get("settings", "current");
        const camera = await this.database.get("settings", "camera");

        if (saved?.version === 1) {
            this.avatarSource = saved.avatar;
            this.animationSources = saved.animations;
            this.playing = saved.playing !== false;

            this.metadata = saved.metadata ??
                cloneData(DEFAULT_METADATA);
        }

        if (camera?.position && camera?.target) {
            this.cameraState = cloneData(camera);
        }

        const previousHeight = Number(
            saved?.metadata?.avatarHeight
        ) || 1;

        if (
            saved?.version === 1 &&
            Math.abs(previousHeight - AVATAR_HEIGHT) > EPSILON
        ) {
            const ratio = AVATAR_HEIGHT / previousHeight;

            const scalePosition = position => {
                if (!Array.isArray(position) || position.length !== 3) {
                    return position;
                }

                return position.map(value => value * ratio);
            };

            const ik = this.metadata.ik;

            if (ik?.version === 3) {
                // Version 3 IK coordinates use normalized skeleton units.
                ik.hipsHeight = (ik.hipsHeight || 0) * ratio;
                ik.hipPosition = scalePosition(ik.hipPosition);

                for (const side of ["left", "right"]) {
                    if (ik.hands?.[side]) {
                        ik.hands[side].position = scalePosition(
                            ik.hands[side].position
                        );
                    }
                }

                for (const name of [
                    "leftElbow",
                    "rightElbow",
                    "leftKnee",
                    "rightKnee"
                ]) {
                    if (ik.poles?.[name]) {
                        ik.poles[name] = scalePosition(
                            ik.poles[name]
                        );
                    }
                }
            }

            // Legacy IK version 2 remains in raw FBX units.
            // It will be converted using legacyReferenceScale below.
            if (this.metadata.cameraAnchor?.position) {
                this.metadata.cameraAnchor.position = scalePosition(
                    this.metadata.cameraAnchor.position
                );
            }

            if (camera?.position && camera?.target) {
                this.cameraState.position = scalePosition(
                    this.cameraState.position
                );

                this.cameraState.target = scalePosition(
                    this.cameraState.target
                );

                await this.database.put(
                    "settings",
                    "camera",
                    cloneData(this.cameraState)
                );
            }

            this.metadata.avatarHeight = AVATAR_HEIGHT;

            await this.database.put(
                "settings",
                "current",
                {
                    ...saved,
                    metadata: cloneData(this.metadata)
                }
            );
        }

        const referenceModel = await this.loadFBX(DEFAULT_AVATAR);

        const referenceBounds = new THREE.Box3().setFromObject(
            referenceModel,
            true
        );

        const referenceHeight = referenceBounds.getSize(
            new THREE.Vector3()
        ).y;

        if (referenceHeight <= EPSILON) {
            throw new Error("Invalid default avatar mesh height.");
        }

        // Convert old raw FBX IK coordinates directly to 1.75 m units.
        this.legacyReferenceScale = AVATAR_HEIGHT / referenceHeight;

        const prepared = this.avatarSource.type === "default"
            ? { model: referenceModel }
            : {};

        await this.rebuild(
            this.avatarSource,
            this.animationSources,
            saved?.selectedAnimation ?? "idle",
            prepared
        );
    }

    async loadFBX(source) {
        let buffer;
        let resourcePath = "";

        if (source.type === "default") {
            const filename = source.name
                ? `${source.name}.fbx`
                : "avatar.fbx";

            const url = new URL(
                `../fbx/${filename}`,
                import.meta.url
            );

            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(
                    `Failed to load ${filename}: ${response.status}`
                );
            }

            buffer = await response.arrayBuffer();
            resourcePath = new URL("../fbx/", import.meta.url).href;
        } else {
            const file = await this.database.getFile(source.id);

            if (!file) {
                throw new Error(
                    `Missing stored FBX file: ${source.id}`
                );
            }

            buffer = await file.arrayBuffer();
        }

        return new FBXLoader().parse(buffer, resourcePath);
    }

    async loadGLB(source) {
        const file = await this.database.getFile(source.id);

        if (!file) {
            throw new Error(
                `Missing stored GLB file: ${source.id}`
            );
        }

        const buffer = new Uint8Array(
            await file.arrayBuffer()
        ).slice().buffer;

        return new GLTFLoader().parseAsync(
            buffer,
            ""
        );
    }

    async rebuild(avatarSource, animationSources, selectedAnimation, prepared = {}) {
        let root;
        let bones;
        let rigRoot;
        let normalizationFactor = 1;
        let embeddedAnimations = [];

        if (avatarSource.type === "glb") {
            const gltf = prepared.gltf ??
                await this.loadGLB(avatarSource);

            root = gltf.scene;

            if (!hasMesh(root)) {
                throw new Error(
                    "The GLB contains no renderable mesh."
                );
            }

            const resolved = resolveGLBSkeleton(root);

            bones = resolved.bones;
            rigRoot = resolved.root;

            embeddedAnimations = gltf.animations ?? [];
        } else {
            const source = prepared.model ??
                await this.loadFBX(avatarSource);

            const result = prepareFBXAvatar(source);

            root = result.object;
            bones = result.bones;
            rigRoot = result.root;

            normalizationFactor = result.normalizationFactor;
        }

        const clips = new Map();

        for (let i = 0; i < embeddedAnimations.length; i++) {
            const original = embeddedAnimations[i];
            const name = original.name || `animation-${i + 1}`;
            const clip = original.clone();

            clip.name = name;

            if (clips.has(name)) {
                throw new Error(
                    `Duplicate animation name: ${name}`
                );
            }

            clips.set(name, clip);
        }

        for (const source of animationSources) {
            const object = await this.loadFBX(source);

            if (!object.animations.length) {
                throw new Error(
                    `The FBX animation "${source.name}" is empty.`
                );
            }

            if (clips.has(source.name)) {
                throw new Error(
                    `Duplicate animation name: ${source.name}`
                );
            }

            clips.set(
                source.name,
                retargetAnimation(
                    object.animations[0],
                    object,
                    bones,
                    source.name
                )
            );
        }

        if (this.mixer) {
            this.mixer.stopAllAction();

            if (this.avatar) {
                this.mixer.uncacheRoot(this.avatar);
            }
        }

        if (this.avatar) {
            this.scene.remove(this.avatar);
        }

        this.avatar = root;
        this.rigRoot = rigRoot;
        this.bones = bones;

        this.normalizationFactor = normalizationFactor;
        this.clips = clips;

        this.scene.add(root);

        this.mixer = new THREE.AnimationMixer(root);
        this.currentAction = null;
        this.selectedAnimation = null;

        this.avatarSource = cloneData(avatarSource);
        this.animationSources = cloneData(animationSources);

        const first = clips.keys().next().value;

        const selection = clips.has(selectedAnimation)
            ? selectedAnimation
            : clips.has("idle")
                ? "idle"
                : first;

        if (selection) {
            this.setAnimation(selection, false);
        }

        this.error = null;
        this.notify();
    }

    async importFBX(file) {
        if (!file.name.toLowerCase().endsWith(".fbx")) {
            throw new Error("Expected an FBX file.");
        }

        const object = new FBXLoader().parse(
            await file.arrayBuffer(),
            ""
        );

        const containsAvatar = hasSkinnedMesh(object);
        const containsAnimation = object.animations.length > 0;

        if (!containsAvatar && !containsAnimation) {
            throw new Error(
                "The FBX contains neither an avatar nor an animation."
            );
        }

        if (containsAvatar) {
            validateSkeleton(collectBones(object));
        }

        const id = await this.database.saveFile(file);

        const nextAvatar = containsAvatar
            ? { type: "fbx", id }
            : this.avatarSource;

        const nextAnimations = cloneData(this.animationSources);

        let animationName = this.selectedAnimation;

        if (containsAnimation) {
            const baseName = file.name
                .replace(/\.[^.]+$/, "")
                .trim();

            animationName = this.uniqueAnimationName(baseName);

            nextAnimations.push({
                name: animationName,
                type: "fbx",
                id
            });
        }

        // Use the same loading path as a page reload.
        await this.rebuild(
            nextAvatar,
            nextAnimations,
            animationName
        );

        await this.persist();

        return {
            avatar: containsAvatar,
            animation: containsAnimation,
            name: animationName
        };
    }

    async importGLB(file) {
        if (!file.name.toLowerCase().endsWith(".glb")) {
            throw new Error("Expected a GLB file.");
        }

        const buffer = new Uint8Array(
            await file.arrayBuffer()
        ).slice().buffer;

        const gltf = await new GLTFLoader().parseAsync(
            buffer,
            ""
        );

        if (!hasMesh(gltf.scene)) {
            throw new Error(
                "The GLB contains no renderable avatar mesh."
            );
        }

        const manifest = gltf.scene.userData?.avatarCreator;

        const isAvatarCreatorPackage =
            manifest?.format === "avatar-creator";

        if (
            isAvatarCreatorPackage &&
            manifest.version !== 1
        ) {
            throw new Error(
                `Unsupported Avatar Creator GLB version: ${manifest.version}`
            );
        }

        let metadata = cloneData(DEFAULT_METADATA);

        if (isAvatarCreatorPackage) {
            if (
                !manifest.metadata ||
                typeof manifest.metadata !== "object" ||
                !Array.isArray(manifest.metadata.assets)
            ) {
                throw new Error(
                    "Invalid Avatar Creator metadata."
                );
            }

            if (!collectBones(gltf.scene).has("root")) {
                throw new Error(
                    "The exported avatar has no root bone."
                );
            }

            const assetIds = new Set();

            for (const scene of gltf.scenes) {
                scene.traverse(object => {
                    const id = object.userData?.avatarAssetId;

                    if (typeof id === "string") {
                        assetIds.add(id);
                    }
                });
            }

            for (const record of manifest.metadata.assets) {
                if (
                    !record ||
                    typeof record.id !== "string" ||
                    !assetIds.has(record.id)
                ) {
                    throw new Error(
                        `Missing exported asset: ${record?.name ?? record?.id ?? "unknown"}`
                    );
                }
            }

            metadata = {
                ...metadata,
                ...cloneData(manifest.metadata)
            };
        }

        const previousMetadata = this.metadata;
        const previousPlaying = this.playing;
        const previousCamera = this.cameraState;

        const id = await this.database.saveFile(file);

        if (isAvatarCreatorPackage) {
            metadata.assets = metadata.assets.map(record => ({
                ...record,
                fileId: id,
                type: "glb"
            }));
        }

        try {
            this.metadata = metadata;

            if (isAvatarCreatorPackage) {
                this.playing = manifest.playing !== false;
            }

            const selection = isAvatarCreatorPackage
                ? manifest.selectedAnimation
                : this.selectedAnimation;

            await this.rebuild(
                { type: "glb", id },
                [],
                selection,
                { gltf }
            );

            const camera = manifest?.cameraState;

            const validCamera = value => {
                return Array.isArray(value) &&
                    value.length === 3 &&
                    value.every(Number.isFinite);
            };

            if (
                isAvatarCreatorPackage &&
                validCamera(camera?.position) &&
                validCamera(camera?.target)
            ) {
                this.cameraState = cloneData(camera);

                await this.database.put(
                    "settings",
                    "camera",
                    cloneData(camera)
                );
            }

            await this.persist();
        } catch (error) {
            this.metadata = previousMetadata;
            this.playing = previousPlaying;
            this.cameraState = previousCamera;

            await this.database.deleteFile(id);

            throw error;
        }
    }

    uniqueAnimationName(baseName) {
        const name = baseName || "animation";
        const existing = new Set(this.clips.keys());

        if (!existing.has(name)) {
            return name;
        }

        let index = 2;

        while (existing.has(`${name}-${index}`)) {
            index++;
        }

        return `${name}-${index}`;
    }

    getAnimationNames() {
        return [...this.clips.keys()];
    }

    getBone(name) {
        return this.bones.get(
            normalizeBoneName(name)
        ) ?? null;
    }

    setAnimation(name, persist = true) {
        const clip = this.clips.get(name);

        if (!clip) {
            throw new Error(`Unknown animation: ${name}`);
        }

        if (this.selectedAnimation === name) {
            return;
        }

        if (this.currentAction) {
            this.currentAction.stop();
        }

        this.currentAction = this.mixer.clipAction(clip);

        this.currentAction
            .reset()
            .setLoop(THREE.LoopRepeat, Infinity)
            .play();

        this.currentAction.paused = !this.playing;
        this.selectedAnimation = name;

        this.mixer.update(0);
        this.notify();

        if (persist) {
            void this.persist().catch(console.error);
        }
    }

    setPlaying(value) {
        this.playing = Boolean(value);

        if (this.currentAction) {
            this.currentAction.paused = !this.playing;
        }

        this.notify();

        void this.persist().catch(console.error);
    }

    setPosePipeline(beforeAnimation = null, afterAnimation = null) {
        this.beforeAnimation = beforeAnimation;
        this.afterAnimation = afterAnimation;
    }

    update(delta) {
        if (!this.mixer) {
            return;
        }

        this.beforeAnimation?.();
        this.mixer.update(delta);

        if (this.afterAnimation) {
            this.avatar.updateWorldMatrix(true, true);
            this.afterAnimation(delta);
            this.avatar.updateWorldMatrix(true, true);
        }
    }

    async setCameraState(position, target) {
        this.cameraState = {
            position: position.toArray(),
            target: target.toArray()
        };

        await this.database.put(
            "settings",
            "camera",
            cloneData(this.cameraState)
        );
    }

    async setMetadata(metadata) {
        this.metadata = cloneData(metadata);

        await this.persist();
        this.notify();
    }

    async saveAttachment(file) {
        return this.database.saveFile(file);
    }

    async getAttachment(id) {
        return this.database.getFile(id);
    }

    async deleteAttachment(id) {
        // Assets restored from an exported GLB may share the
        // same IndexedDB file as the active avatar.
        if (
            this.avatarSource?.type === "glb" &&
            this.avatarSource.id === id
        ) {
            return;
        }

        return this.database.deleteFile(id);
    }

    async persist() {
        const state = {
            version: 1,
            avatar: cloneData(this.avatarSource),
            animations: cloneData(this.animationSources),
            selectedAnimation: this.selectedAnimation,
            playing: this.playing,
            metadata: cloneData(this.metadata)
        };

        this.saveQueue = this.saveQueue
            .catch(() => { })
            .then(() => {
                return this.database.put(
                    "settings",
                    "current",
                    state
                );
            });

        return this.saveQueue;
    }

    async reset() {
        await this.database.clear();

        this.avatarSource = cloneData(DEFAULT_AVATAR);
        this.animationSources = cloneData(DEFAULT_ANIMATIONS);

        this.cameraState = cloneData(DEFAULT_CAMERA);
        this.metadata = cloneData(DEFAULT_METADATA);

        this.playing = true;

        this.setPosePipeline();

        await this.rebuild(
            this.avatarSource,
            this.animationSources,
            "idle"
        );

        await this.persist();
    }

    notify() {
        this.dispatchEvent(new Event("change"));
    }
}