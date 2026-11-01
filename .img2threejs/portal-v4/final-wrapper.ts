import * as ImportedThree from 'three';
import { createStylizedIvoryAndBrassDoubleDoorArchPortalModel } from './createPortalModel';
/** Stylized concept prop; generated-reference PBR estimates, not a physical venue reconstruction. */
export function createPortalModel(THREE = ImportedThree, options = {}) {
  let resolveReady, rejectReady, disposed = false;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const manager = new THREE.LoadingManager();
  manager.onLoad = () => resolveReady();
  manager.onError = url => rejectReady(new Error(`Portal texture failed: ${url}`));
  const loader = new THREE.TextureLoader(manager);
  const texturePool = new Map();
  const pooledLoader = { load(url) {
    if (texturePool.has(url)) return texturePool.get(url);
    const texture = loader.load(url, loaded => { if (disposed) loaded.dispose(); });
    texturePool.set(url, texture);
    return texture;
  }};
  const group = createStylizedIvoryAndBrassDoubleDoorArchPortalModel({
    castShadow: false, receiveShadow: false,
    textureAnisotropy: options.textureAnisotropy ?? 2,
    textureLoader: pooledLoader,
  });
  const {leftDoor,rightDoor} = group.userData.sculptRuntime.nodes;
  leftDoor.rotation.set(0,0,0);rightDoor.rotation.set(0,0,0);
  group.userData.assetProvenance = {
    role:'stylized illustrative generated-reference concept',
    visualEvidence:'offscreen GLES GGX geometry/material preview; browser Three.js shading parity unverified',
    triangles:4136, hingeRangeRadians:[0,Math.PI/3],
    productionMapBytes:1590865,estimatedMapGpuBytes:17825792,
  };
  function dispose() {
    if (disposed) return;
    disposed=true;
    const geometries=new Set(), materials=new Set(), textures=new Set(texturePool.values());
    group.traverse(object=>{
      if(object.geometry)geometries.add(object.geometry);
      for(const material of (Array.isArray(object.material)?object.material:[object.material])) {
        if(!material)continue;materials.add(material);
        for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
      }
    });
    for(const geometry of geometries)geometry.dispose();
    for(const material of materials)material.dispose();
    for(const texture of textures)texture.dispose();
    texturePool.clear();group.clear();delete group.userData.sculptRuntime;
  }
  return {group,leftDoor,rightDoor,dispose,ready};
}
