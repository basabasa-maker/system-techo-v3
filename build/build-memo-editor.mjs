// Build the checked-in editor runtime from fixed npm dependencies; no runtime CDN.
// Supply a directory containing package.json, package-lock.json and node_modules.
// To reproduce, extract packageManifest/packageLock from vendor/codemirror/SOURCE.json,
// run npm ci --ignore-scripts in that directory, then pass --deps <directory> here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const flag=process.argv.indexOf('--deps');
if(flag<0||!process.argv[flag+1])throw new Error('Usage: node build/build-memo-editor.mjs --deps <npm project>');
const deps=path.resolve(process.argv[flag+1]),require=createRequire(path.join(deps,'package.json'));
const esbuild=require('esbuild');
const expected={'@codemirror/view':'6.44.0','@codemirror/state':'6.7.6','@codemirror/commands':'6.11.2','esbuild':'0.28.2'};
for(const [name,version]of Object.entries(expected)){
 const info=JSON.parse(await fs.readFile(path.join(deps,'node_modules',name,'package.json'),'utf8'));
 if(info.version!==version)throw new Error('Unexpected dependency version: '+name);
}
const entry=`export {EditorState,EditorSelection,StateEffect,Prec} from '@codemirror/state';
export {EditorView,Decoration,ViewPlugin,WidgetType,keymap,placeholder} from '@codemirror/view';
export {history,historyKeymap,defaultKeymap,insertNewline} from '@codemirror/commands';`;
const directory=path.join(root,'vendor/codemirror');await fs.mkdir(directory,{recursive:true});
await esbuild.build({stdin:{contents:entry,resolveDir:deps,sourcefile:'memo-editor-runtime.mjs',loader:'js'},bundle:true,format:'esm',platform:'browser',target:['es2020'],minify:true,legalComments:'none',outfile:path.join(directory,'codemirror.js')});
const manifest=JSON.parse(await fs.readFile(path.join(deps,'package.json'),'utf8'));
const lock=JSON.parse(await fs.readFile(path.join(deps,'package-lock.json'),'utf8'));
const packages=[],licenses=[];
for(const [relative,info]of Object.entries(lock.packages||{})){
 if(!relative||relative.includes('node_modules/esbuild')||relative.includes('node_modules/@esbuild/'))continue;
 const local=path.join(deps,relative),pkg=JSON.parse(await fs.readFile(path.join(local,'package.json'),'utf8'));
 const file=(await fs.readdir(local)).find(name=>/^license(?:\.|$)/i.test(name));
 if(!file)throw new Error('Missing dependency license: '+pkg.name);
 const license=await fs.readFile(path.join(local,file),'utf8');
 licenses.push('===== '+pkg.name+' '+pkg.version+' =====\n'+license);
 packages.push({name:pkg.name,version:pkg.version,resolved:info.resolved,integrity:info.integrity,license:pkg.license});
}
await fs.writeFile(path.join(directory,'LICENSES.txt'),licenses.join('\n\n')+'\n');
const bytes=await fs.readFile(path.join(directory,'codemirror.js'));
const source={name:'CodeMirror 6 memo editor runtime',license:'MIT',official:'https://codemirror.net/',repository:'https://code.haverbeke.berlin/codemirror/view',entry,build:{tool:'esbuild',version:expected.esbuild,format:'esm',target:'es2020',minify:true},sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,packages,packageManifest:manifest,packageLock:lock};
await fs.writeFile(path.join(directory,'SOURCE.json'),JSON.stringify(source,null,2)+'\n');
console.log(JSON.stringify({bytes:bytes.length,sha256:source.sha256,runtimePackages:packages.length}));
