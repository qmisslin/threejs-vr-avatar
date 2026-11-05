import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

const FORMAT = "avatar-creator";
const VERSION = 1;

const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

const JOINTS = FINGERS.flatMap(finger =>
    [1, 2, 3].map(index => `${finger}${index}`)
);

const POLES = [
    "leftElbow",
    "rightElbow",
    "leftKnee",
    "rightKnee"
];

function cloneWithIdentifiers(source) {
    const cloned = SkeletonUtils.clone(source);

    const originals = [];
    const copies = [];

    source.traverse(object => originals.push(object));
    cloned.traverse(object => copies.push(object));

    if (originals.length !== copies.length) {
        throw new Error("Cannot map the cloned avatar hierarchy.");
    }

    const identifiers = new Map();

    for (let i = 0; i < originals.length; i++) {
        identifiers.set(originals[i].uuid, copies[i].uuid);
    }

    // A previously imported GLB uses a Scene as its avatar root.
    // Avoid nesting a Three.js Scene inside the export scene.
    if (cloned.isScene) {
        const avatar = new THREE.Group();
        avatar.name = "Avatar";

        while (cloned.children.length) {
            avatar.add(cloned.children[0]);
        }

        return {
            cloned: avatar,
            identifiers
        };
    }

    return { cloned, identifiers };
}

function removeEditorObjects(root) {
    const shouldRemove = object => {
        if (
            object.userData.editorOnly ||
            object.userData.editorAnchor
        ) {
            return true;
        }

        if (
            object.name.startsWith("Anchor:") ||
            object.name === "SelectedBoneHighlight" ||
            object.name === "CameraAnchorMarker"
        ) {
            return true;
        }

        return /^(HipsTarget|LeftHandTarget|RightHandTarget)$/i
            .test(object.name);
    };

    const visit = object => {
        for (const child of [...object.children]) {
            if (shouldRemove(child)) {
                object.remove(child);
            } else {
                visit(child);
            }
        }
    };

    visit(root);
}

function prepareSkins(avatar) {
    const rootBone = avatar.getObjectByName("root");

    if (!rootBone?.isBone) {
        throw new Error("The avatar must contain a root bone.");
    }

    avatar.updateWorldMatrix(true, true);

    const isAncestor = (ancestor, object) => {
        let current = object;

        while (current) {
            if (current === ancestor) {
                return true;
            }

            current = current.parent;
        }

        return false;
    };

    let skinCount = 0;

    avatar.traverse(object => {
        if (!object.isSkinnedMesh || !object.skeleton) {
            return;
        }

        skinCount++;

        const originalSkeleton = object.skeleton;
        const originalBones = originalSkeleton.bones;

        // Every skin joint must belong to the root hierarchy.
        for (const bone of originalBones) {
            if (!bone?.isBone || !isAncestor(rootBone, bone)) {
                throw new Error(
                    `Invalid skin hierarchy in "${object.name}": ${bone?.name ?? "unknown"}`
                );
            }
        }

        // The first joint is used as the glTF skin root.
        const orderedBones = [
            rootBone,
            ...originalBones.filter(bone => bone !== rootBone)
        ];

        const newIndexByBone = new Map(
            orderedBones.map((bone, index) => [bone, index])
        );

        const oldIndexByBone = new Map(
            originalBones.map((bone, index) => [bone, index])
        );

        const remap = originalBones.map(bone => {
            return newIndexByBone.get(bone);
        });

        const needsRemap =
            orderedBones.length !== originalBones.length ||
            remap.some((index, oldIndex) => index !== oldIndex);

        if (needsRemap) {
            // Never mutate geometry shared with the live avatar.
            const geometry = object.geometry.clone();
            const skinIndex = geometry.getAttribute("skinIndex");
            const skinWeight = geometry.getAttribute("skinWeight");

            if (!skinIndex || !skinWeight || skinIndex.itemSize !== 4) {
                throw new Error(
                    `Missing skinning attributes in "${object.name}".`
                );
            }

            if (skinIndex.normalized) {
                throw new Error(
                    `Unsupported normalized skin indices in "${object.name}".`
                );
            }

            const mapIndex = (index, weight) => {
                const mapped = remap[index];

                if (mapped !== undefined) {
                    return mapped;
                }

                // Unused slots do not influence vertex skinning.
                if (weight === 0) {
                    return 0;
                }

                throw new Error(
                    `Invalid skin index ${index} in "${object.name}".`
                );
            };

            for (let i = 0; i < skinIndex.count; i++) {
                const indices = [
                    skinIndex.getX(i),
                    skinIndex.getY(i),
                    skinIndex.getZ(i),
                    skinIndex.getW(i)
                ];

                const weights = [
                    skinWeight.getX(i),
                    skinWeight.getY(i),
                    skinWeight.getZ(i),
                    skinWeight.getW(i)
                ];

                skinIndex.setXYZW(
                    i,
                    mapIndex(indices[0], weights[0]),
                    mapIndex(indices[1], weights[1]),
                    mapIndex(indices[2], weights[2]),
                    mapIndex(indices[3], weights[3])
                );
            }

            skinIndex.needsUpdate = true;
            object.geometry = geometry;

            // Preserve each joint's original inverse bind matrix.
            const inverses = orderedBones.map(bone => {
                const index = oldIndexByBone.get(bone);

                if (index !== undefined) {
                    return originalSkeleton.boneInverses[index].clone();
                }

                // The added root has no original skin index.
                return bone.matrixWorld.clone().invert();
            });

            object.skeleton = new THREE.Skeleton(
                orderedBones,
                inverses
            );
        }

        object.frustumCulled = false;
    });

    if (!skinCount) {
        throw new Error(
            "The avatar contains no skinned mesh."
        );
    }
}

