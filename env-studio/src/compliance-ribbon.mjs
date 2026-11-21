// The ribbon selects inputs; the existing NCC and LEED engines own every rule.
let standard='ncc';
const snapshots={};
const workspace=document.createElement('section');
workspace.className='ribbon-compliance-workspace';workspace.hidden=true;
workspace.setAttribute('aria-label','Compliance requirements');
document.querySelector('.body').append(workspace);
const run=document.createElement('button');
run.id='ribbon-compliance-run';run.type='button';run.className='run-btn energy-mode';
run.innerHTML='<svg class="lucide-icon ribbon-run-icon" aria-hidden="true"><use href="#ribbon-play"/></svg><span>RUN CHECK</span>';
run.hidden=true;document.querySelector('#ribbon-run-group .sim-controls').append(run);
const esc=value=>String(value ?? '—').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const number=value=>Number.isFinite(value)?value.toFixed(2):'—';
const active=()=>{const s=window.envRibbonUI.getState();return s.activeTab==='energy'&&s.activeEnergySubtab==='compliance';};
function fix(type,zoneId=null) {
  if(zoneId) {
    const zone=window.getProjectBrowserSnapshot().levels.flatMap(level=>level.zones).find(zone=>zone.btmId===zoneId || zone.id===zoneId);
    if(zone)window.selectEnergyBrowserNode({kind:'zone',id:`zone:${zone.id}`,zoneId:zone.id,btmId:zone.btmId,levelIdx:zone.levelIdx});
  } else window.selectEnergyBrowserNode({kind:'building',id:'building'});
  window.envRibbonUI.activateEnergySubtab(type==='lighting'?'activity':'constructions');
  const label={extWall:'Ext wall',roof:'Roof',window:'Windows',groundFloor:'Ground slab',exposedFloor:'Ext slab',lighting:'Lighting'}[type];
  [...document.querySelectorAll('.ribbon-command')].find(button=>button.querySelector('.ribbon-command-label')?.textContent===label)?.click();
}
function renderRequirements() {
  const saved=snapshots[standard];
  const rows=saved?.rows || [];
  const passed=rows.filter(row=>row.pass===true).length;
  workspace.innerHTML=`<div class="ribbon-requirements"><h2>${standard==='ncc'?'NCC 2022 Section J':'LEED v5 BD+C'} · Requirements</h2><p class="en-settings-note">${saved?'Snapshot from the last check. Run again after changing the model or settings.':'Choose the project settings above, then Run check.'} Whole-project checks; use the Browser to select a construction scope.</p><table><thead><tr><th>Requirement</th><th>Your design</th><th>Limit / method</th><th>Result</th><th>Where to fix</th></tr></thead><tbody>${rows.map((row,index)=>`<tr><td>${esc(row.label)}</td><td>${esc(row.design)}</td><td>${esc(row.limit)}</td><td><span class="ribbon-check-status ${row.pass===true?'pass':'review'}">${row.pass===true?'Pass':row.pass===false?'Fix':'Review'}</span></td><td>${row.fix?`<button type="button" data-fix="${index}">${esc(row.fixLabel || 'Open settings')} ›</button>`:'—'}</td></tr>`).join('') || '<tr><td colspan="5">No check has been run.</td></tr>'}</tbody></table></div><aside class="ribbon-compliance-summary"><span>Result</span><strong>${saved?`${passed} of ${rows.length}`:'—'}</strong><span>${standard==='leed'?'readiness checks met':'requirements met'}</span><progress max="${Math.max(1,rows.length)}" value="${passed}"></progress><p>${esc(saved?.note || 'Results use the app’s existing rules and project data.')}</p></aside>`;
  workspace.querySelectorAll('[data-fix]').forEach(button=>button.onclick=()=>rows[Number(button.dataset.fix)].fix());
}
function nccRows(result) {
  const rows=[];
  const add=(label,design,limit,pass,type,zoneId)=>rows.push({label,design,limit,pass,fix:()=>fix(type,zoneId),fixLabel:({extWall:'Ext wall',window:'Windows',roof:'Roof',groundFloor:'Ground slab',exposedFloor:'Ext slab',lighting:'Lighting'})[type]});
  for(const row of result.facade.rows) {
    add(`${row.aspect} · External wall insulation`,`R ${number(row.opaqueR)}`,`R ≥ ${number(row.wallRRequired)}`,row.wallRPass,'extWall');
    if(result.facade.method==='method1') {
      add(`${row.aspect} · Façade heat flow`,`U ${number(row.totalSystemU)} W/m²K`,`U ≤ ${number(row.uLimit)}`,row.uPass,'window');
      add(`${row.aspect} · Façade solar admittance`,number(row.solarAdmittance),`≤ ${number(row.solarLimit)}`,row.solarPass,'window');
    }
  }
  rows.push({label:'Façade · selected method',design:result.facade.method==='method1'?'Method 1':'Method 2 · combined façade',limit:'J4D6 / Specification 37',pass:result.facade.pass,fix:()=>window.enOpenSectionJWorkspace(),fixLabel:'Advanced'});
  for(const zone of result.btm.zones.filter(zone=>result.exported.surfaceManifest.some(item=>item.kind==='surface'&&item.assembly==='roof'&&item.zoneId===zone.id))) {
    const r=window.enNccEffectiveOpaqueR(zone,'roof');
    add(`${zone.name || zone.id} · Roof insulation`,`R ${number(r)}`,`R ≥ ${number(result.targets.roofR)}`,r+1e-9>=result.targets.roofR,'roof',zone.id);
  }
  for(const row of result.envelope.floorRows)add(`${row.zone?.name || row.zone?.id} · Floor insulation`,`R ${number(row.r)}`,row.deemedGround?'Ground-floor provision':`R ≥ ${number(result.targets.floorR)}`,row.pass,row.deemedGround || row.surface.boundary==='Ground'?'groundFloor':'exposedFloor',row.zone?.id);
  result.lighting.rows.forEach((row,index)=>add(`${row.label} · Lighting`,`${number(row.designWPerM2)} W/m²`,row.allowedWPerM2==null?'Evidence required':`≤ ${number(row.allowedWPerM2)} W/m²`,row.pass,'lighting',result.btm.zones.filter(zone=>zone.height>0)[index]?.id));
  rows.push({label:'Roof solar absorptance',design:'Assembly surface properties',limit:result.targets.roofSolarAbsorptanceMax==null?'No limit triggered':`≤ ${number(result.targets.roofSolarAbsorptanceMax)}`,pass:result.envelope.roofSolarPass,fix:()=>fix('roof'),fixLabel:'Roof'});
  rows.push({label:'Rooflight area and performance',design:`${number(result.envelope.rooflightAreaRatio*100)}% rooflight area`,limit:`≤ ${number(result.targets.roofLightAreaRatioMax*100)}% + thermal limits`,pass:result.envelope.rooflightAreaPass&&result.envelope.rooflightPerformancePass,fix:()=>fix('window'),fixLabel:'Windows'});
  rows.push({label:'J5 / J6 / J8 / J9 evidence',design:'Project evidence',limit:'Existing Section J evidence checklist',pass:result.evidence.pass,fix:()=>window.enOpenSectionJWorkspace(),fixLabel:'Advanced'});
  return rows;
}
function runCheck() {
  if(standard==='ncc' && window.enSectionJSettings().pathway==='j1v3') {
    window.enOpenSectionJWorkspace('results');window.enRunJ1V3();return;
  }
  if(standard==='ncc') {
    const result=window.enSectionJAssess(false);
    snapshots.ncc=result?{rows:nccRows(result),note:'Automated DTS screening. Review project evidence and the adopted ruleset in Advanced.'}:{rows:[{label:'Model readiness',design:'No conditioned zone',limit:'Draw at least one conditioned zone',pass:false}],note:'A conditioned zone is required.'};
  } else {
    const validation=window.enLeedV5Validate({switchTab:false});
    const energyResult=window._leedV5LastResult?.comparison;
    snapshots.leed={rows:[{label:'Energy screen inputs',design:`${validation.errors.length} blockers`,limit:'All required inputs resolved',pass:validation.valid},...validation.errors.map(message=>({label:message,design:'Missing / invalid input',limit:'Required before simulation',pass:false,fix:()=>window.enOpenLeedV5Workspace(),fixLabel:'Advanced'})),...validation.warnings.map(message=>({label:message,design:'Review',limit:'Modeler review required',pass:null,fix:()=>window.enOpenLeedV5Workspace(),fixLabel:'Advanced'}))],note:energyResult?`Last energy screen: estimated EAc3 ${energyResult.credit.estimatedPoints} / 10 points. Open the report to review its inputs and limitations.`:'Readiness only. Energy points require the proposed and four rotated baseline simulations in Performance.'};
  }
  renderRequirements();
}
run.onclick=runCheck;
export function syncCompliance() {
  const show=active();workspace.hidden=!show;run.hidden=!show;
  document.body.classList.toggle('ribbon-compliance-active',show);
  if(show){
    const browser=document.getElementById('project-browser');
    const left=browser.hidden?0:browser.getBoundingClientRect().right-document.querySelector('.body').getBoundingClientRect().left;
    workspace.style.left=`${left}px`;renderRequirements();
  }
}
window.addEventListener('resize',()=>{if(active())syncCompliance();});
export function renderComplianceGroup(group,name,{button,selectField}) {
  const settings=standard==='ncc'?window.enSectionJSettings():window.enLeedV5Settings();
  const stack=document.createElement('div');stack.className='ribbon-live-controls';
  if(['Standard','Project'].includes(name) || (name==='Pathway' && standard==='ncc'))group.append(stack);
  const set=(key,value,kind)=>{
    (standard==='ncc'?window.enSectionJSet:window.enLeedV5Set)(key,value,kind);
    delete snapshots[standard];window.envRibbonUI.refresh();syncCompliance();
  };
  if(name==='Standard')selectField(stack,'Standard',[['ncc','NCC 2022 · Section J'],['leed','LEED v5 · BD+C']],standard,value=>{standard=value;window.envRibbonUI.refresh();syncCompliance();});
  if(name==='Project') {
    const climates=standard==='ncc'?Object.entries(window.NCC_CLIMATE_ZONES).map(([key,label])=>[key,`Zone ${key} · ${label}`]):window.LEED_CLIMATE_ZONES.map(value=>[value,value]);
    selectField(stack,'Climate zone',climates,settings.climateZone,value=>set('climateZone',value,standard==='ncc'?'number':'string'));
    const classes=standard==='ncc'?window.NCC_BUILDING_CLASSES:window.LEED_BUILDING_AREA_TYPES;
    selectField(stack,standard==='ncc'?'Building class':'Building area type',Object.entries(classes).map(([key,row])=>[key,typeof row==='string'?row:row.label]),standard==='ncc'?settings.buildingClass:settings.buildingAreaType,value=>set(standard==='ncc'?'buildingClass':'buildingAreaType',value));
  }
  if(name==='Pathway') {
    if(standard==='ncc')selectField(stack,'Pathway',[['dts','Deemed-to-satisfy'],['j1v3','Performance · J1V3 screen']],settings.pathway,value=>set('pathway',value));
    else button(group,'Performance','ribbon-play',()=>{window.enOpenLeedV5Workspace();window.enRunLeedV5Screen();});
  }
  if(name==='Report') {
    button(group,'Report','lucide-sheet',()=>standard==='ncc'?window.enOpenSectionJWorkspace('results'):window.enOpenLeedV5Workspace('results'));
    button(group,'Export report','lucide-sheet',()=>standard==='ncc'?window.enSectionJExportReport():window.enLeedV5ExportReport());
    button(group,'Advanced','ribbon-sliders',()=>standard==='ncc'?window.enOpenSectionJWorkspace():window.enOpenLeedV5Workspace());
  }
}
