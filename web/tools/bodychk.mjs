import { launchChromium } from './browser.mjs';
const b = await launchChromium();
const p = await b.newPage({ viewport:{width:640,height:360} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,200));});
await p.goto('http://127.0.0.1:8899/index.html',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__app?.ready===true,{timeout:120000});
await p.evaluate(()=>window.__app.setView('street'));
await p.evaluate(()=>window.__app.fireAt('rocket',[6.0,2.6,4.0],[12.2,2.4,8.0],1));
await p.evaluate(()=>window.__app.simulate(0.25));
const info = await p.evaluate(()=>{
  const A=window.__app, br=A.renderer.bodyRenderer;
  const bodies=A.engine.physics.bodies;
  return {
    physicsBodies: bodies.length,
    bodyInfo: bodies.slice(0,4).map(x=>({cells:x.cells?x.cells.length:0, pos:x.pos.map(v=>+v.toFixed(2)), alive:x.alive})),
    brStats: br ? br.stats : 'NO BODYRENDERER',
    meshCount: br ? br.meshes.size : -1,
    groupChildren: br ? br.group.children.length : -1,
    debrisCount: A.engine.physics.debris.parts.filter(d=>d.alive).length,
  };
});
console.log(JSON.stringify(info,null,1));
if(errs.length){console.log('ERRORS:');errs.slice(0,6).forEach(e=>console.log(' ',e));}
await b.close();
