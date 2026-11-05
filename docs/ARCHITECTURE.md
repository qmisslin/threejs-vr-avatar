# Avatar Creator — Architecture and Development

## Overview

Avatar Creator is a modular Three.js application based on a shared avatar session.

The project separates:

1. Avatar data and persistence.
2. Animation and skeletal control.
3. Specialized editing controllers.
4. Rendering and user interaction.
5. GLB serialization.
6. Standalone runtime execution.

The editor and standalone runtime share an interchange format but do not share their internal controller implementations.

## Design principles

The architecture follows these principles:

- One authoritative avatar session.
- Specialized controllers with limited responsibilities.
- No independent avatar state inside individual editor views.
- Native JavaScript ES modules.
- Centralized Three.js rendering lifecycle.
- Browser-based persistence.
- Standard GLB serialization with structured metadata.
- Independent runtime consumption of exported files.

## Project structure

The following structure illustrates the project's organization.

```text
avatar-creator/
├── index.html
├── loader.html
├── ik.html
├── view.html
├── assets.html
├── anchors.html
├── hands.html
├── export.html
├── style.css
│
├── core/
│   ├── AvatarSession.js
│   ├── AvatarViewport.js
│   ├── FirstPersonViewport.js
│   ├── IKController.js
│   ├── ViewCameraController.js
│   ├── AssetController.js
│   ├── AnchorController.js
│   ├── HandPoseController.js
│   ├── HandPoseGLBImporter.js
│   ├── AvatarGLBExporter.js
│   └── InteractiveViewHelper.js
│
├── views/
│   ├── main.js
│   ├── loader.js
│   ├── ik.js
│   ├── view.js
│   ├── assets.js
│   ├── anchors.js
│   ├── hands.js
│   └── export.js
│
├── fbx/
│   └── Default avatar and animation resources
│
├── docs/
│   ├── EDITOR.md
│   ├── GLB_FORMAT.md
│   ├── RUNTIME.md
│   └── ARCHITECTURE.md
│
├── README.md
└── .gitignore
```

The standalone runtime can be distributed separately as `avatar.js`.

The organization above documents the intended editor structure. Exact asset filenames and additional project files depend on the repository.

## Main application

The editor entry point is:

```text
views/main.js
```

It initializes and coordinates the application.

### Main responsibilities

- Initialize the avatar session.
- Instantiate the editor controllers.
- Handle navigation between views.
- Create and destroy viewport instances.
- Run the animation loop.
- Coordinate animation and editing updates.
- Expose the application to child views.

### Application reference

The parent application is available through:

```js
window.avatarApp
```

Child views can access the shared application through:

```js
window.parent.avatarApp
```

This provides access to the active session and controllers.

## View architecture

The editor uses separate HTML pages displayed inside an iframe.

Each view is responsible for its own:

- HTML interface.
- User interactions.
- Editor-specific controls.
- Status messages.
- Local DOM events.

The views do not own independent copies of the avatar.

They interact with the central application.

### Three.js module context

The parent application owns the Three.js module imports.

Child views should use the parent application references when they need access to shared Three.js objects and controllers.

This avoids separate Three.js module instances and import-resolution problems between iframe contexts.

### Binary import between contexts

When passing binary data between iframe and parent JavaScript contexts, care is required with `ArrayBuffer`.

Three.js loaders may use `instanceof ArrayBuffer`, which depends on the JavaScript realm that created the object.

Binary buffers should be converted into the loader's owning context when necessary.

## AvatarSession

File:

```text
core/AvatarSession.js
```

`AvatarSession` is the central state container.

### Responsibilities

- Current avatar.
- Avatar source reference.
- Skeleton and bone lookup.
- Animation clips.
- Animation mixer.
- Selected animation.
- Playback state.
- Avatar metadata.
- Camera state.
- IndexedDB persistence.
- Loading and rebuilding the avatar.
- Change notifications.

### Important properties

