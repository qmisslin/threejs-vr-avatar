# Avatar Creator — Standalone Runtime API

## Overview

The Avatar Creator runtime is a JavaScript class that loads and controls avatars exported from Avatar Creator.

It is designed to be integrated into an existing Three.js application.

The runtime handles:

- GLB loading.
- Skeleton resolution.
- Mesh visibility.
- Animation playback and transitions.
- Two-bone inverse kinematics.
- Hand-pose transitions.
- Pelvis height adjustment.
- Head orientation overrides.
- Accessory instantiation and attachment.
- Camera reference transforms.

All these features are managed through a single class.

The runtime does not depend on the Avatar Creator editor or its internal modules.

## Requirements

- Three.js 0.186.1.
- `GLTFLoader`.
- `SkeletonUtils`.
- Native ES module support.
- A GLB exported by Avatar Creator.

There is no separate runtime backend.

The runtime uses the application's existing Three.js scene, renderer, and camera.

## Installation

Copy the standalone runtime module into the application.

For example:

```text
application/
├── index.html
├── main.js
├── avatar.js
└── models/
    └── avatar.glb
```

The source file may be named `avatar.js`, regardless of the exported class name.

## Three.js imports

The runtime imports Three.js and two official addons:

```js
import * as THREE from "three";
import {GLTFLoader} from "three/addons/loaders/GLTFLoader.js";
import {clone as cloneSkeleton} from "three/addons/utils/SkeletonUtils.js";
```

All imports must resolve to a compatible version of Three.js.

### Import map example

```html
<script type="importmap">
{
    "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
    }
}
</script>
```

The runtime does not create its own WebGL renderer.

## Lifecycle

The standard lifecycle is:

1. Construct an avatar controller.
2. Load an exported GLB.
3. Add its origin transform to the scene.
4. Configure animations, IK, and poses.
5. Call `update(delta)` each frame.

### Basic usage

```js
import * as THREE from "three";
import Avatar from "./avatar.js";

const avatar = new Avatar();

await avatar.load("/models/avatar.glb");

scene.add(avatar.getOriginTransform());

avatar.setHeight(1.8);

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

`delta` is measured in seconds.

The runtime must be updated every frame to process animations, transitions, and IK.

## API reference

### Constructor

#### `new Avatar()`

Creates a runtime avatar controller.

```js
const avatar = new Avatar();
```

Parameters: none.

The constructor does not load an avatar automatically.

### Loading

#### `load(filepath)`

Loads an Avatar Creator GLB file.

```js
await avatar.load("/models/avatar.glb");
```

| Parameter | Type | Description |
|---|---|---|
| `filepath` | string | URL or path to a GLB file |

Returns: `Promise<Avatar>`.

Loading initializes:

- GLB scene.
- Skeleton references.
- Skinned meshes.
- Animation mixer.
- Available animations.
- Hand-pose collection.
- IK targets.
- Pole targets.
- Camera reference.
- Anchors.
- Accessory library.

The runtime rejects files that do not contain valid Avatar Creator metadata.

Call other avatar methods after the `load()` promise resolves.

### Updating

#### `update(delta)`

Advances the current animation and applies runtime overrides.

```js
avatar.update(1 / 60);
```

| Parameter | Type | Unit |
|---|---|---|
| `delta` | number | Seconds |

The update process performs:

1. Restoration of previously overridden transforms.
2. Animation mixer evaluation.
3. Pelvis displacement.
4. Leg IK when crouching.
5. Active hand IK.
6. Head orientation override.
7. Hand-pose application.
8. Attached accessory scale correction.

The calling application controls the animation loop.

Do not call `update()` multiple times for the same frame unless intentionally advancing the simulation.

## Avatar transforms

### `getOriginTransform()`

Returns the avatar's root transform.

```js
const origin = avatar.getOriginTransform();

scene.add(origin);
```

Returns: `THREE.Group`.

The returned object controls the whole avatar.

#### Position

```js
origin.position.set(0,0,0);
```

#### Orientation

```js
origin.rotation.y = Math.PI;
```

#### World placement

```js
const position = new THREE.Vector3(2,0,-1);
const rotation = new THREE.Quaternion();