function validateHandPoses(records) {
    if (!Array.isArray(records)) {
        return [];
    }

    return records.map(record => {
        if (
            typeof record.name !== "string" ||
            !record.name.trim()
        ) {
            throw new Error(
                "A hand pose has an invalid name."
            );
        }

        const pose = {
            id: record.id,
            name: record.name,
            right: {},
            left: {}
        };

        for (const side of ["right", "left"]) {
            for (const joint of JOINTS) {
                const values = record[side]?.[joint];

                if (
                    !Array.isArray(values) ||
                    values.length !== 4 ||
                    !values.every(Number.isFinite)
                ) {
                    throw new Error(
                        `Incomplete hand pose: ${record.name} (${side}.${joint}).`
                    );
                }

                const length = Math.hypot(...values);

                if (
                    !Number.isFinite(length) ||
                    length < 1e-8
                ) {
                    throw new Error(
                        `Invalid quaternion: ${record.name} (${side}.${joint}).`
                    );
                }

                pose[side][joint] = values.map(
                    value => value / length
                );
            }
        }

        return pose;
    });
}

function prepareAnimations(clips, identifiers) {
    return [...clips.values()].map(original => {
        const clip = original.clone();

        for (const track of clip.tracks) {
            const separator = track.name.indexOf(".");

            if (separator < 0) {
                continue;
            }

            const node = track.name.slice(0, separator);
            const suffix = track.name.slice(separator);

            const replacement = identifiers.get(node);

            if (replacement) {
                track.name = `${replacement}${suffix}`;
            }
        }

        return clip;
    });
}

