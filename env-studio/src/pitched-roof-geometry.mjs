/** Pure pitched-roof geometry shared by the browser viewer and epJSON export. */

import { SkeletonBuilder } from './straight-skeleton-adapter.mjs?v=cgal-3.0.0';

const EPS = 1e-9;
const MIN_PROJECTED_SURFACE_AREA = 1e-6;

function signedArea2D(points) {
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  return area2 / 2;
}

function triangulatePolygon(points) {
  if (!points || points.length < 3) return [];
  const remaining = points.map((_, i) => i);
  const triangles = [];
  const ccw = signedArea2D(points) > 0;
  const cross2 = (a, b, c) => (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
  const inside = (p, a, b, c) => {
    const d1=cross2(a,b,p), d2=cross2(b,c,p), d3=cross2(c,a,p);
    return !((d1<0||d2<0||d3<0) && (d1>0||d2>0||d3>0));
  };
  let guard = 0;
  while (remaining.length > 3 && guard++ < points.length * points.length) {
    let found = false;
    for (let i = 0; i < remaining.length; i++) {
      const ia=remaining[(i-1+remaining.length)%remaining.length];
      const ib=remaining[i];
      const ic=remaining[(i+1)%remaining.length];
      const cross = cross2(points[ia], points[ib], points[ic]);
      if (ccw ? cross <= EPS : cross >= -EPS) continue;
      if (remaining.some(idx => idx!==ia && idx!==ib && idx!==ic && inside(points[idx], points[ia], points[ib], points[ic]))) continue;
      triangles.push([ia, ib, ic]);
      remaining.splice(i, 1);
      found = true;
      break;
    }
    if (!found) break;
  }
  if (remaining.length === 3) triangles.push([...remaining]);
  return triangles;
}

function buildStraightSkeletonRoof(hostFootprint,baseZ,rise){
  if(!hostFootprint||hostFootprint.length<3||!(rise>0))return null;
  const xs=hostFootprint.map(point=>point.x),ys=hostFootprint.map(point=>point.y);
  const center={
    x:(Math.min(...xs)+Math.max(...xs))/2,
    y:(Math.min(...ys)+Math.max(...ys))/2,
  };
  const maxDimension=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  if(maxDimension<EPS)return null;
  // Keeping the calculation near the origin and at a consistent numeric
  // scale avoids needless roundoff in simultaneous orthogonal edge events.
  const scale=100/maxDimension;
  let normalized=hostFootprint.map(point=>[
    (point.x-center.x)*scale,
    (point.y-center.y)*scale,
  ]);
  const normalizedPoints=normalized.map(([x,y])=>({x,y}));
  if(signedArea2D(normalizedPoints)<0)normalized=normalized.reverse();
  normalized.push([...normalized[0]]);
  let skeleton;
  try{
    skeleton=SkeletonBuilder.buildFromPolygon([normalized]);
  }catch{
    return null;
  }
  if(!skeleton?.vertices?.length||!skeleton?.polygons?.length)return null;
  const maximumTime=Math.max(...skeleton.vertices.map(vertex=>Math.max(0,+vertex[2]||0)));
  if(maximumTime<EPS)return null;
  const vertices=skeleton.vertices.map(vertex=>{
    let normalizedTime=Math.max(0,+vertex[2]||0);
    let x=center.x+vertex[0]/scale;
    let y=center.y+vertex[1]/scale;
    let skeletonTime=normalizedTime/scale;
    // The WASM wrapper returns single-precision coordinates. Restore every
    // zero-time wavefront vertex to the exact source outline so later clipping
    // cannot manufacture microscopic roof/closure slivers along the eaves.
    if(normalizedTime<=1e-5){
      const source=hostFootprint.reduce((nearest,point)=>{
        const distance=Math.hypot(point.x-x,point.y-y);
        return !nearest||distance<nearest.distance?{point,distance}:nearest;
      },null);
      if(source?.distance<=maxDimension*1e-5){
        x=source.point.x;
        y=source.point.y;
        normalizedTime=0;
        skeletonTime=0;
      }
    }
    return {
      x,y,
      z:baseZ+rise*normalizedTime/maximumTime,
      skeletonTime,
    };
  });
  const triangles=[];
  skeleton.polygons.forEach(face=>{
    const compact=[];
    face.forEach(index=>{
      const point=vertices[index];
      if(!point)return;
      if(!compact.length||Math.hypot(point.x-compact.at(-1).x,point.y-compact.at(-1).y)>1e-8)compact.push(point);
    });
    if(compact.length>2&&Math.hypot(compact[0].x-compact.at(-1).x,compact[0].y-compact.at(-1).y)<=1e-8)compact.pop();
    if(compact.length<3)return;
    triangulatePolygon(compact).forEach(indices=>triangles.push(indices.map(index=>({...compact[index]}))));
  });
  const clean=triangles.filter(nondegenerate).map(orientUp);
  if(!clean.length)return null;
  return {triangles:clean,vertices,maximumTime:maximumTime/scale};
}

function straightSkeletonElevation(skeleton,point,baseZ){
  if(!skeleton)return baseZ;
  for(const triangle of skeleton.triangles){
    if(pointInTriangle2D(point,triangle,1e-7))return planeZAtPoint(triangle,point);
  }
  return baseZ;
}

function rectangleFrame(footprint, eps = 1e-5) {
  if (!footprint || footprint.length !== 4) return null;
  const edge=(a,b)=>({x:b.x-a.x,y:b.y-a.y});
  const length=v=>Math.hypot(v.x,v.y);
  const dot=(a,b)=>a.x*b.x+a.y*b.y;
  const edges=footprint.map((point,index)=>edge(point,footprint[(index+1)%4]));
  const lengths=edges.map(length);
  if(lengths.some(value=>value<eps))return null;
  const unit=edges.map((value,index)=>({x:value.x/lengths[index],y:value.y/lengths[index]}));
  const perpendicular=Math.max(...unit.map((value,index)=>Math.abs(dot(value,unit[(index+1)%4]))));
  const parallel=Math.max(Math.abs(Math.abs(dot(unit[0],unit[2]))-1),Math.abs(Math.abs(dot(unit[1],unit[3]))-1));
  const diagonalMidpointGap=Math.hypot(
    (footprint[0].x+footprint[2].x-footprint[1].x-footprint[3].x)/2,
    (footprint[0].y+footprint[2].y-footprint[1].y-footprint[3].y)/2,
  );
  if(perpendicular>eps*10||parallel>eps*10||diagonalMidpointGap>eps*10)return null;
  const center={
    x:footprint.reduce((sum,p)=>sum+p.x,0)/4,
    y:footprint.reduce((sum,p)=>sum+p.y,0)/4,
  };
  const u=unit[0],v=unit[1];
  const uValues=footprint.map(p=>(p.x-center.x)*u.x+(p.y-center.y)*u.y);
  const vValues=footprint.map(p=>(p.x-center.x)*v.x+(p.y-center.y)*v.y);
  const uMin=Math.min(...uValues),uMax=Math.max(...uValues),vMin=Math.min(...vValues),vMax=Math.max(...vValues);
  const point=(du,dv)=>({x:center.x+u.x*du+v.x*dv,y:center.y+u.y*du+v.y*dv});
  return {
    center,u,v,uMin,uMax,vMin,vMax,
    c00:point(uMin,vMin),c10:point(uMax,vMin),c11:point(uMax,vMax),c01:point(uMin,vMax),
  };
}

function pointOnSegment2D(point,a,b,tolerance=1e-8){
  const dx=b.x-a.x,dy=b.y-a.y;
  const length=Math.hypot(dx,dy);
  if(length<EPS)return Math.hypot(point.x-a.x,point.y-a.y)<=tolerance;
  const cross=Math.abs(dx*(point.y-a.y)-dy*(point.x-a.x))/length;
  const dot=(point.x-a.x)*dx+(point.y-a.y)*dy;
  return cross<=tolerance&&dot>=-tolerance&&dot<=length*length+tolerance;
}

function pointInPolygon2D(point,polygon){
  if(polygon.some((a,index)=>pointOnSegment2D(point,a,polygon[(index+1)%polygon.length])))return true;
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[i],b=polygon[j];
    if((a.y>point.y)!==(b.y>point.y)
      &&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
  }
  return inside;
}

function uniqueSortedCoordinates(values,tolerance=1e-7){
  const sorted=[...values].sort((a,b)=>a-b);
  const unique=[];
  sorted.forEach(value=>{
    if(!unique.length||Math.abs(value-unique.at(-1))>tolerance)unique.push(value);
    else unique[unique.length-1]=(unique.at(-1)+value)/2;
  });
  return unique;
}

// Decompose an orthogonal outline into its maximal rectangular wings. An
// L-shaped house becomes two overlapping rectangles, a plus-shaped house two
// crossing rectangles, etc. Evaluating a local roof on every wing and taking
// their outer envelope produces perpendicular ridges and the valley where the
// wings meet, instead of forcing the whole building onto one global ridge.
function orthogonalRectangleCover(polygon,tolerance=1e-6){
  if(!polygon||polygon.length<4)return null;
  let basisEdge=null;
  for(let index=0;index<polygon.length;index++){
    const a=polygon[index],b=polygon[(index+1)%polygon.length];
    const length=Math.hypot(b.x-a.x,b.y-a.y);
    if(length>tolerance&&(!basisEdge||length>basisEdge.length))basisEdge={a,b,length};
  }
  if(!basisEdge)return null;
  const u={x:(basisEdge.b.x-basisEdge.a.x)/basisEdge.length,y:(basisEdge.b.y-basisEdge.a.y)/basisEdge.length};
  const v={x:-u.y,y:u.x};
  for(let index=0;index<polygon.length;index++){
    const a=polygon[index],b=polygon[(index+1)%polygon.length];
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    if(length<tolerance)return null;
    const alongU=Math.abs((dx*u.x+dy*u.y)/length);
    const alongV=Math.abs((dx*v.x+dy*v.y)/length);
    if(Math.max(alongU,alongV)<1-tolerance)return null;
  }
  const origin=basisEdge.a;
  const toLocal=point=>({
    x:(point.x-origin.x)*u.x+(point.y-origin.y)*u.y,
    y:(point.x-origin.x)*v.x+(point.y-origin.y)*v.y,
  });
  const toWorld=point=>({
    x:origin.x+u.x*point.x+v.x*point.y,
    y:origin.y+u.y*point.x+v.y*point.y,
  });
  const localPolygon=polygon.map(toLocal);
  const xs=uniqueSortedCoordinates(localPolygon.map(point=>point.x));
  const ys=uniqueSortedCoordinates(localPolygon.map(point=>point.y));
  if(xs.length<2||ys.length<2)return null;
  const columns=xs.length-1,rows=ys.length-1;
  const inside=Array.from({length:columns},()=>Array(rows).fill(false));
  for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
    inside[i][j]=pointInPolygon2D({x:(xs[i]+xs[i+1])/2,y:(ys[j]+ys[j+1])/2},localPolygon);
  }
  const prefix=Array.from({length:columns+1},()=>Array(rows+1).fill(0));
  for(let i=0;i<columns;i++)for(let j=0;j<rows;j++){
    prefix[i+1][j+1]=prefix[i][j+1]+prefix[i+1][j]-prefix[i][j]+(inside[i][j]?1:0);
  }
  const cellCount=(i0,i1,j0,j1)=>prefix[i1][j1]-prefix[i0][j1]-prefix[i1][j0]+prefix[i0][j0];
  const candidates=[];
  for(let i0=0;i0<columns;i0++)for(let i1=i0+1;i1<=columns;i1++){
    for(let j0=0;j0<rows;j0++)for(let j1=j0+1;j1<=rows;j1++){
      const count=(i1-i0)*(j1-j0);
      if(cellCount(i0,i1,j0,j1)===count)candidates.push({i0,i1,j0,j1});
    }
  }
  const maximal=candidates.filter(candidate=>!candidates.some(other=>
    other!==candidate&&other.i0<=candidate.i0&&other.i1>=candidate.i1
      &&other.j0<=candidate.j0&&other.j1>=candidate.j1
      &&(other.i0<candidate.i0||other.i1>candidate.i1||other.j0<candidate.j0||other.j1>candidate.j1)));
  const rectangles=maximal.map(rectangle=>({
    uMin:xs[rectangle.i0],uMax:xs[rectangle.i1],
    vMin:ys[rectangle.j0],vMax:ys[rectangle.j1],
  })).filter(rectangle=>rectangle.uMax-rectangle.uMin>tolerance&&rectangle.vMax-rectangle.vMin>tolerance);
  return rectangles.length>1?{u,v,origin,toLocal,toWorld,localPolygon,rectangles}:null;
}

