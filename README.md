# Avatar Creator

**Avatar Creator** is a browser-based tool for creating, configuring, and exporting animated 3D avatars compatible with Three.js.

It provides a complete workflow for preparing Mixamo avatars, configuring inverse kinematics, managing hand poses, attaching accessories, and exporting everything into a single GLB file.

The exported avatar can be loaded and controlled by a standalone JavaScript class without requiring the editor or its internal controllers.

## Live Demo

Try Avatar Creator directly in your browser:

**[Launch Avatar Creator](https://qmisslin.github.io/threejs-vr-avatar/)**

The editor runs entirely in your browser using Three.js and IndexedDB. No installation or backend is required.

## Standalone Runtime Example

Explore a working example of the standalone Avatar Creator runtime, demonstrating how to load, display, and control an exported GLB avatar using Three.js.

- **[Live Demo](https://qmisslin.github.io/threejs-vr-avatar/dist/)** — Try the standalone avatar viewer directly in your browser.
- **[Source Code](./dist/)** — Explore the example implementation.

The example demonstrates:

- Loading an exported Avatar Creator GLB.
- Rendering the avatar with Three.js and OrbitControls.
- Controlling avatar height and pelvis position.
- Playing animations and applying hand poses.
- Accessing embedded accessories and avatar resources.

The example uses the standalone `avatar.js` runtime without requiring the Avatar Creator editor.

## Features

### Avatar editing

- Import animated avatars from Mixamo FBX files.
- Import previously exported Avatar Creator GLB files.
- Automatic avatar normalization.
- Skeletal hierarchy validation.
- Animation import, playback, and selection.
- Persistent configuration using IndexedDB.

### Inverse kinematics

- Two-bone inverse kinematics for arms and legs.
- Independent hand position and orientation targets.
- Configurable elbow and knee pole targets.
- Adjustable pelvis height for crouching.
- Preservation of the original skeletal hierarchy.

### Camera configuration

- First-person camera preview.
- Adjustable camera position.
- Camera orientation configuration.
- Independent camera reference transform.

### Assets and accessories

- Import FBX and GLB accessories.
- Configure accessory origin, position, rotation, and scale.
- Automatically normalize accessory dimensions.
- Create reusable attachment anchors.
- Attach anchors to specific skeleton bones.
- Mirror, duplicate, and reposition anchors.

### Hand poses

- Configure all five fingers independently.
- Separate left-hand and right-hand poses.
- Mirror finger configurations between hands.
- Save reusable named poses.
- Import hand poses from existing GLB files.
- Preserve animation control when no custom pose is applied.

### GLB export

- Export the avatar as a single binary glTF 2.0 file.
- Include the complete skeleton and skinned meshes.
- Preserve materials and available textures.
- Include animations and avatar configuration.
- Embed reusable accessory models.
- Save IK settings, anchors, hand poses, and camera configuration.
- Reimport exported avatars into Avatar Creator.

### Standalone runtime

The exported GLB can be used through `avatar.js`, a self-contained avatar management class.

The runtime supports:

- Loading and displaying the avatar.
- Setting avatar height.
- Controlling pelvis height.
- Hand IK targets.
- Head rotation overrides.
- Animation transitions.
- Independent hand-pose transitions.
- Skin visibility.
- Accessory instantiation.
- Attaching and detaching objects.
- Accessing the avatar origin and eye transforms.

The runtime does not depend on the editor.

## Technology

| Component | Technology |
|---|---|
| Rendering | Three.js |
| Reference version | Three.js 0.186.1 |
| 3D interchange | glTF 2.0 / GLB |
| Source avatar format | Mixamo FBX |
| Accessory formats | FBX / GLB |
| Animation | Three.js AnimationMixer |
| IK | Two-bone analytical IK |
| Storage | Browser IndexedDB |
| UI | HTML, CSS, JavaScript |
| Modules | Native ES modules |
| Server requirements | Static HTTP server |

No backend or server-side database is required.

The standalone runtime uses Three.js and its official addons but does not require any Avatar Creator modules.

## Getting started

### Requirements

- A modern browser supporting WebGL.
- ES modules and import maps.
- IndexedDB.
- A local or remote HTTP server.
- Three.js 0.186.1.

### 1. Clone the repository

```bash
git clone <repository-url>
cd avatar-creator
```

Replace `<repository-url>` with the repository URL.

### 2. Start a local server

For example, using Python:

```bash
python3 -m http.server 8000
```

Alternatively, any static HTTP server can be used.

### 3. Open Avatar Creator

Navigate to:

```text
http://localhost:8000
```

The editor initializes the default avatar and restores the saved browser configuration when available.

## Editor workflow

A typical avatar preparation workflow consists of the following steps.

### 1. Load an avatar

Open the **Loader** view.

Import a compatible Mixamo FBX avatar or an existing Avatar Creator GLB file.

The editor validates the skeleton and prepares the avatar for animation and IK.

### 2. Configure inverse kinematics

Open the **IK** view.

Adjust the pelvis, hand targets, elbow poles, and knee poles.

The IK configuration can be stored with the avatar.

### 3. Configure the camera

Open the **View** page.

Adjust the camera reference position and orientation while using the first-person preview.

### 4. Import accessories

Open the **Assets** view.

Import the FBX or GLB models that should be available as reusable accessories.

Configure their transforms and normalization.

### 5. Configure anchors

Open the **Anchors** view.

Create attachment points on skeleton bones and adjust their positions and orientations.

Anchor offsets use metric coordinates to remain independent of the scale inherited from individual bones.

### 6. Create hand poses

Open the **Hands** view.

Create named poses, configure finger rotations, and use mirroring when required.

### 7. Export

Open the **Export** view.

Review the inventory and export the avatar to a single GLB file.

The exported file contains the required resources and configuration for the standalone runtime.

For detailed instructions, see [Editor Guide](docs/EDITOR.md).

## Using an exported avatar

The standalone runtime can be integrated into any Three.js application using the compatible GLB format.

```js
import Avatar from "./avatar.js";

const avatar = new Avatar();

await avatar.load("/models/avatar.glb");

scene.add(avatar.getOriginTransform());

avatar.setHeight(1.8);
avatar.setHipsHeight(-0.15);

avatar.setAnim("idle",300);
avatar.setLeftHandPose("Grip",200);
avatar.setRightHandPose("Grip",200);

const timer = new THREE.Timer();
timer.connect(document);

function animate() {
    requestAnimationFrame(animate);

    timer.update();
    avatar.update(timer.getDelta());

    renderer.render(scene,camera);
}

requestAnimationFrame(animate);
```

The names `"idle"` and `"Grip"` are examples. Available names depend on the exported avatar.

To inspect the available resources:

```js
console.log(avatar.getAnimationsNames());
console.log(avatar.getHandPoseNames());
console.log(avatar.getSkinNames());
console.log(avatar.getAccessoriesNames());
```

See [Runtime API](docs/RUNTIME.md) for the complete API and integration examples.

## Exported GLB format

Avatar Creator uses a custom metadata convention built on top of standard glTF 2.0.

The file contains:

- Avatar scene.
- Skeleton and skinned meshes.
- Animations.
- Embedded configuration metadata.
- Optional accessory library scene.

The metadata identifies the export format:

```json
{
    "format": "avatar-creator",
    "version": 1
}
```

A generic GLB containing an arbitrary Mixamo skeleton is not automatically compatible with the standalone runtime.

It must follow the Avatar Creator export conventions.

See [GLB Format Specification](docs/GLB_FORMAT.md).

## Application architecture

Avatar Creator is organized around a shared avatar session and several specialized controllers.

| Module | Responsibility |
|---|---|
| AvatarSession | Avatar, skeleton, animations, metadata, persistence |
| IKController | Two-bone IK, pelvis, hand targets, pole targets |
| ViewCameraController | Camera reference and orientation |
| AssetController | Imported models and accessory configuration |
| AnchorController | Bone attachment points |
| HandPoseController | Finger poses and mirroring |
| AvatarGLBExporter | GLB serialization and metadata |
| AvatarViewport | Main 3D viewport |
| FirstPersonViewport | First-person camera preview |
| AvatarGLB / avatar.js | Standalone application runtime |

The editor and runtime are intentionally separate.

The editor creates and exports avatars. The runtime consumes those exports.

See [Architecture](docs/ARCHITECTURE.md).

## Documentation

| Document | Description |
|---|---|
| [Editor Guide](docs/EDITOR.md) | Editor interface, configuration, imports, and exports |
| [GLB Format](docs/GLB_FORMAT.md) | File structure, metadata, skeleton, and compatibility |
| [Runtime API](docs/RUNTIME.md) | Complete standalone avatar class documentation |
| [Architecture](docs/ARCHITECTURE.md) | Internal modules, rendering lifecycle, and development conventions |

## Important conventions

- The reference avatar height is **1.75 meters**.
- Avatar position and global orientation are controlled through the origin transform.
- Custom anchors store metric offsets relative to skeleton bones.
- Hand poses contain rotation deltas relative to the reference bind pose.
- Runtime animation and IK are evaluated independently.
- IK operates on two-segment skeletal chains.
- Three.js dependencies should use the same compatible version.
- The standalone runtime expects GLB files exported by Avatar Creator.

## Limitations

- The editor is designed primarily for Mixamo-compatible humanoid skeletons.
- The runtime does not provide automatic retargeting for arbitrary rigs.
- IK does not perform collision detection or full-body physical simulation.
- The exported GLB must contain the required skeleton, metadata, and animations.
- Some unsupported or unavailable source textures may be omitted during export.
- Browser storage is local to the current origin and browser profile.

## License

Copyright (c) 2026 Misslin Quentin.

This project is licensed under the [MIT License](LICENSE).

You are free to use, copy, modify, merge, publish, distribute, sublicense, and sell this software for personal or commercial purposes.

The only requirements are to retain the copyright notice and the MIT license text in copies or substantial portions of the software.

See the [LICENSE](LICENSE) file for the complete license terms.