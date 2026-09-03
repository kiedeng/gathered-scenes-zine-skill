'use strict';
const {fs,path,sharp,APPEARANCE_MODE,assert,hashFile,writeJson,parseArgs,decode,loadJob,renderFace,harmonizePatch}=require('./common.cjs');

async function compose(jobPath) {
  const job=await loadJob(jobPath);
  assert(!fs.existsSync(job.outputDir)||fs.readdirSync(job.outputDir).length===0,'Output directory is not empty; choose a new run directory.');
  const source=await decode(job.source);
  assert(source.info.width===job.sourceImage.width&&source.info.height===job.sourceImage.height,'Source coordinate system mismatch.');
  const {width,height}=job.canvas;
  const background=await sharp(job.background).autoOrient().toColourspace('srgb').resize(width,height,{fit:'fill'}).removeAlpha().raw().toBuffer();
  const final=Buffer.from(background),selection=Buffer.from(background),occupied=Buffer.alloc(width*height);
  const patches=[];
  for(const face of job.faces) {
    const patch=renderFace(source,face,job.canvas);
    const target=Buffer.alloc(patch.width*patch.height*3);
    for(let y=0;y<patch.height;y++)for(let x=0;x<patch.width;x++) {
      const local=y*patch.width+x,global=(y+patch.top)*width+x+patch.left;
      for(let c=0;c<3;c++)target[local*3+c]=background[global*3+c];
    }
    const faceRgba=face.appearanceMode===APPEARANCE_MODE.harmonized
      ? harmonizePatch(patch,target,face.harmonizeStrength,face.harmonizeRadiusPx*face.transform.scale)
      : patch.rgba;
    for(let y=0;y<patch.height;y++) for(let x=0;x<patch.width;x++) {
      const local=y*patch.width+x, global=(y+patch.top)*width+x+patch.left, alpha=faceRgba[local*4+3];
      if(!alpha)continue;
      assert(!occupied[global],'Face mattes overlap; correct placement before composing.');
      occupied[global]=1;
      for(let c=0;c<3;c++) final[global*3+c]=Math.round((faceRgba[local*4+c]*alpha+background[global*3+c]*(255-alpha))/255);
      const color=patch.core[local]?[0,220,255]:[255,180,0];
      for(let c=0;c<3;c++)selection[global*3+c]=Math.round(final[global*3+c]*.55+color[c]*.45);
    }
    patches.push({face,patch,faceRgba});
  }
  fs.mkdirSync(job.outputDir,{recursive:true});
  const imagePath=path.join(job.outputDir,'final.png');
  await sharp(final,{raw:{width,height,channels:3}}).png().toFile(imagePath);
  await sharp(final,{raw:{width,height,channels:3}}).resize({width:1200,height:2000,fit:'inside',withoutEnlargement:true}).jpeg({quality:93,chromaSubsampling:'4:4:4'}).toFile(path.join(job.outputDir,'preview.jpg'));
  await sharp(selection,{raw:{width,height,channels:3}}).resize({width:1500,height:2500,fit:'inside',withoutEnlargement:true}).png().toFile(path.join(job.outputDir,'selection-check.png'));
  const records=[];
  for(const {face,patch,faceRgba} of patches) {
    const prefix=path.join(job.outputDir,face.id);
    await sharp(patch.reference,{raw:{width:patch.width,height:patch.height,channels:3}}).png().toFile(prefix+'-reference.png');
    await sharp(patch.core,{raw:{width:patch.width,height:patch.height,channels:1}}).png().toFile(prefix+'-core.png');
    await sharp(faceRgba,{raw:{width:patch.width,height:patch.height,channels:4}}).png().toFile(prefix+'-patch.png');
    records.push({id:face.id,appearanceMode:face.appearanceMode,blendMode:face.blendMode,harmonizeStrength:face.harmonizeStrength,harmonizeRadiusPx:face.harmonizeRadiusPx,protectedPixels:patch.protectedPixels,bounds:{left:patch.left,top:patch.top,width:patch.width,height:patch.height}});
  }
  const manifest={schemaVersion:1,job:path.resolve(jobPath),jobSha256:hashFile(jobPath),sourceSha256:job.sourceSha256,
    finalSha256:hashFile(imagePath),canvas:job.canvas,faces:records,
    processing:{colorSpace:'sRGB',resampling:'inverse similarity transform, bilinear, round to uint8',blend:'per-face appearanceMode; exact preserves core RGB, harmonized shifts low-frequency tone while retaining source detail',sharp:sharp.versions.sharp},
    visualReview:'pending'};
  writeJson(path.join(job.outputDir,'composition.json'),manifest);
  return {image:imagePath,faces:records};
}
if(require.main===module) {
  const a=parseArgs();
  compose(a.job).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={compose};