function pointDistanceToSegment(point,a,b){
  const dx=b.x-a.x,dy=b.y-a.y;
  const lengthSq=dx*dx+dy*dy;
  const t=lengthSq>EPS?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/lengthSq)):0;
  return Math.hypot(point.x-(a.x+t*dx),point.y-(a.y+t*dy));
}

function polygonEdges(points){
  return (points||[]).map((a,index)=>({a,b:points[(index+1)%points.length]}));
}

function distanceToEdges(point,edges){
  return edges.reduce((best,edge)=>Math.min(best,pointDistanceToSegment(point,edge.a,edge.b)),Infinity);
}

function distanceToLines(point,edges){
  return edges.reduce((best,edge)=>{
    const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y,length=Math.hypot(dx,dy);
    const distance=length>EPS?Math.abs(dx*(point.y-edge.a.y)-dy*(point.x-edge.a.x))/length:Infinity;
    return Math.min(best,distance);
  },Infinity);
}

function roofSubdivisionLevels(polygon){
  const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y);
  const maxDimension=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  // Two uniform midpoint subdivisions give an irregular house footprint a
  // readable ridge/valley field without turning every small roof patch into
  // hundreds of EnergyPlus base surfaces. Exact rectangles stay on the
  // clean analytic paths above and never use this tessellation.
  return Math.max(1,Math.min(2,Math.ceil(Math.log2(Math.max(1,maxDimension/1.5)))));
}