origin.position.copy(position);
origin.quaternion.copy(rotation);
```

For consistent behavior, prefer `setHeight()` when changing avatar height instead of manually modifying the origin scale.

### `setHeight(value)`

Sets the avatar's total reference height.

```js
avatar.setHeight(1.8);
```

| Parameter | Type | Description |
|---|---|---|
| `value` | number | Requested height in meters |

The runtime applies a uniform scale calculated from:

```text
requestedHeight / exportedReferenceHeight
```

The exported reference height is read from `metadata.avatarHeight`.

The method does not change the source geometry or bone bind matrices.

A non-positive value raises an error.

### `setHipsHeight(value)`

Sets a vertical displacement of the pelvis relative to its baseline pose.

```js
avatar.setHipsHeight(-0.15);
```

| Parameter | Type | Description |
|---|---|---|
| `value` | number | Vertical offset in the normalized rig coordinate system |

Examples:

```js
avatar.setHipsHeight(0);
avatar.setHipsHeight(-0.15);
avatar.setHipsHeight(0.05);
```

- `0` disables the additional runtime displacement.
- Negative values lower the pelvis.
- Positive values raise the pelvis.

The overall avatar height is not changed.

When crouching is active, the runtime also solves the two leg IK chains to maintain their animated foot targets as closely as the two-bone solver permits.

The offset is evaluated in the normalized rig space and therefore scales visually with `setHeight()`.

This method controls a displacement, not the natural anatomical height of the pelvis.

## Hand inverse kinematics

### `setLeftHandTransform(leftworldTransform)`

Sets or disables the left-hand IK target.

```js
avatar.setLeftHandTransform(target);
```

Pass `null` to disable the left-hand IK override.

```js
avatar.setLeftHandTransform(null);
```

### `setRightHandTransform(rightworldTransform)`

Sets or disables the right-hand IK target.

```js
avatar.setRightHandTransform(target);
```

Pass `null` to disable the right-hand IK override.

```js
avatar.setRightHandTransform(null);
```

### Supported target representations

The target can be a `THREE.Object3D`:

```js
const target = new THREE.Object3D();

scene.add(target);

target.position.set(-0.5,1.2,0.3);

avatar.setLeftHandTransform(target);
```

It can also be a `THREE.Matrix4`:

```js
const matrix = new THREE.Matrix4();

matrix.compose(
    new THREE.Vector3(-0.5,1.2,0.3),
    new THREE.Quaternion(),
    new THREE.Vector3(1,1,1)
);

avatar.setLeftHandTransform(matrix);
```

Or an object containing position and quaternion:

```js
avatar.setLeftHandTransform({
    position:new THREE.Vector3(-0.5,1.2,0.3),
    quaternion:new THREE.Quaternion()
});
```

Array representations are also supported inside the object:

```js
avatar.setLeftHandTransform({
    position:[-0.5,1.2,0.3],
    quaternion:[0,0,0,1]
});
```

### Coordinate system

The supplied target is interpreted in **world space**.

It must already account for the position, rotation, and scale of the avatar's origin.

### Dynamic targets

A `THREE.Object3D` target can be moved directly during application execution.

```js
target.position.x += 0.01;
```

The avatar will use the target's current world transform on the next update.

### Disabling hand IK

```js
avatar.setLeftHandTransform(null);
avatar.setRightHandTransform(null);
```

When disabled, the corresponding arm returns to animation control.

The runtime does not destroy the skeleton or the associated animations.

### IK implementation

The runtime uses an analytical two-bone IK solver.

Each controlled arm contains:

```text
Upper arm -> Forearm -> Hand
```

The solver:

- Preserves segment lengths.
- Uses a pole target to choose the bending direction.
- Applies the requested wrist orientation.
- Limits unreachable targets to the available limb length.

The solver does not perform collision detection, obstacle avoidance, or full-body IK.

### Initial targets

The runtime initializes hand targets from the GLB's saved IK configuration.

To use only the base animation, explicitly disable the corresponding IK overrides.

## Head orientation

### `setHeadRotation(rotation)`

Overrides the head orientation.

```js
avatar.setHeadRotation(
    new THREE.Quaternion()
);
```

Supported values include:

- `THREE.Quaternion`.
- `THREE.Euler`.
- Quaternion array `[x,y,z,w]`.
- `null`.

Example:

```js
const rotation = new THREE.Quaternion()
    .setFromEuler(
        new THREE.Euler(0,0.3,0)
    );