async function prepareExportMaterials(roots) {
    const cache = new Map();
    const skipped = [];
    const meshes = [];

    const hasValidImage = image => {
        if (!image) {
            return false;
        }

        const hasDimensions =
            Number.isFinite(image.width) &&
            Number.isFinite(image.height) &&
            image.width > 0 &&
            image.height > 0;

        if (!hasDimensions) {
            return false;
        }

        if (
            typeof HTMLImageElement !== "undefined" &&
            image instanceof HTMLImageElement
        ) {
            return image.complete && image.naturalWidth > 0;
        }

        if (
            typeof HTMLCanvasElement !== "undefined" &&
            image instanceof HTMLCanvasElement
        ) {
            return true;
        }

        if (
            typeof OffscreenCanvas !== "undefined" &&
            image instanceof OffscreenCanvas
        ) {
            return true;
        }

        if (
            typeof ImageBitmap !== "undefined" &&
            image instanceof ImageBitmap
        ) {
            return true;
        }

        // DataTexture and ImageData store their pixels in data.
        return ArrayBuffer.isView(image.data) &&
            image.data.length > 0;
    };

    const prepareMaterial = async (material, meshName) => {
        if (cache.has(material)) {
            return cache.get(material);
        }

        let clone = null;

        for (const [property, texture] of Object.entries(material)) {
            if (!texture?.isTexture) {
                continue;
            }

            const image = texture.image;

            // Complete pending HTML image decoding before export.
            if (
                typeof HTMLImageElement !== "undefined" &&
                image instanceof HTMLImageElement &&
                !image.complete
            ) {
                try {
                    await image.decode();
                } catch {
                    // The invalid image will be handled below.
                }
            }

            if (hasValidImage(texture.image)) {
                continue;
            }

            // Never modify materials shared with the live avatar.
            if (!clone) {
                clone = material.clone();
            }

            clone[property] = null;

            skipped.push({
                mesh: meshName,
                material: material.name || material.type,
                property,
                texture: texture.name || texture.uuid
            });
        }

        if (clone) {
            clone.needsUpdate = true;
        }

        const result = clone ?? material;

        cache.set(material, result);

        return result;
    };

    for (const root of roots) {
        root.traverse(object => {
            if (object.isMesh && object.material) {
                meshes.push(object);
            }
        });
    }

    for (const mesh of meshes) {
        const meshName = mesh.name || mesh.uuid;

        if (Array.isArray(mesh.material)) {
            const materials = [];

            for (const material of mesh.material) {
                materials.push(
                    await prepareMaterial(material, meshName)
                );
            }

            mesh.material = materials;
        } else {
            mesh.material = await prepareMaterial(
                mesh.material,
                meshName
            );
        }
    }

    if (skipped.length) {
        console.warn(
            `[AvatarGLBExporter] ${skipped.length} texture reference(s) skipped because image data is unavailable:`,
            skipped
        );
    }

    return skipped;
}

export default class AvatarGLBExporter {
    constructor(app) {
        this.app = app;
        this.session = app.session;
        this.assets = app.assets;
    }

    getInventory() {
        const session = this.session;
        const avatar = session.avatar;

        const bones = [
            ...new Set(
                [...session.bones.values()]
                    .filter(object => object?.isBone)
                    .map(object => object.name)
            )
        ];

        const meshes = [];

        avatar?.traverse(object => {
            if (!object.isMesh) {
                return;
            }

            let current = object;
            let editorOnly = false;

            while (current && current !== avatar) {
                if (
                    current.userData.editorOnly ||
                    current.userData.editorAnchor ||
                    current.name.startsWith("Anchor:") ||
                    current.name === "SelectedBoneHighlight" ||
                    /^(HipsTarget|LeftHandTarget|RightHandTarget)$/i
                        .test(current.name)
                ) {
                    editorOnly = true;
                    break;
                }

                current = current.parent;
            }

            if (!editorOnly) {
                meshes.push(
                    object.name || (
                        object.isSkinnedMesh
                            ? "SkinnedMesh"
                            : "Mesh"
                    )
                );
            }
        });

        const poles = POLES.filter(name => {
            return Boolean(
                session.ik?.poleTargets?.[name]
            );
        });

        const camera = this.app.viewCamera?.ready ||
            session.metadata.cameraAnchor
            ? ["CameraAnchor"]
            : [];

        return [
            {
                label: "Skeleton",
                required: true,
                items: bones
            },
            {
                label: "Skin objects",
                items: meshes
            },
            {
                label: "IK poles",
                items: poles
            },
            {
                label: "Camera target",
                items: camera
            },
            {
                label: "Assets",
                items: this.assets.records.map(record => record.name)
            },
            {
                label: "Anchors",
                items: (session.metadata.anchors ?? []).map(
                    record => `${record.name} (${record.bone})`
                )
            },
            {
                label: "Hand poses",
                items: (session.metadata.handPoses ?? []).map(
                    record => record.name
                )
            },
            {
                label: "Animations",
                items: session.getAnimationNames()
            }
        ];
    }