function maximumTriangulatedDistance(polygon,distanceFunction){
  const levels=roofSubdivisionLevels(polygon);
  let maximum=0;
  triangulatePolygon(polygon).forEach(([ia,ib,ic])=>{
    const refined=[];
    subdivideTriangle(polygon[ia],polygon[ib],polygon[ic],levels,refined);
    refined.forEach(triangle=>triangle.forEach(point=>{maximum=Math.max(maximum,distanceFunction(point));}));
  });
  return Math.max(maximum,EPS);
}

function roofDirectionVector(degrees){
  const radians=(+(degrees||0))*Math.PI/180;
  return {x:Math.sin(radians),y:-Math.cos(radians)};
}

function makeRoofEvaluator(surface,hostFootprint,straightSkeleton=null){
  const roof=surface?.roof||{};
  const type=roof.type||'flat';
  const baseZ=+(surface?.z||0);
  const rise=Math.max(0,+(roof.ridgeHeight||0));
  if(type==='flat'||!rise)return ()=>baseZ;
  if(type==='hip'&&straightSkeleton){
    return point=>straightSkeletonElevation(straightSkeleton,point,baseZ);
  }
  const rect=rectangleFrame(hostFootprint);
  const ridgeDirection=roofDirectionVector(roof.slopeDir);
  if(rect){
    const local=point=>({
      u:(point.x-rect.center.x)*rect.u.x+(point.y-rect.center.y)*rect.u.y,
      v:(point.x-rect.center.x)*rect.v.x+(point.y-rect.center.y)*rect.v.y,
    });
    const halfU=(rect.uMax-rect.uMin)/2,halfV=(rect.vMax-rect.vMin)/2;
    const ridgeAlongU=Math.abs(rect.u.x*ridgeDirection.x+rect.u.y*ridgeDirection.y)
      >=Math.abs(rect.v.x*ridgeDirection.x+rect.v.y*ridgeDirection.y);
    return point=>{
      const p=local(point);
      const nu=halfU>EPS?Math.min(1,Math.abs(p.u)/halfU):0;
      const nv=halfV>EPS?Math.min(1,Math.abs(p.v)/halfV):0;
      if(type==='hip'){
        const inset=Math.min(halfU,halfV);
        const distance=Math.min(halfU-Math.abs(p.u),halfV-Math.abs(p.v));
        return baseZ+rise*Math.max(0,Math.min(1,inset>EPS?distance/inset:0));
      }
      if(type==='gable')return baseZ+rise*(1-(ridgeAlongU?nv:nu));
      if(type==='shed'){
        const projections=hostFootprint.map(vertex=>vertex.x*ridgeDirection.x+vertex.y*ridgeDirection.y);
        const min=Math.min(...projections),max=Math.max(...projections);
        const projection=point.x*ridgeDirection.x+point.y*ridgeDirection.y;
        return baseZ+rise*(max-min>EPS?Math.max(0,Math.min(1,(projection-min)/(max-min))):0.5);
      }
      return baseZ;
    };
  }
  const wingCover=(type==='hip'||type==='gable')?orthogonalRectangleCover(hostFootprint):null;
  if(wingCover){
    const desired=roofDirectionVector(roof.slopeDir);
    const desiredAlongU=Math.abs(wingCover.u.x*desired.x+wingCover.u.y*desired.y)
      >=Math.abs(wingCover.v.x*desired.x+wingCover.v.y*desired.y);
    return point=>{
      const local=wingCover.toLocal(point);
      let field=0;
      wingCover.rectangles.forEach(rectangle=>{
        if(local.x<rectangle.uMin-1e-7||local.x>rectangle.uMax+1e-7
          ||local.y<rectangle.vMin-1e-7||local.y>rectangle.vMax+1e-7)return;
        const halfU=(rectangle.uMax-rectangle.uMin)/2;
        const halfV=(rectangle.vMax-rectangle.vMin)/2;
        const centerU=(rectangle.uMin+rectangle.uMax)/2;
        const centerV=(rectangle.vMin+rectangle.vMax)/2;
        const nu=halfU>EPS?Math.min(1,Math.abs(local.x-centerU)/halfU):1;
        const nv=halfV>EPS?Math.min(1,Math.abs(local.y-centerV)/halfV):1;
        let value=0;
        if(type==='hip')value=1-Math.max(nu,nv);
        else{
          const width=halfU*2,height=halfV*2;
          const ridgeAlongU=Math.abs(width-height)>1e-7?width>height:desiredAlongU;
          value=1-(ridgeAlongU?nv:nu);
        }
        field=Math.max(field,Math.max(0,value));
      });
      return baseZ+rise*Math.max(0,Math.min(1,field));
    };
  }
  const edges=polygonEdges(hostFootprint);
  if(type==='hip'){
    const scale=maximumTriangulatedDistance(hostFootprint,point=>distanceToEdges(point,edges));
    return point=>baseZ+rise*Math.max(0,Math.min(1,distanceToEdges(point,edges)/scale));
  }
  if(type==='gable'){
    const eaves=edges.filter(edge=>{
      const dx=edge.b.x-edge.a.x,dy=edge.b.y-edge.a.y,length=Math.hypot(dx,dy)||1;
      return Math.abs((dx/length)*ridgeDirection.x+(dy/length)*ridgeDirection.y)>=Math.cos(Math.PI/8);
    });
    const sources=eaves.length>=2?eaves:edges;
    const scale=maximumTriangulatedDistance(hostFootprint,point=>distanceToLines(point,sources));
    return point=>baseZ+rise*Math.max(0,Math.min(1,distanceToLines(point,sources)/scale));
  }
  if(type==='shed'){
    const projections=hostFootprint.map(point=>point.x*ridgeDirection.x+point.y*ridgeDirection.y);
    const min=Math.min(...projections),max=Math.max(...projections);
    return point=>{
      const projection=point.x*ridgeDirection.x+point.y*ridgeDirection.y;
      return baseZ+rise*(max-min>EPS?Math.max(0,Math.min(1,(projection-min)/(max-min))):0.5);
    };
  }
  return ()=>baseZ;
}

