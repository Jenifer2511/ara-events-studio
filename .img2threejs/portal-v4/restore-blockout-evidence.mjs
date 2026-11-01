import * as THREE from 'three';import fs from 'node:fs';
const p=new URL('./blockout-meshes.json',import.meta.url);const scene=JSON.parse(fs.readFileSync(p));fs.writeFileSync(new URL('./optimization-meshes.json',import.meta.url),JSON.stringify(scene));
const g=new THREE.CylinderGeometry(.5,.5,1,10,4).toNonIndexed();g.scale(3.9,.18,1.8);
scene.meshes=scene.meshes.filter(m=>['oval plinth','brass arch surround','left hinged ivory leaf','right hinged ivory leaf'].includes(m.name));const root=scene.meshes[0];root.positions=Array.from(g.attributes.position.array);root.normals=Array.from(g.attributes.normal.array);root.uvs=Array.from(g.attributes.uv.array);
for(const m of scene.meshes){m.color=[1,1,1];m.maps={}}
fs.writeFileSync(p,JSON.stringify(scene));
