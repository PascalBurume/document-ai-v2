import { calibrateFrame, u, s, v3, sub, cross, dot, normalize, norm, dist, toPixelV, rotateAboutAxis, scale, add } from '../web/src/lib/epureMath.ts';
const f = calibrateFrame({ a:{x:6,y:275}, b:{x:464,y:273} });
const lift = (v:any,h:any)=> v3((u(f,v)+u(f,h))/2, s(f,h), -s(f,v));
// current best reads (screen)
const K = { v:{x:238,y:192}, h:{x:238,y:348} };
const L = { v:{x:255,y:223}, h:{x:255,y:394} };
const M = { v:{x:257,y:273}, h:{x:257,y:425} };
const K3=lift(K.v,K.h), L3=lift(L.v,L.h), M3=lift(M.v,M.h);
console.log('K3',fmt(K3)); console.log('L3',fmt(L3)); console.log('M3',fmt(M3));
console.log('sides 3D  KL',dist(K3,L3).toFixed(1),'LM',dist(L3,M3).toFixed(1),'KM',dist(K3,M3).toFixed(1));
// rabattu true triangle (screen px)
const Kr={x:64,y:361}, Lr={x:90,y:414}, Mr={x:161,y:427};
const d=(a:any,b:any)=>Math.hypot(a.x-b.x,a.y-b.y);
console.log('sides GOLD KL',d(Kr,Lr).toFixed(1),'LM',d(Lr,Mr).toFixed(1),'KM',d(Kr,Mr).toFixed(1));
// rabattu as 3D points in piV (y=0): x=abscissa, z=height=-s
const KrP=v3(u(f,Kr),0,-s(f,Kr)), LrP=v3(u(f,Lr),0,-s(f,Lr)), MrP=v3(u(f,Mr),0,-s(f,Mr));
console.log('KrP',fmt(KrP),'LrP',fmt(LrP),'MrP',fmt(MrP));
// rigid transform KLM -> KrLrMr via centroid + rotation (3 pts). Compute rotation axis.
function rigidAxis(A:any[],B:any[]){
  const cen=(P:any[])=>scale(P.reduce((a,b)=>add(a,b),v3(0,0,0)),1/P.length);
  const ca=cen(A), cb=cen(B);
  const Ac=A.map(p=>sub(p,ca)), Bc=B.map(p=>sub(p,cb));
  // covariance H = sum Ac_i outer Bc_i ; R = V U^T (Kabsch). Do simple 3x3.
  let H=[[0,0,0],[0,0,0],[0,0,0]];
  for(let i=0;i<A.length;i++){const a=Ac[i],b=Bc[i];const av=[a.x,a.y,a.z],bv=[b.x,b.y,b.z];
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)H[r][c]+=av[r]*bv[c];}
  return {ca,cb,H};
}
const rig=rigidAxis([K3,L3,M3],[KrP,LrP,MrP]);
console.log('centroid src',fmt(rig.ca),'dst',fmt(rig.cb));
function fmt(p:any){return `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`;}