function subdivideTriangle(a,b,c,levels,output){
  if(levels<=0){output.push([a,b,c]);return;}
  const midpoint=(p,q)=>({x:(p.x+q.x)/2,y:(p.y+q.y)/2});
  const ab=midpoint(a,b),bc=midpoint(b,c),ca=midpoint(c,a);
  subdivideTriangle(a,ab,ca,levels-1,output);
  subdivideTriangle(ab,b,bc,levels-1,output);
  subdivideTriangle(ca,bc,c,levels-1,output);
  subdivideTriangle(ab,bc,ca,levels-1,output);
}

function orthogonalWingRoofTriangles(cover,evaluator,rise){
  const coordinates=(axisMin,axisMax)=>uniqueSortedCoordinates(cover.rectangles.flatMap(rectangle=>[
    rectangle[axisMin],
    (rectangle[axisMin]+rectangle[axisMax])/2,
    rectangle[axisMax],
  ]));
  const us=coordinates('uMin','uMax');
  const vs=coordinates('vMin','vMax');
  const triangles=[];
  const point=(u,v)=>{
    const world=cover.toWorld({x:u,y:v});
    return {...world,z:evaluator(world)};
  };
  const addCell=(u0,u1,v0,v1,depth=0)=>{
    const um=(u0+u1)/2,vm=(v0+v1)/2;
    if(!pointInPolygon2D({x:um,y:vm},cover.localPolygon))return;
    const p00=point(u0,v0),p10=point(u1,v0),p11=point(u1,v1),p01=point(u0,v1);
    const center=point(um,vm);
    const diagonal00=Math.abs(center.z-(p00.z+p11.z)/2);
    const diagonal10=Math.abs(center.z-(p10.z+p01.z)/2);
    const edgeError=Math.max(
      Math.abs(point(um,v0).z-(p00.z+p10.z)/2),
      Math.abs(point(u1,vm).z-(p10.z+p11.z)/2),
      Math.abs(point(um,v1).z-(p01.z+p11.z)/2),
      Math.abs(point(u0,vm).z-(p00.z+p01.z)/2),
    );
    const interpolationError=Math.max(Math.min(diagonal00,diagonal10),edgeError);
    // One local refinement is enough to read the cross-hip valley while
    // keeping the exported EnergyPlus roof to a practical facet count.
    if(interpolationError>Math.max(1e-7,rise*1e-5)&&depth<1){
      addCell(u0,um,v0,vm,depth+1);
      addCell(um,u1,v0,vm,depth+1);
      addCell(um,u1,vm,v1,depth+1);
      addCell(u0,um,vm,v1,depth+1);
      return;
    }
    if(diagonal00<=diagonal10){
      triangles.push([p00,p10,p11],[p00,p11,p01]);
    }else{
      triangles.push([p00,p10,p01],[p10,p11,p01]);
    }
  };
  for(let i=0;i<us.length-1;i++)for(let j=0;j<vs.length-1;j++)addCell(us[i],us[i+1],vs[j],vs[j+1]);
  return triangles;
}

function clipLocalPolygonToHalfPlane(polygon,a,b,c,tolerance=1e-9){
  if(!polygon.length)return [];
  const distance=point=>a*point.x+b*point.y+c;
  const output=[];
  let start=polygon.at(-1),startDistance=distance(start),startInside=startDistance>=-tolerance;
  for(const end of polygon){
    const endDistance=distance(end),endInside=endDistance>=-tolerance;
    if(endInside!==startInside){
      const denominator=startDistance-endDistance;
      const t=Math.abs(denominator)>EPS?Math.max(0,Math.min(1,startDistance/denominator)):0;
      output.push({x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t});
    }
    if(endInside)output.push({...end});
    start=end;startDistance=endDistance;startInside=endInside;
  }
  return output.filter((point,index,list)=>!index||Math.hypot(point.x-list[index-1].x,point.y-list[index-1].y)>1e-9);
}

