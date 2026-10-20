
# Three.js Avatar IK Playground

An interactive 3D avatar playground built with [Three.js](https://threejs.org/), featuring analytical inverse kinematics (IK), Mixamo animation retargeting, and real-time skeletal pose manipulation.

This project is a proof of concept for experimenting with procedural character animation, articulated limb control, and animation-driven inverse kinematics in a browser-based 3D environment.

**[Live Demo](https://qmisslin.github.io/threejs-vr-avatar/)** | **[GitHub Repository](https://github.com/qmisslin/threejs-vr-avatar)**

## Features

### Analytical Inverse Kinematics

- Custom analytical two-bone IK solver based on the law of cosines.
- IK support for both arms and legs.
- Configurable pole targets to control elbow and knee bending directions.
- Independent IK activation for the left and right arms.
- Optional limb stretching for reaching otherwise unreachable hand targets.
- Preservation of end-effector orientation and position.
- Integration with animated skeletal poses.

### Avatar Animation

- FBX character loading using Three.js `FBXLoader`.
- Support for Mixamo-compatible skeletal rigs.
- Animation retargeting between compatible skeletons.
- Bone name normalization and rest-pose rotation offsets.
- Hip translation scaling between source and target skeletons.
- Walk and idle animation playback.
- Animation selection and play/pause controls.
- Automatic avatar height normalization.

### Procedural Pose Control

- Adjustable avatar vertical position for crouching.
- Leg IK compensation to preserve animated foot positions during crouching.
- Independent hand position and rotation controls.
- Configurable elbow and knee pole targets.
- Real-time blending of animation-driven poses and IK constraints.

### Interactive Debugging

- Real-time 3D rendering with orbit camera controls.
- Optional skeleton visualization.
- Colored transform markers for hands and pole targets.
- Interactive sidebar with numeric transformation inputs.
- Fine-grained parameter adjustment using the mouse wheel.

## Live Demo

Try the interactive demo directly in your browser:

**https://qmisslin.github.io/threejs-vr-avatar/**

The demo provides a 3D viewport alongside a control panel for manipulating animations, IK targets, and avatar transformations in real time.

A modern browser with WebGL and JavaScript module support is required.

## Getting Started

### Requirements

- A modern browser with WebGL support.
- A local HTTP server for development.
- An internet connection to load Three.js from the CDN.

No build tools, package manager, or installation of dependencies are required.

### Installation

Clone the repository:

```bash
git clone https://github.com/qmisslin/threejs-vr-avatar.git
cd threejs-vr-avatar
```

Start a local HTTP server:

```bash
python3 -m http.server 8000
```

Open the application:

http://localhost:8000

The avatar and animation files are loaded asynchronously when the application starts.

## Controls

### View

| Control | Description |
|---------|-------------|
| Display transform | Show or hide visual markers for IK targets and pole targets. |
| Display skeleton | Show or hide the avatar's skeletal hierarchy. |
| Orbit camera | Rotate, zoom, and inspect the avatar using the mouse. |

### Animation

| Control | Description |
|---------|-------------|
| Animation | Switch between walk and idle animations. |
| Play / Pause | Start or pause the current animation. |

The walk animation is selected by default.

### Avatar

| Control | Description |
|---------|-------------|
| Position Y | Adjust the vertical position of the hips to simulate crouching. |

The crouch offset is constrained to a configurable range. Leg IK compensates for the displacement to preserve the animated foot targets.

### Left and Right Hands

Each hand has independent controls:

| Control | Description |
|---------|-------------|
| Enable arm IK | Enable or disable IK for the corresponding arm. |
| Position X/Y/Z | Move the hand target in 3D space. |
| Pole X/Y/Z | Adjust the elbow bending direction. |
| Rotation X/Y/Z | Set the hand target orientation in degrees. |

When arm IK is disabled, the corresponding arm retains its original animation-driven pose.

### Left and Right Legs

| Control | Description |
|---------|-------------|
| Pole X/Y/Z | Adjust the corresponding knee pole target. |

Leg IK is applied when compensating for manually controlled vertical hip displacement.

## Technical Overview

### Two-Bone IK Solver

The custom solver in `ik.js` operates on a chain of three joints:

1. Root joint.
2. Intermediate joint.
3. End effector.

The solver uses the law of cosines to calculate the intermediate joint position based on segment lengths and the desired end-effector target.

Pole targets determine the bending plane, while quaternion rotations align the skeletal segments with the calculated positions.

Additional operations support:

- Restoring the original animated pose.
- Preserving end-effector orientation.
- Correcting residual end-effector positioning errors.
- Adjusting joint translations when stretching is enabled.

### Animation Retargeting

The animation system loads Mixamo-compatible FBX animation files and maps their tracks onto the avatar skeleton.

The retargeting pipeline includes:

- Bone identification through normalized names.
- Mapping compatible source tracks to target bones.
- Applying rest-pose quaternion offsets.
- Scaling animated hip translations to the target proportions.
- Creating reusable Three.js animation clips.

Animation playback is managed with `THREE.AnimationMixer`.

### Animation and IK Pipeline

Each rendered frame follows this sequence:

1. Restore the original limb poses from the previous animation evaluation.
2. Apply the manually configured hip displacement.
3. Evaluate the active skeletal animation.
4. Capture the resulting animated joint positions and orientations.
5. Apply leg IK when crouch compensation is required.
6. Apply arm IK to enabled arms using their configured targets.
7. Update the final skeleton transformations.
8. Render the scene.

This separation keeps the original animation poses available while allowing procedural adjustments to individual limbs.

## Project Structure

```text
threejs-vr-avatar/
├── index.html   # Application entry point, layout, and import map
├── scene.js     # Three.js scene, rendering, camera, and UI controls
├── avatar.js    # Avatar setup, retargeting, animation, and IK integration
├── ik.js        # Analytical two-bone inverse kinematics solver
├── avatar.fbx   # Rigged 3D character model
├── walk.fbx     # Walking animation
├── idle.fbx     # Idle animation
└── .gitignore   # Git exclusions
```

## Technologies

- **Three.js** — 3D rendering, skeletal animation, and mathematical utilities.
- **JavaScript (ES Modules)** — Application logic and modular architecture.
- **WebGL** — Hardware-accelerated browser rendering.
- **FBXLoader** — Loading character models and animation assets.
- **OrbitControls** — Interactive camera navigation.
- **Mixamo-compatible FBX assets** — Character rigging and skeletal animations.
- **GitHub Pages** — Static hosting for the online demonstration.

The application currently uses Three.js `0.186.1` through a CDN import map.

## Configuration

The `Scene` constructor supports the following options:

```javascript
const scene = new Scene({
    avatarUrl: './avatar.fbx',
    animationUrls: {
        walk: './walk.fbx',
        idle: './idle.fbx'
    },
    characterHeight: 1.8,
    minCrouch: 0.0,
    maxCrouch: 0.5
});

scene.start();
```

These options control the avatar model, animation sources, normalized character height, and crouch limits.

Additional compatible animations can be registered through the `animationUrls` configuration.

## Current Scope

This project focuses on browser-based avatar animation and procedural skeletal manipulation.

It currently does not implement:

- WebXR session management.
- VR headset or controller tracking.
- Full-body motion capture.
- Physics-based collision handling.
- Multiplayer synchronization.

Its IK and animation architecture can serve as a foundation for future immersive avatar interaction experiments.

## Notes

- The avatar must contain a compatible skeletal hierarchy with the required Mixamo limb bones.
- The animation files must contain compatible animation tracks.
- The main avatar FBX file is approximately 51.5 MiB, so initial loading time depends on network conditions.
- The application requires an HTTP server for local development rather than direct `file://` access.
- Three.js dependencies are loaded from an external CDN.

## Author

Developed by [qmisslin](https://github.com/qmisslin).

Project repository: https://github.com/qmisslin/threejs-vr-avatar
