'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const BLEND_MODE = {edgeFeather:'edge-feather', adaptiveRing:'adaptive-ring'};
const APPEARANCE_MODE = {exact:'source-face-exact', harmonized:'source-face-harmonized'};

function assert(ok, message) { if (!ok) throw new Error(message); }
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function hashFile(file) { return digest(fs.readFileSync(file)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag:'wx'}); }
function absolute(file, base) { return path.resolve(base, file); }
function parseArgs() {
  const args = {};
  for (let i=2; i<process.argv.length; i+=2) {
    assert(process.argv[i].startsWith('--') && process.argv[i+1], 'Expected --option value pairs.');
    args[process.argv[i].slice(2)] = process.argv[i+1];
  }
  return args;
}
function polygonValid(poly) {
  return Array.isArray(poly) && poly.length >= 3 && poly.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
}
function inside(point, poly) {
  let hit = false;
  const [x,y] = point;
  for (let i=0,j=poly.length-1; i<poly.length; j=i++) {
    const [xi,yi]=poly[i], [xj,yj]=poly[j];
    if (((yi>y)!==(yj>y)) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) hit=!hit;
  }
  return hit;
}
function distance(point, poly) {
  let best = Infinity;
  for(let i=0;i<poly.length;i++) {
    const p=poly[i], q=poly[(i+1)%poly.length];
    const dx=q[0]-p[0], dy=q[1]-p[1];
    const t=Math.max(0,Math.min(1,((point[0]-p[0])*dx+(point[1]-p[1])*dy)/(dx*dx+dy*dy || 1)));
    best=Math.min(best,Math.hypot(point[0]-p[0]-t*dx,point[1]-p[1]-t*dy));
  }
  return best;
}
function bounds(poly) {
  return {left:Math.floor(Math.min(...poly.map(p=>p[0]))), top:Math.floor(Math.min(...poly.map(p=>p[1]))),
    right:Math.ceil(Math.max(...poly.map(p=>p[0]))), bottom:Math.ceil(Math.max(...poly.map(p=>p[1])))};
}
function mapPoint(p,t) { return [t.a*p[0]-t.b*p[1]+t.tx, t.b*p[0]+t.a*p[1]+t.ty]; }
function inversePoint(p,t) {
  const d=t.a*t.a+t.b*t.b, x=p[0]-t.tx, y=p[1]-t.ty;
  return [(t.a*x+t.b*y)/d,(-t.b*x+t.a*y)/d];
}
function fitSimilarity(source,target) {
  assert(source.length===target.length && source.length>=3, 'At least three paired landmarks required.');
  const mean=p=>p.reduce((s,q)=>[s[0]+q[0]/p.length,s[1]+q[1]/p.length],[0,0]);
  const s=mean(source), t=mean(target);
  let den=0, numA=0, numB=0;
  source.forEach((p,i)=>{
    const x=p[0]-s[0],y=p[1]-s[1],u=target[i][0]-t[0],v=target[i][1]-t[1];
    den+=x*x+y*y; numA+=x*u+y*v; numB+=x*v-y*u;
  });
  assert(den>1e-8,'Degenerate landmark configuration.');
  const a=numA/den,b=numB/den;
  const result={a,b,tx:t[0]-a*s[0]+b*s[1],ty:t[1]-b*s[0]-a*s[1]};
  result.scale=Math.hypot(a,b);
  result.rotationDegrees=Math.atan2(b,a)*180/Math.PI;
  result.residual=Math.sqrt(source.reduce((sum,p,i)=>{
    const q=mapPoint(p,result); return sum+(q[0]-target[i][0])**2+(q[1]-target[i][1])**2;
  },0)/source.length);
  const eyeDistance=Math.hypot(target[0][0]-target[1][0],target[0][1]-target[1][1]);
  result.normalizedResidual=result.residual/eyeDistance;
  assert(result.scale>0 && Number.isFinite(result.normalizedResidual),'Invalid transform.');
  return result;
}
async function decode(file) {
  return sharp(file).autoOrient().toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
}
function sampleRgb(source,x,y) {
  const {data,info}=source;
  assert(x>=0 && y>=0 && x<=info.width-1 && y<=info.height-1,'Patch extends beyond source.');
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(x0+1,info.width-1),y1=Math.min(y0+1,info.height-1);
  const fx=x-x0,fy=y-y0;
  return [0,1,2].map(c=>Math.round(
    data[(y0*info.width+x0)*3+c]*(1-fx)*(1-fy)+data[(y0*info.width+x1)*3+c]*fx*(1-fy)+
    data[(y1*info.width+x0)*3+c]*(1-fx)*fy+data[(y1*info.width+x1)*3+c]*fx*fy));
}
async function loadJob(jobPath) {
  const job=readJson(jobPath), base=path.dirname(path.resolve(jobPath));
  assert(job.schemaVersion===1 && job.protection, 'Expected a locked schemaVersion 1 job.');
  for(const key of ['source','background','outputDir']) job[key]=absolute(job[key],base);
  job.protection=absolute(job.protection,base);
  assert(hashFile(job.source)===job.sourceSha256,'Source file changed.');
  assert(hashFile(job.background)===job.backgroundSha256,'Background changed after alignment.');
  assert(hashFile(job.protection)===job.protectionSha256,'Protection lock changed.');
  const lock=readJson(job.protection);
  assert(lock.sourceSha256===job.sourceSha256,'Wrong source in protection lock.');
  assert(digest(Buffer.from(JSON.stringify(job.faces.map(f=>({id:f.id,sourceId:f.sourceId,targetId:f.targetId,transform:f.transform})))))===job.alignmentSha256,'Alignment changed; create a new job.');
  assert(job.faces.length===lock.faces.length && job.faces.length>0,'Missing protected faces.');
  assert(new Set(job.faces.map(f=>f.id)).size===job.faces.length,'Duplicate face IDs.');
  for(const face of job.faces) {
    face.blendMode ??= BLEND_MODE.edgeFeather;
    assert(Object.values(BLEND_MODE).includes(face.blendMode),'Unknown face blend mode.');
    face.appearanceMode ??= APPEARANCE_MODE.exact;
    assert(Object.values(APPEARANCE_MODE).includes(face.appearanceMode),'Unknown face appearance mode.');
    if(face.appearanceMode===APPEARANCE_MODE.harmonized) {
      assert(Number.isFinite(face.harmonizeStrength)&&face.harmonizeStrength>=0&&face.harmonizeStrength<=.6,'harmonizeStrength must be 0..0.6.');
      assert(Number.isFinite(face.harmonizeRadiusPx)&&face.harmonizeRadiusPx>=2&&face.harmonizeRadiusPx<=200,'harmonizeRadiusPx must be 2..200 source pixels.');
    }
    const protection=lock.faces.find(f=>f.id===face.id);
    assert(protection && protection.sourceId===face.sourceId,'Face mapping differs from protection lock.');
    face.corePolygon=protection.corePolygon;
    assert(polygonValid(face.corePolygon) && polygonValid(face.outerPolygon),'Invalid polygon.');
    assert(Number.isFinite(face.featherPx) && face.featherPx>0,'Invalid feather width.');
    assert(face.identityReview && face.identityReview.length>=8,'Identity correspondence needs visual review.');
    assert(face.corePolygon.every(p=>inside(p,face.outerPolygon) && distance(p,face.outerPolygon)>=face.featherPx),'Outer matte must fully contain the locked face plus its feather band.');
  }
  return job;
}
function renderFace(source,face,canvas) {
  const box=bounds(face.outerPolygon.map(p=>mapPoint(p,face.transform)));
  assert(box.left>=0 && box.top>=0 && box.right<canvas.width && box.bottom<canvas.height,'Face matte outside canvas.');
  const width=box.right-box.left+1,height=box.bottom-box.top+1;
  const rgba=Buffer.alloc(width*height*4),reference=Buffer.alloc(width*height*3),core=Buffer.alloc(width*height);
  let protectedPixels=0;
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const q=inversePoint([box.left+x,box.top+y],face.transform);
    const inCore=inside(q,face.corePolygon), inOuter=inside(q,face.outerPolygon);
    if(!inOuter && !inCore) continue;
    const rgb=sampleRgb(source,q[0],q[1]);
    const index=y*width+x;
    const outerDistance=distance(q,face.outerPolygon);
    // An adaptive transition spans the entire ring, even when its width varies.
    // The locked face core remains opaque and is never color corrected.
    let opacity=inCore ? 1 : face.blendMode===BLEND_MODE.adaptiveRing
      ? outerDistance/(outerDistance+distance(q,face.corePolygon))
      : Math.min(1,outerDistance/face.featherPx);
    opacity=opacity*opacity*(3-2*opacity);
    for(let c=0;c<3;c++) { rgba[index*4+c]=rgb[c];reference[index*3+c]=rgb[c]; }
    rgba[index*4+3]=Math.round(opacity*255);
    if(inCore){core[index]=255;protectedPixels++;}
  }
  assert(protectedPixels>=64,'Protected region too small to verify.');
  return {...box,width,height,rgba,reference,core,protectedPixels};
}
function boxBlurRgb(data,width,height,radius,valid) {
  radius=Math.max(1,Math.round(radius));
  const stride=width+1,size=(width+1)*(height+1),sums=[new Float64Array(size),new Float64Array(size),new Float64Array(size)],counts=new Uint32Array(size);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const src=y*width+x,dst=(y+1)*stride+x+1,ok=!valid||valid[src];
    counts[dst]=counts[dst-1]+counts[dst-stride]-counts[dst-stride-1]+(ok?1:0);
    for(let c=0;c<3;c++)sums[c][dst]=sums[c][dst-1]+sums[c][dst-stride]-sums[c][dst-stride-1]+(ok?data[src*3+c]:0);
  }
  const out=new Float32Array(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const x0=Math.max(0,x-radius),y0=Math.max(0,y-radius),x1=Math.min(width-1,x+radius),y1=Math.min(height-1,y+radius);
    const a=y0*stride+x0,b=y0*stride+x1+1,d=(y1+1)*stride+x0,e=(y1+1)*stride+x1+1,n=counts[e]-counts[b]-counts[d]+counts[a];
    if(!n)continue;
    for(let c=0;c<3;c++)out[(y*width+x)*3+c]=(sums[c][e]-sums[c][b]-sums[c][d]+sums[c][a])/n;
  }
  return out;
}
function harmonizePatch(patch,target,strength,radius) {
  const valid=Buffer.alloc(patch.width*patch.height);
  for(let i=0;i<valid.length;i++)valid[i]=patch.rgba[i*4+3]>0?1:0;
  const sourceLow=boxBlurRgb(patch.reference,patch.width,patch.height,radius,valid);
  const targetLow=boxBlurRgb(target,patch.width,patch.height,radius);
  const out=Buffer.from(patch.rgba);
  for(let i=0;i<valid.length;i++)if(valid[i])for(let c=0;c<3;c++) {
    const shifted=patch.reference[i*3+c]+strength*(targetLow[i*3+c]-sourceLow[i*3+c]);
    out[i*4+c]=Math.max(0,Math.min(255,Math.round(shifted)));
  }
  return out;
}
module.exports={fs,path,sharp,BLEND_MODE,APPEARANCE_MODE,assert,digest,hashFile,readJson,writeJson,absolute,parseArgs,polygonValid,inside,distance,bounds,mapPoint,inversePoint,fitSimilarity,decode,sampleRgb,loadJob,renderFace,boxBlurRgb,harmonizePatch};
