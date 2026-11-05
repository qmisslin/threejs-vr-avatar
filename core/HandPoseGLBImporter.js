const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const MIN_QUATERNION_LENGTH = 1e-8;

const JOINTS = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
    .flatMap(finger => {
        return [1, 2, 3].map(index => `${finger}${index}`);
    });

async function readGLBJSON(file) {
    if (!file.name.toLowerCase().endsWith(".glb")) {
        throw new Error("Expected a GLB file.");
    }

    if (file.size < 20) {
        throw new Error("Invalid GLB file.");
    }

    const headerBuffer = await file.slice(0, 20).arrayBuffer();
    const header = new DataView(headerBuffer);

    const magic = header.getUint32(0, true);
    const version = header.getUint32(4, true);
    const length = header.getUint32(8, true);
    const chunkLength = header.getUint32(12, true);
    const chunkType = header.getUint32(16, true);

    if (magic !== GLB_MAGIC || version !== GLB_VERSION) {
        throw new Error("Unsupported GLB format.");
    }

    if (length !== file.size) {
        throw new Error("Invalid GLB file length.");
    }

    if (
        chunkType !== JSON_CHUNK ||
        chunkLength === 0 ||
        chunkLength % 4 !== 0 ||
        20 + chunkLength > length
    ) {
        throw new Error("Invalid GLB JSON chunk.");
    }

    const jsonText = await file.slice(
        20,
        20 + chunkLength
    ).text();

    let data;

    try {
        data = JSON.parse(jsonText);
    } catch {
        throw new Error("Invalid GLB JSON.");
    }

    if (String(data.asset?.version ?? "").split(".")[0] !== "2") {
        throw new Error("Unsupported glTF asset version.");
    }

    return data;
}

function collectPoseCollections(value, collections, visited, depth = 0) {
    if (
        !value ||
        typeof value !== "object" ||
        visited.has(value) ||
        depth > 10
    ) {
        return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
        for (const item of value) {
            collectPoseCollections(
                item,
                collections,
                visited,
                depth + 1
            );
        }

        return;
    }

    if (Array.isArray(value.handPoses)) {
        collections.push(value.handPoses);
    }

    for (const [key, child] of Object.entries(value)) {
        if (key === "handPoses") {
            continue;
        }

        collectPoseCollections(
            child,
            collections,
            visited,
            depth + 1
        );
    }
}

function extractPoseCollections(gltf) {
    const sources = [
        gltf.extras,
        gltf.asset?.extras,
        ...(gltf.scenes ?? []).map(scene => scene.extras),
        ...(gltf.nodes ?? []).map(node => node.extras),
        ...(gltf.animations ?? []).map(animation => animation.extras)
    ];

    const collections = [];
    const visited = new WeakSet();

    for (const source of sources) {
        collectPoseCollections(
            source,
            collections,
            visited
        );
    }

    return collections;
}

function validateHand(hand) {
    if (
        !hand ||
        typeof hand !== "object" ||
        Array.isArray(hand)
    ) {
        return null;
    }

    const result = {};

    for (const joint of JOINTS) {
        const quaternion = hand[joint];

        if (
            !Array.isArray(quaternion) ||
            quaternion.length !== 4 ||
            !quaternion.every(Number.isFinite)
        ) {
            return null;
        }

        const length = Math.hypot(...quaternion);

        if (
            !Number.isFinite(length) ||
            length < MIN_QUATERNION_LENGTH
        ) {
            return null;
        }

        result[joint] = quaternion.map(value => {
            return value / length;
        });
    }

    return result;
}

function validatePose(pose) {
    if (
        !pose ||
        typeof pose !== "object" ||
        typeof pose.name !== "string"
    ) {
        return null;
    }

    const name = pose.name.trim();

    if (!name || name.toLowerCase() === "default") {
        return null;
    }

    const right = validateHand(pose.right);
    const left = validateHand(pose.left);

    if (!right || !left) {
        return null;
    }

    return { name, right, left };
}

export default async function readHandPosesFromGLB(file) {
    const gltf = await readGLBJSON(file);
    const collections = extractPoseCollections(gltf);

    if (!collections.length) {
        throw new Error(
            "No handPoses metadata found in this GLB."
        );
    }

    const poses = new Map();
    let skipped = 0;

    for (const collection of collections) {
        for (const candidate of collection) {
            const pose = validatePose(candidate);

            if (!pose) {
                skipped++;
                continue;
            }

            // The last complete definition wins for duplicate names.
            poses.set(pose.name, pose);
        }
    }

    if (!poses.size) {
        throw new Error(
            "No complete hand pose found. Each pose must contain all 30 finger rotations."
        );
    }

    return {
        poses: [...poses.values()],
        skipped
    };
}