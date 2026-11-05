# Avatar Creator — Editor Guide

This document describes the Avatar Creator editing workflow, its individual views, and the way avatar configuration is stored and exported.

## Overview

Avatar Creator provides seven main editor views:

| View | Purpose |
|---|---|
| Loader | Import avatars and animations |
| IK | Configure body and limb targets |
| View | Configure the camera |
| Assets | Import and configure accessories |
| Anchors | Configure attachment points |
| Hands | Create and manage finger poses |
| Export | Package the avatar into GLB |

All editor views operate on the same avatar session.

Switching between views does not create an independent avatar or reset the current configuration.

## Loader

The Loader view manages the avatar model and animations.

### Supported files

| Format | Usage |
|---|---|
| FBX | Import a Mixamo avatar or animations |
| GLB | Restore an avatar exported by Avatar Creator |

### FBX import

The editor accepts Mixamo-compatible FBX files containing a skinned humanoid model, animations, or both.

When an avatar FBX is loaded:

1. The skeleton is inspected.
2. Mixamo bone names are normalized.
3. The avatar is rescaled to the reference height.
4. A common `root` bone is established.
5. The skinned meshes and their bindings are preserved.
6. Imported animations are made available in the session.

The normalized avatar uses a reference height of **1.75 m**.

This makes spatial configuration more consistent across supported avatars.

### GLB import

Avatar Creator GLB files restore the avatar and the metadata embedded by the exporter.

Depending on the contents of the file, the import restores:

- Avatar model.
- Skeleton.
- Materials and textures.
- Animations.
- IK configuration.
- Camera reference.
- Asset records and embedded models.
- Anchor records.
- Hand poses.

The GLB import path also resolves skeletal naming differences introduced by glTF loading, including duplicate names with numeric suffixes.

### Animation playback

Imported animations are available through the animation selector.

The editor supports:

- Selecting an animation.
- Playing an animation.
- Pausing animation playback.
- Importing additional FBX animations.

Animation names must be unique within the avatar session.

### Reset

Reset restores the editor's default configuration.

It clears the stored editor data associated with the application, including imported files and configuration in IndexedDB.

Export important work before performing a reset.

## Inverse Kinematics

The IK view provides interactive control over body targets.

### Supported IK chains

The editor uses four two-bone chains:

| Chain | Start | Middle | End |
|---|---|---|---|
| Left arm | LeftArm | LeftForeArm | LeftHand |
| Right arm | RightArm | RightForeArm | RightHand |
| Left leg | LeftUpLeg | LeftLeg | LeftFoot |
| Right leg | RightUpLeg | RightLeg | RightFoot |

Each chain consists of three skeletal joints and two segments.

The IK solver calculates the required bone rotations to approach the target while respecting the lengths of the segments.

### Pelvis control

The pelvis target controls the vertical displacement of `Hips`.

This is used to configure crouching and standing adjustments.

The pelvis displacement is distinct from the avatar's overall scale.

### Hand targets

Each hand has a position and orientation target.

These targets determine where the IK solver attempts to place the end of the arm.

The hand targets are independent of the animation-controlled wrist bones.

### Pole targets

Pole targets control the preferred bending direction of the IK chains.

Available pole targets:

- `leftElbow`
- `rightElbow`
- `leftKnee`
- `rightKnee`

Pole targets help prevent ambiguous elbow and knee orientations.

### Mirroring

The editor supports mirroring relevant IK targets across the avatar's symmetry axis.

### Saved IK configuration

The configuration is stored in the avatar metadata.

It includes:

- Pelvis vertical offset.
- Pelvis reference position.
- Hand target transforms.
- Elbow pole positions.
- Knee pole positions.

For the current export convention, these settings use the version 3 IK metadata format.

## Camera View

The View page is dedicated to the camera reference.

It provides:

- Avatar preview.
- First-person preview.
- Camera reference placement.
- Camera orientation configuration.
- Camera reset.

### Camera reference

