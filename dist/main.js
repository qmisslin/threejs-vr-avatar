import Avatar from "./avatar.js";

const avatar = new Avatar();

await avatar.load("./avatar.glb");

scene.add(avatar.getOriginTransform());

avatar.setHeight(1.8);
avatar.setHipsHeight(-0.15);

avatar.setAnim("idle", 0);
avatar.setHipsHeight(0); // reset hips height

console.log("Animations names : ", avatar.getAnimationsNames());
console.log("AccessoriesNames", avatar.getAccessoriesNames());
console.log("Hands poses names", avatar.getHandPoseNames());

setTimeout(() => {
    console.log("Active walk and thumbsup after 3 secondes");
    avatar.setAnim("walk", 1000);
    avatar.setRightHandPose("thumbsup", 1000);
}, 3000);

setTimeout(() => {
    console.log("Disable ik and set hips height after 6 secondes");
    avatar.setLeftHandTransform(null);
    avatar.setRightHandTransform(null);
    avatar.setHipsHeight(-0.4); // set hips
}, 6000);

setTimeout(() => {
    console.log("Reset hips height after 9 secondes");
    avatar.setHipsHeight(0); // set hips
}, 9000);


const timer = new THREE.Timer();
timer.connect(document);

function animate(timestamp) {
    requestAnimationFrame(animate);

    timer.update(timestamp);
    avatar.update(timer.getDelta());

    renderer.render(scene, camera);
}

requestAnimationFrame(animate);