// Exact planar envelope for orthogonal cross-gables. Ridge centerlines and
// rectangle boundaries partition the plan into cells where every wing is one
// affine plane. Half-plane clipping then keeps only the portion of each plane
// that is uppermost, yielding crisp cross-gable facets without sampled bumps.
function orthogonalGableRoofTriangles(cover,baseZ,rise,ridgeDirection){
  const desiredAlongU=Math.abs(cover.u.x*ridgeDirection.x+cover.u.y*ridgeDirection.y)
    >=Math.abs(cover.v.x*ridgeDirection.x+cover.v.y*ridgeDirection.y);
  const coordinates=(axisMin,axisMax)=>uniqueSortedCoordinates(cover.rectangles.flatMap(rectangle=>[
    rectangle[axisMin],(rectangle[axisMin]+rectangle[axisMax])/2,rectangle[axisMax],
  ]));
  const us=coordinates('uMin','uMax'),vs=coordinates('vMin','vMax');
  const triangles=[];
  const planeFor=(rectangle,center)=>{
    const width=rectangle.uMax-rectangle.uMin,height=rectangle.vMax-rectangle.vMin;
    const ridgeAlongU=Math.abs(width-height)>1e-7?width>height:desiredAlongU;
    if(ridgeAlongU){
      const middle=(rectangle.vMin+rectangle.vMax)/2,half=height/2;
      return center.y<=middle
        ? {a:0,b:1/half,c:-rectangle.vMin/half}
        : {a:0,b:-1/half,c:rectangle.vMax/half};
    }
    const middle=(rectangle.uMin+rectangle.uMax)/2,half=width/2;
    return center.x<=middle
      ? {a:1/half,b:0,c:-rectangle.uMin/half}
      : {a:-1/half,b:0,c:rectangle.uMax/half};
  };
  for(let i=0;i<us.length-1;i++)for(let j=0;j<vs.length-1;j++){
    const u0=us[i],u1=us[i+1],v0=vs[j],v1=vs[j+1];
    const center={x:(u0+u1)/2,y:(v0+v1)/2};
    if(!pointInPolygon2D(center,cover.localPolygon))continue;
    const candidates=[];
    cover.rectangles.forEach(rectangle=>{
      if(center.x<rectangle.uMin-1e-8||center.x>rectangle.uMax+1e-8
        ||center.y<rectangle.vMin-1e-8||center.y>rectangle.vMax+1e-8)return;
      const plane=planeFor(rectangle,center);
      const key=[plane.a,plane.b,plane.c].map(value=>Math.round(value*1e9)).join(',');
      if(!candidates.some(candidate=>candidate.key===key))candidates.push({...plane,key});
    });
    candidates.forEach(candidate=>{
      let region=[{x:u0,y:v0},{x:u1,y:v0},{x:u1,y:v1},{x:u0,y:v1}];
      candidates.forEach(other=>{
        if(other===candidate||!region.length)return;
        region=clipLocalPolygonToHalfPlane(region,
          candidate.a-other.a,candidate.b-other.b,candidate.c-other.c);
      });
      if(region.length<3)return;
      const vertices=region.map(local=>{
        const world=cover.toWorld(local);
        const field=Math.max(0,Math.min(1,candidate.a*local.x+candidate.b*local.y+candidate.c));
        return {...world,z:baseZ+rise*field};
      });
      for(let index=1;index<vertices.length-1;index++)triangles.push([vertices[0],vertices[index],vertices[index+1]]);
    });
  }
  return triangles;
}

function footprintsEqual(a,b,tolerance=1e-7){
  if(a===b)return true;
  if(!a||!b||a.length!==b.length)return false;
  return a.every(point=>b.some(candidate=>Math.hypot(point.x-candidate.x,point.y-candidate.y)<=tolerance));
}

function cross3(a, b, c) {
  const u={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
  const v={x:c.x-a.x,y:c.y-a.y,z:c.z-a.z};
  return {x:u.y*v.z-u.z*v.y,y:u.z*v.x-u.x*v.z,z:u.x*v.y-u.y*v.x};
}

function nondegenerate(triangle) {
  const n=cross3(...triangle);
  return Math.hypot(n.x,n.y,n.z)>EPS;
}

function projectedTriangleArea(triangle){
  const [a,b,c]=triangle;
  return Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))/2;
}

function orientUp(triangle) {
  const out=triangle.map(p=>({...p}));
  if (cross3(...out).z < 0) [out[1],out[2]]=[out[2],out[1]];
  return out;
}

function orientOutward(triangle, center) {
  const out=triangle.map(p=>({...p}));
  const n=cross3(...out);
  const c=out.reduce((sum,p)=>({x:sum.x+p.x/3,y:sum.y+p.y/3}),{x:0,y:0});
  if (n.x*(c.x-center.x)+n.y*(c.y-center.y)<0) [out[1],out[2]]=[out[2],out[1]];
  return out;
}

function polygonArea3D(points) {
  if (!points || points.length < 3) return 0;
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const n = cross3(points[0], points[i], points[i + 1]);
    area += Math.hypot(n.x, n.y, n.z) / 2;
  }
  return area;
}

function orientOutwardPolygon(points, center) {
  const out = points.map(p => ({ ...p }));
  if (out.length < 3) return out;
  const n = cross3(out[0], out[1], out[2]);
  const c = out.reduce((sum, p) => ({
    x: sum.x + p.x / out.length,
    y: sum.y + p.y / out.length,
  }), { x: 0, y: 0 });
  if (n.x * (c.x - center.x) + n.y * (c.y - center.y) < 0) out.reverse();
  return out;
}

function projectToSegment(point, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS) return { t: 0, dist: Infinity };
  const rawT = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  return {
    t,
    dist: Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)),
  };
}