| Property | Description |
|---|---|
| `avatar` | Loaded Three.js avatar object |
| `rigRoot` | Root skeleton bone |
| `bones` | Bone lookup map |
| `clips` | Available animation clips |
| `mixer` | Animation mixer |
| `selectedAnimation` | Current animation name |
| `playing` | Animation playback state |
| `metadata` | Avatar Creator configuration |
| `cameraState` | Editor viewport camera |
| `database` | IndexedDB access layer |

### Bone lookup

The session normalizes Mixamo bone names before lookup.

For example, bone references may be resolved through:

```js
session.getBone("LeftHand");
session.getBone("Hips");
session.getBone("root");
```

The GLB import process additionally handles duplicate names and selects coherent chains where required.

### Session notifications

Controllers subscribe to session changes.

The session emits change events when relevant state changes.

Controllers use these events to rebuild or refresh their resources.

## Avatar normalization

The editor normalizes source avatars to a reference height.

```text
Reference height: 1.75 m
```

The normalization process maintains the relationship between the skeleton and skinned meshes.

The common skeleton root is named:

```text
root
```

The `Hips` bone is used as the principal humanoid skeleton reference.

### Scale distribution

An imported FBX and a reimported GLB may distribute scale differently through their node hierarchies.

Therefore, serialized editor offsets must not assume identical raw bone-local scaling across formats.

This is why anchors use metric offsets in their parent bone's oriented frame.

## IKController

File:

```text
core/IKController.js
```

### Responsibilities

- Pelvis target.
- Hand targets.
- Elbow and knee pole targets.
- Arm IK.
- Leg IK.
- Two-bone solver.
- IK state serialization.
- Interactive target visualization.

### Two-bone IK

Each IK chain consists of:

```text
Start joint
    |
    v
Middle joint
    |
    v
End joint
```

The solver calculates rotations for the first two joints.

The end joint can receive an explicit orientation.

### Skeleton requirements

The selected joints must belong to the same connected skeletal hierarchy.

Direct parent-child relationships are not always required when intermediate nodes exist.

### Crouching

A pelvis displacement modifies the body position.

Leg IK is used to compensate for the movement of the pelvis.

The solver preserves bone lengths except where a specific editor operation explicitly adjusts transforms.

### Saved configuration

IK data is serialized into the avatar metadata.

The current convention uses version 3.

## ViewCameraController

File:

```text
core/ViewCameraController.js
```

### Responsibilities

- First-person camera reference.
- Camera anchor placement.
- View orientation.
- Camera state serialization.
- Camera visualization.

The camera reference is independent from the application's editor viewport camera.

The exported runtime reconstructs the reference as an `Object3D`.

## AssetController

File:

```text
core/AssetController.js
```

### Responsibilities

- Asset import.
- Asset records.
- Asset source models.
- Model transformations.
- Origin configuration.
- Bounding box calculations.
- Scale normalization.
- Preview rendering.
- Persistent asset references.

### Asset identity

Each asset has a unique record ID.

The ID is used to associate:

- Metadata records.
- Imported files.
- Runtime source models.
- Embedded GLB library nodes.

### Asset transforms

Each asset may contain:

- Origin transform.
- Model position.
- Model quaternion.
- Model scale.

### Rebuilding

The controller rebuilds asset instances when the avatar or resource configuration changes.

Asynchronous rebuild operations are coordinated through a rebuild promise.

The GLB exporter waits for asset rebuilding to complete before serializing the accessory library.

## AnchorController

File:

```text
core/AnchorController.js
```

### Responsibilities

- Named attachment points.
- Parent bone resolution.
- Metric offset conversion.
- Anchor transforms.
- Mirroring.
- Duplication.
- Selection.
- Asset previews.
- Persistent anchor records.

### Parent bone relationship

Anchors are children of skeleton bones.

They naturally follow:

- Animation.
- IK transformations.
- Global avatar movement.

### Metric offsets

The current anchor format uses:

```json
{
    "positionSpace": "meters"
}
```

The saved position is interpreted in the parent bone's oriented coordinate frame.

During reconstruction, the metric offset is converted into local coordinates using the bone's current world transform.

### Preview behavior