avatar.setHeadRotation(rotation);
```

The supplied rotation is relative to the avatar root orientation.

It is not a direct world-space head transform.

### Disabling the override

```js
avatar.setHeadRotation(null);
```

This restores control of the head orientation to the active animation.

The runtime applies the override after evaluating the animation mixer.

## Animations

### `getAnimationsNames()`

Returns the names of all available animation clips.

```js
const names = avatar.getAnimationsNames();
```

Returns: `string[]`.

Example result:

```js
["idle","walk","run"]
```

The actual names depend on the GLB.

### `setAnim(name,transition = 0)`

Selects an animation.

```js
avatar.setAnim("walk",300);
```

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Animation name |
| `transition` | number | Transition duration in milliseconds |

The runtime uses Three.js animation crossfading when a positive transition duration is supplied.

#### Immediate transition

```js
avatar.setAnim("idle",0);
```

#### Smooth transition

```js
avatar.setAnim("walk",500);
```

Selecting an unknown animation raises an error.

Selecting the already-active animation has no effect.

Animations loop continuously through the runtime's `AnimationMixer`.

## Hand poses

### `getHandPoseNames()`

Returns the names of the hand poses embedded in the GLB.

```js
const names = avatar.getHandPoseNames();
```

Returns: `string[]`.

Example:

```js
["Grip","Point","Open"]
```

The names are defined in the editor.

### `setLeftHandPose(name,transition = 0)`

Applies a named pose to the left hand.

```js
avatar.setLeftHandPose("Grip",200);
```

### `setRightHandPose(name,transition = 0)`

Applies a named pose to the right hand.

```js
avatar.setRightHandPose("Grip",200);
```

### `setRighHandPose(name,transition = 0)`

Compatibility alias corresponding to the original public method spelling.

```js
avatar.setRighHandPose("Grip",200);
```

Both right-hand method names perform the same operation.

### Parameters

| Parameter | Type | Description |
|---|---|---|
| `name` | string or null | Name of the desired pose |
| `transition` | number | Transition duration in milliseconds |

### Immediate pose

```js
avatar.setLeftHandPose("Grip",0);
```

### Smooth pose

```js
avatar.setLeftHandPose("Grip",250);
```

### Independent hands

The left and right hand can use different poses.

```js
avatar.setLeftHandPose("Point",200);
avatar.setRightHandPose("Grip",200);
```

### Returning to animation control

Use `null` or `"default"`:

```js
avatar.setLeftHandPose(null,200);
avatar.setRightHandPose("default",200);
```

The runtime stops applying a custom pose when the transition completes.

### Pose representation

A pose contains local finger rotation deltas relative to the bind-pose reference.

The runtime reconstructs the final finger orientation and applies it after the animation mixer.

Each hand is controlled independently.

## Skin visibility

### `getSkinNames()`

Returns all available skin object names.

```js
const skins = avatar.getSkinNames();
```

Returns: `string[]`.

### `setSkin(name,visible)`

Controls the visibility of an individual mesh.

```js
avatar.setSkin("Cube001",false);
```

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Mesh name |
| `visible` | boolean | Requested visibility |

Returns: `null`.

### Examples

Hide a mesh:

```js
avatar.setSkin("Cube001",false);
```

Show a mesh:

```js
avatar.setSkin("Cube001",true);
```

All skin meshes are enabled when the avatar loads.

The method changes only object visibility.

It does not modify the geometry, material, or skeleton.

## Accessories

### `getAccessoriesNames()`

Returns the names of all embedded reusable accessories.

```js
const names = avatar.getAccessoriesNames();
```

Returns: `string[]`.

The returned names correspond to the asset records exported by Avatar Creator.

### `createInstance(name)`

Creates a new instance of an accessory.

```js
const sword = avatar.createInstance("Sword");
```

| Parameter | Type | Description |
|---|---|---|
| `name` | string | Accessory name |

Returns: `THREE.Group`.

Each instance is independent as an object hierarchy.

The runtime uses `SkeletonUtils.clone()` to preserve valid skeletal references in accessory models.

The instance includes the model transform and normalization configured in the editor.

### Instance attachment

Creating an instance does not automatically attach it to an anchor.

The returned object can be attached through `attachInstance()` or added directly to a Three.js parent.

### `attachInstance(ref,anchorname)`

Attaches an object to a named avatar anchor.

```js
avatar.attachInstance(sword,"RightWeapon");
```

| Parameter | Type | Description |
|---|---|---|
| `ref` | THREE.Object3D | Object to attach |
| `anchorname` | string | Target anchor name |

Returns: the supplied object.

The runtime:

1. Removes the object from its previous parent through Three.js reparenting.
2. Adds it to the target anchor.
3. Resets the object's local position.
4. Resets its local rotation.
5. Applies scale compensation for tracked accessory instances.

The object follows the anchor during animation and IK.

### `atachInstance(ref,anchorname)`

Compatibility alias matching the original public API spelling.

```js
avatar.atachInstance(sword,"RightWeapon");
```

### Attaching an external object

`attachInstance()` also accepts a Three.js object that was not created through `createInstance()`.

```js
const marker = new THREE.Group();

