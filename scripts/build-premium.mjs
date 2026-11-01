import {build} from 'esbuild';
import {rm,copyFile,access} from 'node:fs/promises';
await rm('dist/assets/runtime',{recursive:true,force:true});
const pending=process.argv.includes('--allow-pending-model');
await build({entryPoints:['src/enhancements.js'],bundle:true,splitting:true,format:'esm',platform:'browser',target:['es2022'],outdir:'dist/assets/runtime',entryNames:'[name]',chunkNames:'chunks/[name]-[hash]',minify:true,metafile:true,legalComments:'linked',logLevel:'info',external:pending?['./portal-model.js']:[]});

for(const [source,name] of [['node_modules/three/LICENSE','LICENSE-three.txt'],['node_modules/motion/LICENSE','LICENSE-motion.txt'],['node_modules/framer-motion/LICENSE','LICENSE-framer-motion.txt'],['node_modules/motion-dom/LICENSE.md','LICENSE-motion-dom.txt']]){try{await access(source);await copyFile(source,`dist/assets/runtime/${name}`);}catch{}}
