'use strict';
const {test}=require('node:test');
const strict=require('node:assert/strict');
const os=require('node:os');
const {fs,path,sharp,BLEND_MODE,APPEARANCE_MODE,hashFile,readJson,fitSimilarity,mapPoint,renderFace,harmonizePatch}=require('../scripts/common.cjs');
const {align}=require('../scripts/align_faces.cjs');
const {compose}=require('../scripts/compose.cjs');
const {verify}=require('../scripts/verify.cjs');
function save(file,data){fs.writeFileSync(file,JSON.stringify(data,null,2));}

test('adaptive transition fades across both wide and narrow margins without changing the core',()=>{
  const source={data:Buffer.alloc(100*100*3,120),info:{width:100,height:100,channels:3}};
  const face={corePolygon:[[40,30],[60,30],[60,70],[40,70]],outerPolygon:[[10,10],[70,10],[70,90],[10,90]],
    featherPx:3,blendMode:BLEND_MODE.adaptiveRing,transform:{a:1,b:0,tx:0,ty:0}};
  const patch=renderFace(source,face,{width:100,height:100});
  const alpha=(x,y)=>patch.rgba[((y-patch.top)*patch.width+x-patch.left)*4+3];
  strict.equal(alpha(50,50),255);
  strict.equal(alpha(10,50),0);
  strict.ok(alpha(15,50)>0 && alpha(15,50)<alpha(25,50));
  strict.ok(alpha(25,50)<alpha(35,50) && alpha(35,50)<255);
  strict.ok(alpha(63,50)>alpha(65,50) && alpha(65,50)>alpha(67,50));
  const legacy=renderFace(source,{...face,blendMode:BLEND_MODE.edgeFeather},{width:100,height:100});
  const unspecified=renderFace(source,{...face,blendMode:undefined},{width:100,height:100});
  strict.deepEqual(legacy.rgba,unspecified.rgba);
  strict.equal(legacy.rgba[((50-legacy.top)*legacy.width+25-legacy.left)*4+3],255);
});

test('harmonized mode shifts low-frequency tone while retaining source contrast and alpha',()=>{
  const width=21,height=21,reference=Buffer.alloc(width*height*3),rgba=Buffer.alloc(width*height*4),target=Buffer.alloc(width*height*3,200);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++) {
    const i=y*width+x,value=100+(x%2?10:-10);
    reference[i*3+c]=value;rgba[i*4+c]=value;rgba[i*4+3]=255;
  }
  const out=harmonizePatch({width,height,reference,rgba},target,.35,5);
  const channel=x=>out[(10*width+x)*4];
  strict.ok(channel(10)>90&&channel(10)<200);
  strict.ok(Math.abs((channel(11)-channel(10))-20)<=2,'High-frequency source contrast should remain.');
  strict.equal(out[(10*width+10)*4+3],255);
  strict.deepEqual(harmonizePatch({width,height,reference,rgba},target,0,5),rgba);
});

test('similarity fit recovers a rotation and rejects degenerate geometry',()=>{
  const source=[[12,8],[64,10],[35,47]], angle=Math.PI/9, scale=1.7;
  const target=source.map(([x,y])=>[scale*Math.cos(angle)*x-scale*Math.sin(angle)*y+35,scale*Math.sin(angle)*x+scale*Math.cos(angle)*y-9]);
  const t=fitSimilarity(source,target);
  strict.ok(Math.abs(t.scale-scale)<1e-10);
  strict.ok(Math.abs(t.rotationDegrees-20)<1e-10);
  source.forEach((p,i)=>strict.ok(Math.hypot(...mapPoint(p,t).map((v,c)=>v-target[i][c]))<1e-10));
  strict.throws(()=>fitSimilarity([[1,1],[1,1],[1,1]],target),/Degenerate/);
});

