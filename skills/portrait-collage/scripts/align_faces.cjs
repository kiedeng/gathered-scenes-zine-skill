'use strict';
const {fs,path,sharp,BLEND_MODE,APPEARANCE_MODE,assert,digest,hashFile,readJson,writeJson,absolute,parseArgs,polygonValid,inside,distance,fitSimilarity,bounds}=require('./common.cjs');

async function align(draftPath,outPath) {
  const draft=readJson(draftPath),base=path.dirname(path.resolve(draftPath));
  assert(!fs.existsSync(outPath),'Job exists; choose a new job filename.');
  const source=absolute(draft.source,base),background=absolute(draft.background,base);
  const src=readJson(absolute(draft.sourceDetections,base)),target=readJson(absolute(draft.targetDetections,base));
  assert(src.inputSha256===hashFile(source),'Source detections do not match input.');
  assert(target.inputSha256===hashFile(background),'Target detections do not match background.');
  assert(src.faces.length===draft.faces.length && src.faces.length>0,'All detected source faces must be accounted for.');
  assert(target.faces.length===src.faces.length,'Source and target face counts differ; inspect the background.');
  assert(new Set(draft.faces.map(f=>f.sourceId)).size===draft.faces.length,'Duplicate source mapping.');
  assert(new Set(draft.faces.map(f=>f.targetId)).size===draft.faces.length,'Duplicate target mapping.');
  const canvas=draft.canvas;
  assert(Number.isInteger(canvas.width)&&Number.isInteger(canvas.height)&&canvas.width>=512&&canvas.height>=512&&canvas.width*canvas.height<=40000000,'Invalid canvas.');
  const meta=await sharp(background).metadata();
  const bw=meta.autoOrient.width,bh=meta.autoOrient.height;
  assert(Math.abs(canvas.width/canvas.height-bw/bh)<.003,'Canvas and background aspect ratios differ; avoid stretching people.');
  const faces=draft.faces.map(f=>{
    assert(/^[a-z0-9-]+$/.test(f.id),'Use a stable lowercase face ID.');
    const sf=src.faces.find(x=>x.id===f.sourceId),tf=target.faces.find(x=>x.id===f.targetId);
    assert(sf&&tf,'Missing source/target face.');
    assert(typeof f.identityReview==='string'&&f.identityReview.length>=8,'Explain the visually checked source/target correspondence.');
    const targetAnchors=tf.anchors.map(p=>[p[0]*canvas.width/target.image.width,p[1]*canvas.height/target.image.height]);
    const transform=fitSimilarity(sf.anchors,targetAnchors);
    assert(transform.normalizedResidual<=.12,'Head geometry differs too much; revise the background.');
    assert(Math.abs(transform.rotationDegrees)<=30,'Head rotation exceeds v1 alignment range.');
    const box=bounds(sf.corePolygon),center=[(box.left+box.right)/2,(box.top+box.bottom)/2];
    const featherPx=f.featherPx ?? Math.max(3,(box.right-box.left)*.025);
    const outerPolygon=f.outerPolygon ?? sf.corePolygon.map(p=>[center[0]+(p[0]-center[0])*1.24,center[1]+(p[1]-center[1])*1.18]);
    assert(polygonValid(outerPolygon),'Invalid outer polygon.');
    assert(sf.corePolygon.every(p=>inside(p,outerPolygon)&&distance(p,outerPolygon)>=featherPx),'Outer polygon excludes part of the full face. Enlarge the outer matte, never shrink the core.');
    assert(outerPolygon.every(p=>p[0]>=0&&p[1]>=0&&p[0]<src.image.width-1&&p[1]<src.image.height-1),'Matte extends past source bounds.');
    const blendMode=f.blendMode ?? BLEND_MODE.adaptiveRing;
    assert(Object.values(BLEND_MODE).includes(blendMode),'Unknown face blend mode.');
    const appearanceMode=f.appearanceMode ?? APPEARANCE_MODE.exact;
    assert(Object.values(APPEARANCE_MODE).includes(appearanceMode),'Unknown face appearance mode.');
    const harmonizeStrength=appearanceMode===APPEARANCE_MODE.harmonized?(f.harmonizeStrength ?? .32):undefined;
    const harmonizeRadiusPx=appearanceMode===APPEARANCE_MODE.harmonized?(f.harmonizeRadiusPx ?? Math.max(4,(box.right-box.left)*.035)):undefined;
    if(appearanceMode===APPEARANCE_MODE.harmonized) {
      assert(harmonizeStrength>=0&&harmonizeStrength<=.6,'harmonizeStrength must be 0..0.6.');
      assert(harmonizeRadiusPx>=2&&harmonizeRadiusPx<=200,'harmonizeRadiusPx must be 2..200 source pixels.');
    }
    return {...f,outerPolygon,featherPx,blendMode,appearanceMode,harmonizeStrength,harmonizeRadiusPx,transform,corePolygon:sf.corePolygon};
  });
  const protectionPath=path.resolve(path.dirname(outPath),path.basename(outPath,'.json')+'.protection.json');
  const lock={schemaVersion:1,sourceSha256:hashFile(source),sourceDetectionsSha256:hashFile(absolute(draft.sourceDetections,base)),
    faces:faces.map(f=>({id:f.id,sourceId:f.sourceId,corePolygon:f.corePolygon}))};
  fs.mkdirSync(path.dirname(path.resolve(outPath)),{recursive:true});
  writeJson(protectionPath,lock);
  const job={schemaVersion:1,source,sourceSha256:hashFile(source),background,backgroundSha256:hashFile(background),
    sourceImage:src.image,canvas,design:draft.design ?? {},outputDir:absolute(draft.outputDir,base),
    protection:protectionPath,protectionSha256:hashFile(protectionPath),
    faces:faces.map(({corePolygon,...face})=>face)};
  job.alignmentSha256=digest(Buffer.from(JSON.stringify(job.faces.map(f=>({id:f.id,sourceId:f.sourceId,targetId:f.targetId,transform:f.transform})))));
  writeJson(outPath,job);
  return {job:path.resolve(outPath),faces:faces.map(f=>({id:f.id,scale:f.transform.scale,rotation:f.transform.rotationDegrees,residual:f.transform.normalizedResidual}))};
}
if(require.main===module) {
  const a=parseArgs();
  align(a.draft,a.out).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={align};