function locateFootprintEdge(footprint, a, b, tolerance = 1e-6) {
  let best = null;
  for (let i = 0; i < footprint.length; i++) {
    const p1 = footprint[i], p2 = footprint[(i + 1) % footprint.length];
    const pa = projectToSegment(a, p1, p2);
    const pb = projectToSegment(b, p1, p2);
    const dist = Math.max(pa.dist, pb.dist);
    if (dist <= tolerance && (!best || dist < best.dist)) {
      best = { edgeIndex: i, t0: pa.t, t1: pb.t, dist };
    }
  }
  return best;
}

export function roofElevationAtPoint(surface, point) {
  const roof=surface?.roof||{};
  const baseZ=+(surface?.z||0);
  const rise=Math.max(0,+(roof.ridgeHeight||0));
  if (!rise || !roof.type || roof.type==='flat') return baseZ;
  const hostFootprint=roof.hostFootprint?.length>=3?roof.hostFootprint:(surface.footprint||[]);
  if(hostFootprint.length<3)return baseZ;
  const straightSkeleton=roof.type==='hip'?buildStraightSkeletonRoof(hostFootprint,baseZ,rise):null;
  return makeRoofEvaluator(surface,hostFootprint,straightSkeleton)(point);
}

export function buildPitchedRoofGeometry(surface) {
  const type=surface?.roof?.type||'flat';
  const rise=Math.max(0,+(surface?.roof?.ridgeHeight||0));
  const footprint=surface?.footprint||[];
  const hostFootprint=surface?.roof?.hostFootprint?.length>=3?surface.roof.hostFootprint:footprint;
  const baseZ=+(surface?.z||0);
  if (type==='flat'||!rise||footprint.length<3) {
    return {roofTriangles:[],closureTriangles:[],closureSurfaces:[],extraVolume:0,maxRise:0};
  }
  const center=footprint.reduce((s,p)=>({x:s.x+p.x/footprint.length,y:s.y+p.y/footprint.length}),{x:0,y:0});
  const straightSkeleton=type==='hip'?buildStraightSkeletonRoof(hostFootprint,baseZ,rise):null;
  const roofEvaluator=makeRoofEvaluator(surface,hostFootprint,straightSkeleton);
  const atRoof=p=>({x:p.x,y:p.y,z:roofEvaluator(p)});
  const atBase=p=>({x:p.x,y:p.y,z:baseZ});
  const hostRoofTriangles=[];
  const closureTriangles=[];
  const closureSurfaces=[];
  const addRoof=(a,b,c)=>hostRoofTriangles.push(orientUp([a,b,c]));
  const addRoofQuad=(a,b,c,d)=>{addRoof(a,b,c);addRoof(a,c,d);};
  const addClosure=(a,b,c)=>{const tri=orientOutward([a,b,c],center);if(nondegenerate(tri))closureTriangles.push(tri);};
  const rect=rectangleFrame(hostFootprint);
  const wingCover=!rect&&!straightSkeleton&&(type==='hip'||type==='gable')
    ?orthogonalRectangleCover(hostFootprint):null;

  if(straightSkeleton){
    straightSkeleton.triangles.forEach(triangle=>addRoof(...triangle));
  } else if (rect&&type==='hip') {
    // Analytic fallback for a rectangle: 45-degree plan bisectors consume
    // the shorter dimension, and any remaining longer dimension is a ridge.
    const {c00,c10,c11,c01,center:rectCenter,u,v,uMin,uMax,vMin,vMax}=rect;
    const point=(du,dv,z)=>({x:rectCenter.x+u.x*du+v.x*dv,y:rectCenter.y+u.y*du+v.y*dv,z});
    const halfU=(uMax-uMin)/2,halfV=(vMax-vMin)/2;
    if(Math.abs(halfU-halfV)<=EPS){
      const apex=point((uMin+uMax)/2,(vMin+vMax)/2,baseZ+rise);
      addRoof(atBase(c00),atBase(c10),apex);addRoof(atBase(c10),atBase(c11),apex);
      addRoof(atBase(c11),atBase(c01),apex);addRoof(atBase(c01),atBase(c00),apex);
    }else if(halfU>halfV){
      const middleV=(vMin+vMax)/2;
      const r0=point(uMin+halfV,middleV,baseZ+rise),r1=point(uMax-halfV,middleV,baseZ+rise);
      addRoofQuad(atBase(c00),atBase(c10),r1,r0);
      addRoof(atBase(c10),atBase(c11),r1);
      addRoofQuad(r0,r1,atBase(c11),atBase(c01));
      addRoof(atBase(c01),atBase(c00),r0);
    }else{
      const middleU=(uMin+uMax)/2;
      const r0=point(middleU,vMin+halfU,baseZ+rise),r1=point(middleU,vMax-halfU,baseZ+rise);
      addRoofQuad(atBase(c00),r0,r1,atBase(c01));
      addRoof(atBase(c00),atBase(c10),r0);
      addRoofQuad(r0,atBase(c10),atBase(c11),r1);
      addRoof(atBase(c11),atBase(c01),r1);
    }
  } else if (rect&&type==='gable') {
    const {c00,c10,c11,c01,center:rectCenter,u,v,uMin,uMax,vMin,vMax}=rect;
    const desired=roofDirectionVector(surface.roof?.slopeDir);
    const ridgeAlongU=Math.abs(u.x*desired.x+u.y*desired.y)>=Math.abs(v.x*desired.x+v.y*desired.y);
    const point=(du,dv,z)=>({x:rectCenter.x+u.x*du+v.x*dv,y:rectCenter.y+u.y*du+v.y*dv,z});
    if(ridgeAlongU){
      const r0=point(uMin,(vMin+vMax)/2,baseZ+rise),r1=point(uMax,(vMin+vMax)/2,baseZ+rise);
      addRoofQuad(atBase(c00),atBase(c10),r1,r0);addRoofQuad(r0,r1,atBase(c11),atBase(c01));
    } else {
      const r0=point((uMin+uMax)/2,vMin,baseZ+rise),r1=point((uMin+uMax)/2,vMax,baseZ+rise);
      addRoofQuad(atBase(c00),r0,r1,atBase(c01));addRoofQuad(r0,atBase(c10),atBase(c11),r1);
    }
  } else if(wingCover){
    const wingTriangles=type==='gable'
      ? orthogonalGableRoofTriangles(wingCover,baseZ,rise,roofDirectionVector(surface.roof?.slopeDir))
      : orthogonalWingRoofTriangles(wingCover,roofEvaluator,rise);
    wingTriangles.forEach(triangle=>addRoof(...triangle));
  } else {
    const levels=type==='shed'?0:roofSubdivisionLevels(hostFootprint);
    triangulatePolygon(hostFootprint).forEach(([ia,ib,ic])=>{
      const refined=[];
      subdivideTriangle(hostFootprint[ia],hostFootprint[ib],hostFootprint[ic],levels,refined);
      refined.forEach(([a,b,c])=>addRoof(atRoof(a),atRoof(b),atRoof(c)));
    });
  }

  const cleanHostRoof=hostRoofTriangles.filter(nondegenerate);
  let cleanRoof=cleanHostRoof;
  if(!footprintsEqual(footprint,hostFootprint)){
    const targetTriangles=triangulatePolygon(footprint).map(indices=>indices.map(index=>footprint[index]));
    const clipped=[];
    const bounds=triangle=>({
      minX:Math.min(...triangle.map(p=>p.x)),maxX:Math.max(...triangle.map(p=>p.x)),
      minY:Math.min(...triangle.map(p=>p.y)),maxY:Math.max(...triangle.map(p=>p.y)),
    });
    const targetBounds=targetTriangles.map(bounds);
    cleanHostRoof.forEach(hostTriangle=>{
      const hb=bounds(hostTriangle);
      targetTriangles.forEach((targetTriangle,index)=>{
        const tb=targetBounds[index];
        if(hb.maxX<tb.minX-EPS||hb.minX>tb.maxX+EPS||hb.maxY<tb.minY-EPS||hb.minY>tb.maxY+EPS)return;
        const polygon=clipPolygonToTriangle2D(targetTriangle,hostTriangle);
        if(polygon.length<3)return;
        for(let i=1;i<polygon.length-1;i++){
          const triangle=[polygon[0],polygon[i],polygon[i+1]].map(point=>({
            x:point.x,y:point.y,z:planeZAtPoint(hostTriangle,point),
          }));
          if(nondegenerate(triangle)&&projectedTriangleArea(triangle)>MIN_PROJECTED_SURFACE_AREA){
            clipped.push(orientUp(triangle));
          }
        }
      });
    });
    cleanRoof=clipped;
  }

  // Close every roof-boundary segment down to the wall-top plane. Deriving
  // these edges from the finished mesh handles ridge endpoints as well as
  // rotated and non-rectangular footprints; shared internal facet edges occur
  // twice and are intentionally excluded.
  const edgeKeyPoint=p=>[p.x,p.y,p.z].map(v=>Math.round(v*1e9)/1e9).join(',');
  const boundaryEdges=new Map();
  cleanRoof.forEach(triangle=>triangle.forEach((a,index)=>{
    const b=triangle[(index+1)%triangle.length];
    const keys=[edgeKeyPoint(a),edgeKeyPoint(b)].sort();
    const key=keys.join('|');
    const existing=boundaryEdges.get(key);
    if(existing)existing.count++;
    else boundaryEdges.set(key,{a,b,count:1});
  }));
  for(const edge of boundaryEdges.values()){
    if(edge.count!==1)continue;
    const located=locateFootprintEdge(footprint,edge.a,edge.b);
    if(!located)continue;
    let top0={...edge.a},top1={...edge.b};
    let edgeT0=located.t0,edgeT1=located.t1;
    if(edgeT1<edgeT0){
      [top0,top1]=[top1,top0];
      [edgeT0,edgeT1]=[edgeT1,edgeT0];
    }
    const base0=atBase(top0),base1=atBase(top1);
    const raw=[base0,base1,top1,top0];
    const compact=raw.filter((p,index)=>{
      const prev=raw[(index-1+raw.length)%raw.length];
      return Math.hypot(p.x-prev.x,p.y-prev.y,p.z-prev.z)>EPS;
    });
    if(compact.length<3||polygonArea3D(compact)<=EPS)continue;
    const vertices3d=orientOutwardPolygon(compact,center);
    const closure={
      edgeIndex:located.edgeIndex,
      edgeT0,
      edgeT1,
      p1:{x:top0.x,y:top0.y},
      p2:{x:top1.x,y:top1.y},
      zBase:baseZ,
      topZ1:top0.z,
      topZ2:top1.z,
      vertices3d,
      area:polygonArea3D(vertices3d),
    };
    closureSurfaces.push(closure);
  }

  closureSurfaces.sort((a,b)=>(a.edgeIndex-b.edgeIndex)||(a.edgeT0-b.edgeT0));
  const mergedClosures=[];
  const rebuiltClosure=(first,last)=>{
    const raw=[
      {x:first.p1.x,y:first.p1.y,z:baseZ},
      {x:last.p2.x,y:last.p2.y,z:baseZ},
      {x:last.p2.x,y:last.p2.y,z:last.topZ2},
      {x:first.p1.x,y:first.p1.y,z:first.topZ1},
    ];
    const compact=raw.filter((p,index)=>{
      const prev=raw[(index-1+raw.length)%raw.length];
      return Math.hypot(p.x-prev.x,p.y-prev.y,p.z-prev.z)>EPS;
    });
    const vertices3d=orientOutwardPolygon(compact,center);
    return {
      ...first,
      edgeT1:last.edgeT1,
      p2:{...last.p2},
      topZ2:last.topZ2,
      vertices3d,
      area:polygonArea3D(vertices3d),
    };
  };
  closureSurfaces.forEach(closure=>{
    const previous=mergedClosures.at(-1);
    if(!previous||previous.edgeIndex!==closure.edgeIndex||Math.abs(previous.edgeT1-closure.edgeT0)>1e-7){
      mergedClosures.push({...closure,vertices3d:closure.vertices3d.map(p=>({...p}))});
      return;
    }
    const previousSpan=previous.edgeT1-previous.edgeT0;
    const currentSpan=closure.edgeT1-closure.edgeT0;
    const previousSlope=previousSpan>EPS?(previous.topZ2-previous.topZ1)/previousSpan:0;
    const currentSlope=currentSpan>EPS?(closure.topZ2-closure.topZ1)/currentSpan:0;
    if(Math.abs(previousSlope-currentSlope)>1e-6||Math.abs(previous.topZ2-closure.topZ1)>1e-6){
      mergedClosures.push({...closure,vertices3d:closure.vertices3d.map(p=>({...p}))});
      return;
    }
    mergedClosures[mergedClosures.length-1]=rebuiltClosure(previous,closure);
  });
  closureSurfaces.length=0;
  closureSurfaces.push(...mergedClosures.filter(closure=>closure.vertices3d.length>=3&&closure.area>EPS));
  closureSurfaces.forEach(closure=>{
    for(let i=1;i<closure.vertices3d.length-1;i++){
      const tri=orientOutward([closure.vertices3d[0],closure.vertices3d[i],closure.vertices3d[i+1]],center);
      if(nondegenerate(tri))closureTriangles.push(tri);
    }
  });
  const edgeSegmentCounts=new Map();
  closureSurfaces.forEach(closure=>{
    const segmentIndex=edgeSegmentCounts.get(closure.edgeIndex)||0;
    closure.segmentIndex=segmentIndex;
    edgeSegmentCounts.set(closure.edgeIndex,segmentIndex+1);
  });

  const extraVolume=cleanRoof.reduce((sum,tri)=>{
    const projected=Math.abs((tri[1].x-tri[0].x)*(tri[2].y-tri[0].y)-(tri[1].y-tri[0].y)*(tri[2].x-tri[0].x))/2;
    const avgRise=tri.reduce((s,p)=>s+(p.z-baseZ)/3,0);
    return sum+projected*avgRise;
  },0);
  const maxRise=Math.max(0,...cleanRoof.flat().map(p=>p.z-baseZ));
  return {roofTriangles:cleanRoof,closureTriangles,closureSurfaces,extraVolume,maxRise};
}