The editor uses a shared accessory preview.

Preview objects are not exported as visible avatar geometry.

## HandPoseController

File:

```text
core/HandPoseController.js
```

### Responsibilities

- Finger joint selection.
- Pose editing.
- Reference pose calculation.
- Rotation delta storage.
- Left/right mirroring.
- Hand-pose serialization.
- Pose reset.
- Pose import.

### Reference orientation

Hand poses are calculated relative to stable bind-pose references.

The controller reconstructs those references from the skeleton's inverse bind matrices when possible.

This prevents the currently playing animation from becoming the baseline for stored finger poses.

### Pose application

Custom hand poses are applied after animation evaluation.

The pose controller manages the corresponding rotation overrides.

### HandPoseGLBImporter

File:

```text
core/HandPoseGLBImporter.js
```

This module reads pose data directly from GLB JSON metadata.

It validates complete pose collections before importing them.

It does not need to load the complete avatar geometry.

## Viewports

### AvatarViewport

File:

```text
core/AvatarViewport.js
```

Provides the primary 3D avatar viewport.

Responsibilities include:

- Rendering.
- Camera controls.
- Resize handling.
- Interaction with the avatar scene.
- Selection and visualization support.

### FirstPersonViewport

File:

```text
core/FirstPersonViewport.js
```

Provides the first-person preview used in the camera configuration view.

It uses the shared avatar session and camera configuration.

## GLB exporter

File:

```text
core/AvatarGLBExporter.js
```

### Responsibilities

- Build the export inventory.
- Clone the avatar.
- Prepare the skinned meshes.
- Remove editor-only objects.
- Validate hand-pose records.
- Preserve animation tracks.
- Embed metadata.
- Embed accessory source models.
- Write binary GLB data.

### Export isolation

The exporter operates on cloned resources where possible.

Export preparation must not permanently alter the live editor skeleton, animation, or materials.

### Skin preparation

The exporter preserves the relationship between:

- Joint ordering.
- Vertex skin indices.
- Inverse bind matrices.

Any joint reordering must be accompanied by the corresponding remapping of skin indices.

### Accessory library

Embedded accessory sources are stored in a separate glTF scene when assets are present.

This avoids treating accessory source models as part of the avatar's visible skin.

### Custom metadata

The exporter writes the Avatar Creator manifest into the primary scene's user data.

Three.js serializes this data into glTF `extras`.

## Animation lifecycle

The main application coordinates several systems during a frame.

Conceptually:

```text
Animation frame
    |
    v
Restore previous finger overrides
    |
    v
Evaluate AnimationMixer
    |
    v
Apply editor-specific IK and camera overrides
    |
    v
Apply configured hand poses
    |
    v
Update anchor visuals
    |
    v
Render active viewports
```

The exact activation of editor-specific controllers depends on the current view.

The important invariant is that temporary skeletal overrides must not accumulate on top of themselves across frames.

## Standalone runtime architecture

The standalone runtime replaces the editor's controller architecture with a single class.

File:

```text
avatar.js
```

### Runtime components

Internally, the class manages:

```text
Avatar
├── Origin transform
├── Loaded model
├── Skeleton references
├── Animation mixer
├── IK chains
├── Hand targets
├── Pole targets
├── Hand poses
├── Skin registry
├── Accessory sources
├── Anchor registry
├── Accessory instances
└── Static camera reference
```

The runtime reuses the exported data conventions.

It does not reuse the editor controller classes.

### Runtime frame lifecycle

```text
update(delta)
    |
    v
Restore temporary overrides
    |
    v
Advance animation
    |
    v
Apply pelvis displacement
    |
    v
Solve leg IK
    |
    v
Solve active hand IK
    |
    v
Apply head rotation override
    |
    v
Apply hand poses
    |
    v
Update accessory scale compensation
```

This architecture allows animation, IK, head control, and hand poses to coexist without requiring a separate animation framework.

## Metadata ownership

The session owns the authoritative metadata during editing.

Controllers read and update their corresponding sections.

