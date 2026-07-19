import { calibrateFrame, u, s, v3, sub, cross, dot, normalize, toPixelV, toPixelH, rotateAboutAxis, norm, scale } from '../web/src/lib/epureMath.ts';
const gl = { a:{x:6,y:275}, b:{x:464,y:273} };
const f = calibrateFrame(gl);
const lift = (v:any,h:any)=> v3((u(f,v)+u(f,h))/2, s(f,h), -s(f,v));
const S = { v:{x:139,y:277}, h:{x:141,y:477} };
const D = { v:{x:282,y:162}, h:{x:284,y:315} };
const E = { v:{x:342,y:163}, h:{x:342,y:378} };
const F = { v:{x:409,y:270}, h:{x:409,y:304} };
const P:any = {S:lift(S.v,S.h), D:lift(D.v,D.h), E:lift(E.v,E.h), F:lift(F.v,F.h)};
for (const k of Object.keys(P)) console.log(k, JSON.stringify(P[k]).replace(/"/g,''));
for (const [k,pt] of Object.entries({S,D,E,F})) console.log('recall',k, Math.abs(u(f,(pt as any).v)-u(f,(pt as any).h)).toFixed(1));
const n = normalize(cross(sub(P.D,P.S), sub(P.E,P.S)));
console.log('normal', JSON.stringify(n).replace(/"/g,''));
console.log('F offplane', dot(n, sub(P.F,P.S)).toFixed(2));
const off = dot(n,P.S);
const solveV = (h:any)=>{
  const uu=u(f,h), yy=s(f,h);
  const z = (off - n.x*uu - n.y*yy)/n.z;
  const X=v3(uu,yy,z);
  return { X, vpx: toPixelV(f,X) };
};
for (const [k,h] of Object.entries({K:{x:238,y:348}, L:{x:255,y:394}, M:{x:257,y:425}})){
  const r=solveV(h as any);
  console.log(k,'3D',JSON.stringify(r.X).replace(/"/g,''),'Vpx',`(${r.vpx.x.toFixed(0)},${r.vpx.y.toFixed(0)})`);
}