export function roofClosureOpeningFits(closure, opening, tolerance = 1e-7) {
  if (!closure || !opening) return false;
  const dx=closure.p2.x-closure.p1.x,dy=closure.p2.y-closure.p1.y;
  const length=Math.hypot(dx,dy);
  if(length<EPS)return false;
  const project=p=>((p.x-closure.p1.x)*dx+(p.y-closure.p1.y)*dy)/(length*length);
  const t0=project({x:opening.x1,y:opening.y1});
  const t1=project({x:opening.x2,y:opening.y2});
  const lo=Math.min(t0,t1),hi=Math.max(t0,t1);
  if(lo<-tolerance||hi>1+tolerance||hi-lo<tolerance)return false;
  const bottom=closure.zBase+(opening.z0||0);
  const top=bottom+(opening.height||0);
  const topAt=t=>closure.topZ1+t*(closure.topZ2-closure.topZ1);
  return bottom>=closure.zBase-tolerance
    && top>bottom+tolerance
    && top<=Math.min(topAt(lo),topAt(hi))+tolerance;
}

export function pointInTriangle2D(point, triangle, eps = 1e-7) {
  const sign=(p,a,b)=>(p.x-b.x)*(a.y-b.y)-(a.x-b.x)*(p.y-b.y);
  const d1=sign(point,triangle[0],triangle[1]);
  const d2=sign(point,triangle[1],triangle[2]);
  const d3=sign(point,triangle[2],triangle[0]);
  return !((d1<-eps||d2<-eps||d3<-eps)&&(d1>eps||d2>eps||d3>eps));
}

