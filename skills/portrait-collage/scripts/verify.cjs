'use strict';
const {fs,path,sharp,APPEARANCE_MODE,assert,hashFile,readJson,writeJson,parseArgs,decode,loadJob,renderFace}=require('./common.cjs');

async function verify(jobPath,options={}) {
  const job=await loadJob(jobPath),source=await decode(job.source);
  const imagePath=options.image?path.resolve(options.image):path.join(job.outputDir,'final.png');
  const metadata=await sharp(imagePath).metadata();
  assert(metadata.format==='png','Strict verification requires the lossless PNG, not a JPEG preview.');
  const actual=await decode(imagePath),{width,height}=job.canvas;
  assert(actual.info.width===width&&actual.info.height===height,'Final image dimensions changed.');
  const manifest=readJson(path.join(job.outputDir,'composition.json'));
  assert(manifest.jobSha256===hashFile(jobPath),'Job changed after composition.');
  const checks=[],panels=[];
  for(const face of job.faces) {
    const patch=renderFace(source,face,job.canvas);
    let changedPixels=0,changedChannels=0,maxDifference=0;
    const seen=Buffer.alloc(patch.width*patch.height*3),diff=Buffer.alloc(seen.length),context=Buffer.alloc(seen.length);
    for(let y=0;y<patch.height;y++)for(let x=0;x<patch.width;x++) {
      const local=y*patch.width+x,global=(y+patch.top)*width+x+patch.left;
      let changed=false;
      for(let c=0;c<3;c++) {
        seen[local*3+c]=actual.data[global*3+c];
        context[local*3+c]=seen[local*3+c];
        if(patch.core[local]) {
          const delta=Math.abs(seen[local*3+c]-patch.reference[local*3+c]);
          maxDifference=Math.max(maxDifference,delta);
          if(delta){changedChannels++;changed=true;}
        }
      }
      if(changed)changedPixels++;
      const sourceDelta=Math.max(...[0,1,2].map(c=>Math.abs(seen[local*3+c]-patch.reference[local*3+c])));
      const shade=face.appearanceMode===APPEARANCE_MODE.harmonized
        ? (patch.core[local]?[Math.min(255,sourceDelta*5),90,170]:[28,28,28])
        : (changed?[255,0,60]:(patch.core[local]?[30,120,80]:[28,28,28]));
      for(let c=0;c<3;c++)diff[local*3+c]=shade[c];
    }
    checks.push(face.appearanceMode===APPEARANCE_MODE.harmonized
      ? {id:face.id,appearanceMode:face.appearanceMode,identityRegionPixels:patch.protectedPixels,pixelVerification:'not-applicable',pass:null}
      : {id:face.id,appearanceMode:face.appearanceMode,protectedPixels:patch.protectedPixels,changedPixels,changedChannels,maxDifference,pass:changedPixels===0});
    // Exact mode uses a zero-tolerance gate. Harmonized mode deliberately changes low-frequency color and requires visual review.
    panels.push({face,patch,seen,diff,context});
  }
  const finalHash=hashFile(imagePath);
  let visual={status:'pending'};
  if(options.review) {
    visual=readJson(options.review);
    assert(visual.finalSha256===finalHash,'Visual review refers to a different image.');
    assert(visual.jobSha256===hashFile(jobPath),'Visual review refers to a different job.');
    assert(['mapping','seams','composition','text'].every(k=>typeof visual.checks?.[k]==='boolean'),'Visual review must record all four checks.');
    assert(typeof visual.notes==='string'&&visual.notes.length>20,'Visual review must describe observations.');
    visual.status=Object.values(visual.checks).every(v=>v===true)?'passed':'failed';
  }
  const exactChecks=checks.filter(c=>c.appearanceMode===APPEARANCE_MODE.exact);
  const pixelsPassed=exactChecks.length?exactChecks.every(c=>c.pass):null;
  const provenancePassed=manifest.finalSha256===finalHash;
  const report={schemaVersion:1,image:imagePath,imageSha256:finalHash,sourceSha256:job.sourceSha256,
    jobSha256:hashFile(jobPath),pixelsPassed,provenancePassed,checks,visual,
    ready:pixelsPassed!==false&&provenancePassed&&visual.status==='passed',
    limitation:exactChecks.length
      ? 'Exactness applies only to source-face-exact masks after sRGB normalization and geometric resampling. Harmonized faces, hair, transition bands, the rest of the scene, and JPEG previews are not covered by this pixel guarantee.'
      : 'source-face-harmonized deliberately changes low-frequency face color and light. It preserves source-derived facial detail but makes no original-pixel equality claim; visual identity and seam review are required.'};
  if(options.report) {
    const reportPath=path.resolve(options.report);
    assert(!fs.existsSync(reportPath),'Report exists; use a new report filename.');
    const panelWidth=360,panelHeight=400;
    const layers=[];
    for(let row=0;row<panels.length;row++) {
      const {patch,seen,diff,face}=panels[row];
      const originals=[patch.reference,seen,diff];
      for(let col=0;col<3;col++) {
        const buf=await sharp(originals[col],{raw:{width:patch.width,height:patch.height,channels:3}}).resize(panelWidth,panelHeight,{fit:'contain',background:'#e9e4d9'}).png().toBuffer();
        layers.push({input:buf,left:col*panelWidth,top:row*(panelHeight+35)+35});
        const label=face.id+' / '+['SOURCE TRANSFORM','FINAL + SEAM',face.appearanceMode===APPEARANCE_MODE.harmonized?'STYLE SHIFT':'CORE DIFFERENCE'][col];
        const svg='<svg width="360" height="35"><rect width="360" height="35" fill="#e9e4d9"/><text x="12" y="23" font-family="sans-serif" font-size="15">'+label+'</text></svg>';
        layers.push({input:Buffer.from(svg),left:col*panelWidth,top:row*(panelHeight+35)});
      }
    }
    const sheet=reportPath.replace(/\.json$/i,'')+'-faces.png';
    await sharp({create:{width:1080,height:panels.length*435,channels:3,background:'#e9e4d9'}}).composite(layers).png().toFile(sheet);
    report.faceComparison=sheet;
    // Optional perceptual visualization supplements exact checks and illustrates the intentional harmonized shift.
    const {default:pixelmatch}=await import('pixelmatch');
    for(const {face,patch,seen} of panels) {
      const a=await sharp(patch.reference,{raw:{width:patch.width,height:patch.height,channels:3}}).ensureAlpha().raw().toBuffer();
      const b=await sharp(seen,{raw:{width:patch.width,height:patch.height,channels:3}}).ensureAlpha().raw().toBuffer();
      const diff=Buffer.alloc(a.length);
      pixelmatch(a,b,diff,patch.width,patch.height,{threshold:.1,includeAA:false});
      await sharp(diff,{raw:{width:patch.width,height:patch.height,channels:4}}).png().toFile(reportPath.replace(/\.json$/i,'')+'-'+face.id+'-perceptual.png');
    }
    writeJson(reportPath,report);
  }
  return report;
}
if(require.main===module) {
  const a=parseArgs();
  verify(a.job,a).then(r=>{console.log(JSON.stringify(r));if(r.pixelsPassed===false||!r.provenancePassed)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={verify};