avatar.attachInstance(marker,"RightWeapon");
```

Only instances created through `createInstance()` are tracked by the runtime for instance-specific scale compensation and removal.

### `detachInstance(ref)`

Detaches an object from its current parent.

```js
const object = avatar.detachInstance(sword);
```

Returns: `THREE.Object3D`.

The method preserves the current world transform in the detached object's transform values.

After detachment, the object no longer belongs to the avatar hierarchy.

To keep it visible, add it to another scene parent:

```js
const object = avatar.detachInstance(sword);

scene.add(object);
```

The object is not destroyed by detachment.

### `removeInstance(ref)`

Removes a previously created accessory instance.

```js
avatar.removeInstance(sword);
```

The runtime:

- Removes the instance from its parent.
- Removes it from the internal instance registry.
- Disposes of cloned skeleton resources belonging to the instance.

The method raises an error for an unknown or already-removed instance.

### `getInstances()`

Returns all accessory instances created by the runtime that have not been removed.

```js
const instances = avatar.getInstances();
```

Returns: `THREE.Object3D[]`.

Detached instances remain in this list until `removeInstance()` is called.

Externally attached objects are not automatically added to the instance registry.

## Camera reference

### `getEyesTransforms()`

Returns the static camera reference transform created from the exported camera metadata.

```js
const eyes = avatar.getEyesTransforms();
```

Returns: `THREE.Object3D`.

The reference follows the avatar origin but is not updated from live head animations.

### Reading world position

```js
const position = eyes.getWorldPosition(
    new THREE.Vector3()
);
```

### Reading world orientation

```js
const rotation = eyes.getWorldQuaternion(
    new THREE.Quaternion()
);
```

### Positioning an application camera

```js
camera.position.copy(
    eyes.getWorldPosition(
        new THREE.Vector3()
    )
);