| Metadata section | Primary owner |
|---|---|
| `avatarHeight` | AvatarSession |
| `ik` | IKController |
| `cameraAnchor` | ViewCameraController |
| `assets` | AssetController |
| `anchors` | AnchorController |
| `handPoses` | HandPoseController |

The exporter reads these sections to build the final manifest.

The runtime reads them to initialize its internal state.

## Persistence model

The editor uses IndexedDB.

The database stores:

- Source files.
- Imported resources.
- Session settings.
- Avatar metadata.
- Camera state.

The GLB export is self-contained and does not reference the browser's IndexedDB database.

This distinction is important:

```text
Editor
    |
    +--> IndexedDB persistence
    |
    +--> GLB export
             |
             v
        Standalone runtime
```

The runtime uses the exported GLB directly.

## Error handling philosophy

The editor provides validation and user-facing error messages because it accepts imported resources and interactive configuration.

The runtime is intentionally simpler.

It assumes that the GLB was produced by Avatar Creator and conforms to its required conventions.

When required data is missing or invalid, the runtime raises an error.

No general-purpose skeleton repair or asset recovery subsystem is included.

## Development conventions

### JavaScript

- Use native ES modules.
- Use the same Three.js version across all imports.
- Keep shared avatar state in `AvatarSession`.
- Avoid duplicating editor controller state inside views.
- Keep runtime dependencies limited to Three.js and official addons.
- Preserve the identity of skeleton joints when working with skinned meshes.

### GLB changes

When changing the export format:

1. Update the exporter.
2. Update the editor importer.
3. Update the standalone runtime.
4. Update the format documentation.
5. Validate the round-trip import/export process.

Incompatible changes should increment the format version.

### Skeleton changes

When modifying skeleton construction:

- Preserve ancestry relationships.
- Preserve joint references.
- Preserve inverse bind matrices.
- Keep skin indices consistent with joint ordering.
- Verify both arm IK chains.
- Verify both leg IK chains.
- Verify both hand-pose systems.

### Anchor changes

When modifying anchor serialization:

- Preserve the parent bone reference.
- Preserve position-space semantics.
- Keep metric offsets independent from bone scale.
- Validate FBX-to-GLB and GLB-to-GLB round trips.

## Manual validation checklist

Before publishing a change affecting the exporter or runtime, verify the following behavior.

### Avatar

- [ ] FBX avatar imports successfully.
- [ ] GLB avatar imports successfully.
- [ ] Skeleton remains connected.
- [ ] Skinned meshes deform correctly.
- [ ] Avatar height remains consistent.

### IK

- [ ] Left arm IK works.
- [ ] Right arm IK works.
- [ ] Left leg IK works.
- [ ] Right leg IK works.
- [ ] Wrist rotations remain correct.
- [ ] Finger skinning remains correct.
- [ ] Pelvis adjustment works.

### Hand poses

- [ ] Left-hand pose applies correctly.
- [ ] Right-hand pose applies correctly.
- [ ] Pose mirroring works.
- [ ] Pose reset works.
- [ ] GLB pose import works.
- [ ] Pose transitions work in the runtime.

### Anchors and accessories

- [ ] Anchors retain their positions after avatar changes.
- [ ] Anchor mirroring works.
- [ ] Accessory models export correctly.
- [ ] Accessory instances attach correctly.
- [ ] Accessory scaling remains consistent.
- [ ] Instances can be detached and removed.

### Export

- [ ] GLB exports successfully.
- [ ] Exported metadata contains all required sections.
- [ ] Exported GLB can be reimported into Avatar Creator.
- [ ] Exported GLB loads in the standalone runtime.
- [ ] Embedded animations are available.
- [ ] Embedded accessories are available.
- [ ] Camera reference is available.

### Runtime

- [ ] Origin movement works.
- [ ] Height adjustment works.
- [ ] Animation transitions work.
- [ ] Hand targets can be activated and disabled.
- [ ] Head rotation override can be activated and disabled.
- [ ] Both hands can use different poses.
- [ ] Mesh visibility can be toggled.
- [ ] Accessory instances follow animated anchors.