/** Clip a plan-view opening polygon to one (convex) roof triangle.
 *
 * Pitched roofs are exported as individual EnergyPlus base surfaces, and an
 * EnergyPlus fenestration surface may not cross from one base surface to the
 * next. Sutherland-Hodgman clipping gives the exact piece belonging to each
 * facet; callers can then lift the returned XY polygon onto that facet plane.
 */
export function clipPolygonToTriangle2D(polygon, triangle, eps = 1e-8) {
  if (!polygon?.length || polygon.length < 3 || !triangle?.length || triangle.length !== 3) return [];
  const clip = signedArea2D(triangle) >= 0 ? triangle : [...triangle].reverse();
  const side = (a,b,p) => (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
  const intersection = (start,end,a,b) => {
    const ds=side(a,b,start), de=side(a,b,end);
    const denom=ds-de;
    const t=Math.abs(denom)>eps?Math.max(0,Math.min(1,ds/denom)):0;
    return {x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t};
  };
  let output=polygon.map(point=>({x:+point.x,y:+point.y}));
  for(let edgeIndex=0;edgeIndex<clip.length;edgeIndex++){
    const a=clip[edgeIndex],b=clip[(edgeIndex+1)%clip.length];
    const input=output;
    output=[];
    if(!input.length)break;
    let start=input[input.length-1];
    let startInside=side(a,b,start)>=-eps;
    for(const end of input){
      const endInside=side(a,b,end)>=-eps;
      if(endInside!==startInside)output.push(intersection(start,end,a,b));
      if(endInside)output.push({...end});
      start=end;
      startInside=endInside;
    }
  }
  const compact=[];
  for(const point of output){
    if(!compact.length||Math.hypot(point.x-compact.at(-1).x,point.y-compact.at(-1).y)>eps)compact.push(point);
  }
  if(compact.length>1&&Math.hypot(compact[0].x-compact.at(-1).x,compact[0].y-compact.at(-1).y)<=eps)compact.pop();
  return compact.length>=3&&Math.abs(signedArea2D(compact))>eps?compact:[];
}

export function planeZAtPoint(triangle, point) {
  const n=cross3(...triangle);
  if(Math.abs(n.z)<EPS)return triangle.reduce((sum,p)=>sum+p.z/3,0);
  const a=triangle[0];
  return a.z-(n.x*(point.x-a.x)+n.y*(point.y-a.y))/n.z;
}