    async export() {
        await this.assets.rebuildPromise;

        const session = this.session;

        if (!session.avatar || !session.getBone("root")?.isBone) {
            throw new Error(
                "An avatar skeleton is required."
            );
        }

        for (const record of this.assets.records) {
            if (!this.assets.getInstance(record.id)) {
                throw new Error(
                    `Asset unavailable for export: ${record.name}`
                );
            }
        }

        const handPoses = validateHandPoses(
            session.metadata.handPoses
        );

        const { cloned: avatar, identifiers } =
            cloneWithIdentifiers(session.avatar);

        removeEditorObjects(avatar);

        // Export neutral fingers, not the custom pose currently
        // visible in the editor. The poses are stored in extras.
        const copiedObjects = new Map();

        avatar.traverse(object => {
            copiedObjects.set(object.uuid, object);
        });

        for (const [name, reference] of
            this.app.hands.referenceQuaternions) {
            const original = session.getBone(name);

            if (!original) {
                continue;
            }

            const copyId = identifiers.get(original.uuid);
            const copy = copiedObjects.get(copyId);

            if (copy?.isBone) {
                copy.quaternion.copy(reference);
            }
        }

        prepareSkins(avatar);

        avatar.userData.avatarCreatorAvatar = true;

        const scene = new THREE.Scene();
        scene.name = "AvatarCreatorExport";
        scene.add(avatar);

        const libraryScene = new THREE.Scene();
        libraryScene.name = "AvatarCreatorAssets";
        libraryScene.userData.avatarCreatorAssets = true;

        const library = new THREE.Group();
        library.name = "AvatarAssetLibrary";

        libraryScene.add(library);

        const exportedAssets = [];

        for (const record of this.assets.records) {
            const instance = this.assets.getInstance(record.id);

            const container = new THREE.Group();
            container.name = `Asset:${record.name}`;
            container.userData.avatarAssetId = record.id;

            const source = SkeletonUtils.clone(
                instance.source
            );

            removeEditorObjects(source);

            source.userData.avatarAssetSource = true;

            container.add(source);
            library.add(container);

            // File identifiers are regenerated on GLB import.
            const {
                fileId,
                nodeId,
                ...properties
            } = structuredClone(record);

            exportedAssets.push({
                ...properties,
                type: "glb"
            });
        }

        const metadata = {
            ...structuredClone(session.metadata),
            assets: exportedAssets,
            handPoses,
            ik: session.ik?.ready
                ? session.ik.serialize()
                : structuredClone(
                    session.metadata.ik ?? {}
                ),
            cameraAnchor: this.app.viewCamera?.ready
                ? this.app.viewCamera.getState()
                : structuredClone(
                    session.metadata.cameraAnchor ?? null
                )
        };

        scene.userData.avatarCreator = {
            format: FORMAT,
            version: VERSION,
            metadata,
            selectedAnimation: session.selectedAnimation,
            playing: session.playing,
            cameraState: structuredClone(
                session.cameraState
            )
        };

        const animations = prepareAnimations(
            session.clips,
            identifiers
        );

        const hasAssets = exportedAssets.length > 0;

        await prepareExportMaterials(
            hasAssets ? [scene, libraryScene] : [scene]
        );

        const exporter = new GLTFExporter();

        const buffer = await exporter.parseAsync(
            hasAssets
                ? [scene, libraryScene]
                : scene,
            {
                binary: true,
                trs: true,
                onlyVisible: false,
                animations: hasAssets
                    ? [animations, []]
                    : animations
            }
        );

        if (!(buffer instanceof ArrayBuffer)) {
            throw new Error(
                "The GLB exporter returned invalid data."
            );
        }

        return new Blob([buffer], {
            type: "model/gltf-binary"
        });
    }
}