for(const faceCount of [1,2]) test('preserve '+faceCount+' face(s), reject pixel corruption and changed protection',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'portrait-collage-test-'));
  try {
    const w=512,h=512,raw=Buffer.alloc(w*h*3);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*3;raw[i]=x%256;raw[i+1]=y%256;raw[i+2]=(x+y)%256;}
    const source=path.join(root,'source.png'),background=path.join(root,'background.png');
    await sharp(raw,{raw:{width:w,height:h,channels:3}}).png().toFile(source);
    await sharp({create:{width:w,height:h,channels:3,background:'#c4b7a2'}}).png().toFile(background);
    const face=x=>({id:'face-'+x,anchors:[[x,110],[x+40,110],[x+20,140]],corePolygon:[[x-10,90],[x+50,90],[x+50,170],[x-10,170]]});
    const sourceFaces=[face(100),face(300)].slice(0,faceCount);
    const targetFaces=sourceFaces.map(f=>({...f,anchors:f.anchors.map(([x,y])=>[x+17,y+23])}));
    const src=path.join(root,'source.json'),tgt=path.join(root,'target.json');
    save(src,{inputSha256:hashFile(source),image:{width:w,height:h},faces:sourceFaces});
    save(tgt,{inputSha256:hashFile(background),image:{width:w,height:h},faces:targetFaces});
    const draft=path.join(root,'draft.json'),jobFile=path.join(root,'job.json'),output=path.join(root,'output');
    save(draft,{source,background,sourceDetections:src,targetDetections:tgt,canvas:{width:w,height:h},outputDir:output,
      faces:sourceFaces.map((f,i)=>({id:'person-'+(i+1),sourceId:f.id,targetId:f.id,identityReview:'Synthetic fixture correspondence checked by distinct position.'}))});
    const invalidDraft=readJson(draft);
    invalidDraft.faces[0].outerPolygon=[[110,115],[120,115],[120,125],[110,125]];
    const invalidPath=path.join(root,'invalid-draft.json');
    save(invalidPath,invalidDraft);
    await strict.rejects(()=>align(invalidPath,path.join(root,'invalid-job.json')),/excludes part of the full face/);
    await align(draft,jobFile); await compose(jobFile);
    const result=await verify(jobFile);
    strict.equal(result.pixelsPassed,true);strict.equal(result.provenancePassed,true);strict.equal(result.ready,false);
    strict.equal(result.checks.length,faceCount);
    const final=path.join(output,'final.png');
    const out=await sharp(final).removeAlpha().raw().toBuffer();
    const p=((130+23)*w+120+17)*3;
    strict.deepEqual([...out.subarray(p,p+3)],[120,130,250]);
    // An outside pixel must remain the background's exact RGB.
    strict.deepEqual([...out.subarray(0,3)],[196,183,162]);
    out[p]^=1;
    const damaged=path.join(root,'damaged.png');
    await sharp(out,{raw:{width:w,height:h,channels:3}}).png().toFile(damaged);
    const bad=await verify(jobFile,{image:damaged});
    strict.equal(bad.pixelsPassed,false);strict.equal(bad.checks[0].changedPixels,1);
    const job=readJson(jobFile),lock=readJson(job.protection);
    lock.faces[0].corePolygon=[[100,100],[101,100],[101,101]];
    save(job.protection,lock);
    await strict.rejects(()=>verify(jobFile),/Protection lock changed/);
  } finally {
    // mkdtemp created this exact isolated directory; it never contains user inputs.
    strict.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'portrait-collage-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('harmonized face reports intentional pixel changes without claiming exactness',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'portrait-collage-harmonized-test-'));
  try {
    const w=512,h=512,source=path.join(root,'source.png'),background=path.join(root,'background.png');
    await sharp({create:{width:w,height:h,channels:3,background:{r:100,g:100,b:100}}}).png().toFile(source);
    await sharp({create:{width:w,height:h,channels:3,background:{r:200,g:200,b:200}}}).png().toFile(background);
    const face={id:'face-1',anchors:[[90,105],[150,105],[120,135]],corePolygon:[[80,75],[160,75],[160,175],[80,175]]};
    const src=path.join(root,'source.json'),tgt=path.join(root,'target.json');
    save(src,{inputSha256:hashFile(source),image:{width:w,height:h},faces:[face]});
    save(tgt,{inputSha256:hashFile(background),image:{width:w,height:h},faces:[face]});
    const draft=path.join(root,'draft.json'),job=path.join(root,'job.json');
    save(draft,{source,background,sourceDetections:src,targetDetections:tgt,canvas:{width:w,height:h},outputDir:path.join(root,'output'),faces:[{
      id:'person-1',sourceId:'face-1',targetId:'face-1',appearanceMode:APPEARANCE_MODE.harmonized,harmonizeStrength:.35,
      identityReview:'Synthetic harmonized correspondence checked.',outerPolygon:[[65,60],[175,60],[175,190],[65,190]],featherPx:5
    }]});
    await align(draft,job);await compose(job);
    const result=await verify(job);
    strict.equal(result.pixelsPassed,null);
    strict.equal(result.checks[0].pixelVerification,'not-applicable');
    strict.equal(result.checks[0].pass,null);
    strict.equal(result.ready,false);
    const final=await sharp(path.join(root,'output','final.png')).removeAlpha().raw().toBuffer();
    const center=final[(125*w+120)*3];
    strict.ok(center>100&&center<200);
  } finally {
    strict.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'portrait-collage-harmonized-test-'));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