The camera reference is not an arbitrary point evaluated from a live head animation.

Its configuration defines a stable position relative to the avatar's rig.

The default reference is calculated near the head.

### Camera orientation

The camera configuration includes a direction represented by `orbitPosition`.

This is used to construct the reference orientation.

### Exported camera metadata

The camera state is included in the GLB metadata.

The standalone runtime exposes it as an `Object3D` through `getEyesTransforms()`.

This transform can be used to position an application camera.

## Assets

The Assets view manages reusable models.

### Import

Supported asset formats:

- FBX.
- GLB.

Assets are independent from the avatar skeleton.

### Asset configuration

Each asset has a record containing its identity and transforms.

The configuration includes:

- Name.
- Origin offset.
- Model position.
- Model rotation.
- Model scale.

### Normalization

Imported assets may use different modeling units and dimensions.

Avatar Creator normalizes assets against their bounding box so the same asset configuration can be applied consistently.

The normalization process uses the largest dimension of the imported model.

### Asset library

Assets are stored separately from anchor definitions.

An asset can therefore be instantiated multiple times or attached to different anchors.

### Export

The GLB exporter embeds the asset sources into the optional accessory library scene.

These embedded models are reused by the standalone runtime without requiring separate FBX or GLB requests.

## Anchors

Anchors define named attachment points relative to bones.

### Creating an anchor

An anchor consists of:

- A unique identifier.
- A name.
- A parent bone name.
- A local offset.
- A local rotation.
- A local scale.

The initial offset is zero, placing the anchor at its parent bone.

### Parent bones

An anchor can be attached to a supported skeleton bone.

Typical examples:

| Anchor | Parent bone |
|---|---|
| RightWeapon | RightHand |
| LeftWeapon | LeftHand |
| HeadAccessory | Head |
| BackAccessory | Spine2 |
| WaistAccessory | Hips |

These names are examples, not predefined anchors.

### Metric position offsets

Anchor positions use:

```json
{
    "positionSpace": "meters"
}
```

With this convention, the saved position is expressed as a metric offset in the oriented coordinate frame of the parent bone.

The offset is converted back into the active bone's local coordinates when the anchor is reconstructed.

This prevents large positioning errors caused by different bone-scale distributions between FBX and GLB avatars.

### Anchor operations

The editor supports:

- Creation.
- Selection.
- Renaming.
- Duplication.
- Removal.
- Parent bone changes.
- Position adjustments.
- Rotation adjustments.
- Mirroring.

### Parent bone changes

Changing the parent bone preserves the anchor's world transform at the moment of reparenting.

The resulting offset is then saved relative to the new parent bone.

### Mirroring

Mirroring changes the anchor to the corresponding opposite-side bone when available.

The mirror operation is based on the normalized anchor offset and orientation.

### Asset preview

The editor uses a shared asset preview to visualize how a model would appear attached to the selected anchor.

The preview configuration is not stored as an individual asset reference within every anchor.

### Migrating older anchors

Older anchor records may contain positions in raw bone-local coordinates.

These records need conversion to the metric format.

For reliable conversion:

1. Load the avatar used when the original anchors were created.
2. Restore the original anchor configuration.
3. Allow the editor to convert the offsets.
4. Verify the positions.
5. Save or export the updated configuration.

Migrating an offset using a different avatar can produce incorrect results because the original scale is unknown.

## Hands

The Hands view manages reusable finger poses.

### Finger joints

Each hand supports five fingers:

- Thumb.
- Index.
- Middle.
- Ring.
- Pinky.

Each finger contains three configurable joints.

A complete hand pose therefore contains:

- 15 joints for the left hand.
- 15 joints for the right hand.
- 30 joint rotations in total.

### Pose representation

Every joint stores a quaternion:

```json
[0,0,0,1]
```

These values represent rotation deltas relative to the corresponding bind-pose reference.

An identity quaternion represents a neutral rotation delta.

### Pose operations

Available operations include:

- Creating a named pose.
- Selecting a pose.
- Editing finger rotations.
- Mirroring rotations.
- Resetting a pose.
- Removing a pose.
- Importing poses from a GLB file.

### Default pose

When no custom pose is active, the animation controls the fingers.

Selecting a custom pose applies its rotation deltas over the reference finger orientations.

### GLB hand-pose import

The Hands view can read the pose collections stored in the metadata of a compatible GLB file.

The hand-pose importer reads the GLB JSON metadata without needing to instantiate the entire avatar model.

Only valid and complete pose records are accepted.

Existing pose names can be updated by import.

### Saving

The hand-pose collection is stored in the current avatar session metadata and included during export.

## Export

The Export view displays an inventory of the resources that will be written into the GLB.

### Exported categories

| Category | Contents |
|---|---|
| Skeleton | Root and humanoid bones |
| Skins | Skinned mesh objects |
| IK | Pelvis, hand targets, and pole settings |
| Camera | Camera reference configuration |
| Assets | Reusable accessory source models |
| Anchors | Named bone attachment points |
| Hand poses | Named left/right hand pose records |
| Animations | Animation clips |

### Export process

The exporter:

1. Waits for the accessory resources to be available.
2. Clones the avatar to avoid modifying the editor scene.
3. Removes editor-only visualization objects.
4. Prepares and validates the skinned meshes.
5. Preserves the skeleton bindings.
6. Serializes the animation clips.
7. Embeds configuration metadata.
8. Adds the optional asset library scene.
9. Produces a binary GLB file.

### Editor-only objects

Visual helpers used by the editor are not intended to appear in the exported avatar.

These include selection highlights, manipulation markers, and anchor previews.

Their configuration is preserved as metadata where relevant.

### Textures

The exporter includes supported texture data when available.

References to textures without valid image data may be skipped to prevent the entire export from failing.

Verify the exported appearance if source files contain external or unsupported textures.

### Export compatibility

The resulting GLB is intended for:

- Reimport into Avatar Creator.
- Consumption by the standalone `avatar.js` runtime.
- Generic glTF tools that support the standard glTF portions of the file.

Avatar Creator-specific metadata is not automatically interpreted by generic glTF viewers.

## Persistence

The editor stores local state in the browser using IndexedDB.

The application database is named:

```text
avatar-creator
```

Its storage includes:

- Imported files.
- Current avatar reference.
- Animation references.
- Selected animation.
- Playback state.
- Avatar metadata.
- Camera state.

### Browser storage scope

IndexedDB is specific to the browser origin and profile.

The stored configuration is not automatically synchronized across browsers or devices.

Exporting a GLB is the recommended way to move a configured avatar to another environment.

## Recommended workflow

For consistent results:

1. Import and validate the avatar.
2. Configure animations.
3. Configure IK.
4. Set the camera reference.
5. Import accessories.
6. Define and verify anchors.
7. Create hand poses.
8. Export.
9. Reimport the GLB into the editor for verification.
10. Test the GLB with the standalone runtime.

## Troubleshooting

### Invalid IK joint hierarchy

The imported avatar does not provide a valid connected chain for one or more required IK members, or the selected bones do not belong to the same hierarchy.

Verify the skeleton and use an Avatar Creator export produced from a compatible Mixamo avatar.

### Incorrect anchor positions

Check that the anchor record uses `positionSpace: "meters"`.

Older local-space offsets must be converted using the avatar on which they were originally configured.

### Unsupported glTF asset

The loader expects glTF 2.0.

If importing from an iframe, make sure binary data passed to GLTFLoader is represented by an `ArrayBuffer` from the appropriate JavaScript context.

### Missing textures

Verify that the source texture files were properly available during asset import and export.

### Missing hand poses

A pose must contain valid quaternion data for every required finger joint on both hands.

Incomplete records may be ignored by the hand-pose importer.

### Lost editor configuration

Verify that the application is being opened under the same browser origin and profile.

A browser reset, IndexedDB deletion, or change of local server origin can remove access to previously stored settings.