camera.quaternion.copy(
    eyes.getWorldQuaternion(
        new THREE.Quaternion()
    )
);
```

The application is responsible for deciding when to copy these transforms to its actual camera.

The avatar runtime does not create or control the application's camera.

## Complete API summary

| Method | Returns | Purpose |
|---|---|---|
| `constructor()` | Avatar | Create an unloaded controller |
| `load(filepath)` | Promise | Load an Avatar Creator GLB |
| `update(delta)` | void | Evaluate animation, IK, and overrides |
| `setHeight(value)` | void | Set avatar height |
| `setHipsHeight(value)` | void | Set pelvis vertical offset |
| `setRightHandTransform(target)` | void | Control right-hand IK |
| `setLeftHandTransform(target)` | void | Control left-hand IK |
| `setHeadRotation(rotation)` | void | Override head orientation |
| `setAnim(name,transition)` | void | Select animation |
| `setLeftHandPose(name,transition)` | void | Select left-hand pose |
| `setRightHandPose(name,transition)` | void | Select right-hand pose |
| `setRighHandPose(name,transition)` | void | Original right-hand alias |
| `setSkin(name,visible)` | null | Toggle mesh visibility |
| `createInstance(name)` | THREE.Group | Create an accessory instance |
| `attachInstance(ref,anchor)` | THREE.Object3D | Attach object to anchor |
| `atachInstance(ref,anchor)` | THREE.Object3D | Original attachment alias |
| `detachInstance(ref)` | THREE.Object3D | Detach object |
| `removeInstance(ref)` | void | Remove accessory instance |
| `getOriginTransform()` | THREE.Group | Return avatar root transform |
| `getEyesTransforms()` | THREE.Object3D | Return camera reference |
| `getSkinNames()` | string[] | List skin meshes |
| `getAccessoriesNames()` | string[] | List embedded accessories |
| `getAnimationsNames()` | string[] | List animations |
| `getHandPoseNames()` | string[] | List hand poses |
| `getInstances()` | THREE.Object3D[] | List active accessory instances |

## Full integration example

### `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>Avatar Runtime Example</title>
    <style>
        body {
            margin: 0;
            overflow: hidden;
        }

        canvas {
            display: block;
        }
    </style>
    <script type="importmap">
    {
        "imports": {
            "three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js",
            "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"
        }
    }
    </script>
</head>
<body>
    <script type="module" src="./main.js"></script>
</body>
</html>
```

### `main.js`

```js
import * as THREE from "three";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import Avatar from "./avatar.js";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202020);

const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.01,
    100
);

camera.position.set(0,1.1,3);

const renderer = new THREE.WebGLRenderer({
    antialias:true
});

renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth,window.innerHeight);

document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(
    0xffffff,
    0x444444,
    2
));

const light = new THREE.DirectionalLight(
    0xffffff,
    2
);

light.position.set(2,4,3);
scene.add(light);

const controls = new OrbitControls(
    camera,
    renderer.domElement
);

controls.target.set(0,0.9,0);
controls.update();

const avatar = new Avatar();

await avatar.load("/models/avatar.glb");

scene.add(avatar.getOriginTransform());

avatar.setHeight(1.8);
avatar.setHipsHeight(-0.15);

const animations = avatar.getAnimationsNames();

if (animations.length) {
    avatar.setAnim(animations[0],0);
}

const poses = avatar.getHandPoseNames();

if (poses.length) {
    avatar.setLeftHandPose(poses[0],200);
    avatar.setRightHandPose(poses[0],200);
}

console.log(avatar.getSkinNames());
console.log(avatar.getAccessoriesNames());

window.addEventListener("resize",() => {
    camera.aspect =
        window.innerWidth / window.innerHeight;

    camera.updateProjectionMatrix();

    renderer.setSize(
        window.innerWidth,
        window.innerHeight
    );
});

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

Run this example using an HTTP server, not directly through a `file://` URL.

## Error handling

The runtime intentionally uses straightforward error handling.

Invalid resources raise errors instead of being silently repaired.

Typical errors include:

- Invalid Avatar Creator manifest.
- Unsupported format version.
- Missing required skeleton bones.
- Missing finger joints.
- Missing camera metadata.
- Missing accessory models.
- Unknown animation names.
- Unknown hand-pose names.
- Unknown anchors.

The hosting application may handle loading failures with a standard `try/catch` block.

```js
try {
    await avatar.load("/models/avatar.glb");
} catch (error) {
    console.error(error);
}
```

## Runtime limitations

The standalone runtime is intentionally minimal.

It does not include:

- Avatar editing UI.
- File import controls.
- FBX parsing or animation retargeting.
- Physics.
- Collision detection.
- Full-body IK.
- Automatic skeleton repair for arbitrary third-party files.
- Network synchronization.
- Persistent runtime configuration.
- Automatic rendering or camera management.

These responsibilities remain outside the runtime.

## Runtime conventions

- `load()` is asynchronous.
- `update()` uses seconds.
- Animation transitions use milliseconds.
- Hand-pose transitions use milliseconds.
- Hand IK targets are in world space.
- Head rotation overrides are relative to the avatar root.
- The exported camera reference is independent of animation.
- Accessory names and animation names are defined by the GLB.
- Pose names are case-sensitive.
- The caller owns the Three.js renderer and application lifecycle.