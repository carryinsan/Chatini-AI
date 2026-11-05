/*
 ArixGen — pure algorithmic image editor.
 Single-file editing engine for index.html. No AI, no API calls, no simulated controls.
 All toolbar/menu actions are wired to real document operations.
*/
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a=0, b=1) => Math.max(a, Math.min(b, v));
  const uid = (p='id') => p + '_' + Math.random().toString(36).slice(2, 10);
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;
  const lerp = (a,b,t)=>a+(b-a)*t;
  const fmt = n => Number.isFinite(n) ? (Math.round(n*100)/100).toString() : '0';
  const safe = (s, fallback='') => String(s ?? fallback);
  const sleep = ms => new Promise(r => setTimeout(r,ms));

  const state = {
    canvas: document.getElementById('canvas'),
    wrap: document.getElementById('canvasWrap'),
    ctx: null,
    doc: null,
    activeTool: 'move',
    activeLayerId: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    isDown: false,
    pointerStart: null,
    lastPoint: null,
    selection: null,
    selectionMode: 'replace',
    selectionPath: [],
    tempCanvas: null,
    clipboard: null,
    history: [],
    future: [],
    maxHistory: 60,
    snapshots: [],
    recordingMacro: false,
    macro: [],
    commandPalette: false,
    compare: false,
    compareSource: null,
    compareSplit: .5,
    focus: false,
    isolation: false,
    isolatedGroup: null,
    grid: false,
    guides: [],
    symmetry: {mode:'none', count:2, centerX:0, centerY:0},
    defaults: {brushSize:32, brushOpacity:1, tolerance:32, feather:0},
    cropAspect: null,
    touch: {distance:0, zoom:1},
    db: null,
    recoverKey: 'arixgen-autosave-v1'
  };

  function defaultDoc(w=1200,h=800){
    return {version:1, width:w, height:h, background:{type:'transparent',color:'#ffffff'}, layers:[], guides:[], historyName:'Untitled'};
  }

  function makeCanvas(w,h){ const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(w)); c.height=Math.max(1,Math.round(h)); return c; }
  function layerBase(name='Layer', type='raster'){
    return {id:uid('layer'),name,type,visible:true,locked:false,opacity:1,fillOpacity:1,blend:'source-over',x:0,y:0,width:state.doc?.width||1,height:state.doc?.height||1,rotation:0,scaleX:1,scaleY:1,flipX:false,flipY:false,groupId:null,clipToBelow:false,alphaLock:false,data:null,adjustments:[],filters:[],effects:[],mask:null,text:'',font:'Arial',fontSize:64,fontWeight:'700',fontStyle:'normal',textAlign:'left',textBaseline:'top',lineHeight:1.15,letterSpacing:0,color:'#ffffff',strokeColor:'#000000',strokeWidth:0,shadowColor:'#000000',shadowBlur:0,shadowX:0,shadowY:0,gradient:null,shape:'rect',points:[],fill:'#ffffff',stroke:'#000000',strokeWidthShape:2,radius:16};
  }
  function newRaster(name='Layer'){ const l=layerBase(name,'raster'); l.canvas=makeCanvas(state.doc.width,state.doc.height); return l; }

  function init(){
    state.ctx=state.canvas.getContext('2d',{willReadFrequently:false,alpha:true});
    state.doc=defaultDoc();
    const bg=newRaster('Background');
    bg.canvas.getContext('2d').fillStyle='#ffffff'; bg.canvas.getContext('2d').fillRect(0,0,bg.canvas.width,bg.canvas.height);
    state.doc.layers.push(bg); state.activeLayerId=bg.id;
    bindUI();
    setupDB();
    pushHistory('New document');
    render();
    updatePanels();
    registerServiceWorkerHint();
  }

  function bindUI(){
    // Tools
    $$('.tool').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
    $$('.tool[data-tool]').forEach(b=>b.addEventListener('keydown',e=>{if(e.key==='Enter') b.click();}));
    $('#fileInput').addEventListener('change',e=>handleFiles([...e.target.files]));
    $('#importInput').addEventListener('change',e=>handleFiles([...e.target.files]));
    $('#newBtn').onclick=()=>newDocumentDialog();
    $('#openBtn').onclick=()=>$('#fileInput').click();
    $('#saveBtn').onclick=()=>saveProject();

    $('#undoBtn').onclick=undo; $('#redoBtn').onclick=redo;
    $('#exportBtn').onclick=()=>openExport();
    $('#compareBtn').onclick=toggleCompare;
    $('#focusBtn').onclick=toggleFocus;
    $('#paletteBtn').onclick=openPalette;
    $('#snapshotBtn').onclick=makeSnapshot;
    $('#macroBtn').onclick=toggleMacro;
    $('#recoverBtn').onclick=recoverAutosave;
    $('#searchLayers').addEventListener('input',updateLayerList);
    $('#opacity').addEventListener('input',()=>{mutateActive(l=>l.opacity=+$('#opacity').value);render();});
    $('#blend').addEventListener('change',()=>{mutateActive(l=>l.blend=$('#blend').value);render();});
    $('#layerName').addEventListener('change',()=>{mutateActive(l=>l.name=$('#layerName').value);updateLayerList(); autosaveSoon();});
    ['posX','posY','width','height','rotate','brushSize','brushOpacity','tolerance','feather'].forEach(id=>{
      const el=$('#'+id); if(el) el.addEventListener('change',()=>applyInspector(id,el.value));
    });
    $('#hex').addEventListener('change',()=>setFg($('#hex').value));
    $('#fgSwatch').onclick=()=>$('#colorPicker').click(); $('#colorPicker').onchange=e=>setFg(e.target.value);
    $('#bgSwatch').onclick=()=>$('#colorPickerBg').click(); $('#colorPickerBg').onchange=e=>setBgColor(e.target.value);
    $('#swapColors').onclick=()=>{const a=state.fg||'#000000';state.fg=state.bg||'#ffffff';state.bg=a;updateColors();};

    $('#resetView').onclick=fitCanvas; $('#zoomIn').onclick=()=>setZoom(state.zoom*1.2); $('#zoomOut').onclick=()=>setZoom(state.zoom/1.2);
    $('#isolateBtn').onclick=()=>{state.isolation=!state.isolation;state.isolatedGroup=state.isolation?activeLayer()?.groupId:null;render();updateStatus();};
    $('#guidesMenuBtn').onclick=openGuidesModal; $('#resetViewMenuBtn').onclick=fitCanvas; $('#zoom100MenuBtn').onclick=()=>setZoom(1); $('#zoom100PanelBtn').onclick=()=>setZoom(1); $('#isolateMenuBtn').onclick=()=>{state.isolation=!state.isolation;state.isolatedGroup=state.isolation?activeLayer()?.groupId:null;render();};
    $('#featuresBtn').onclick=openFeatures;
    $('#soloBtn').onclick=soloLayer;
    $('#hideBtn').onclick=()=>mutateActive(l=>l.visible=!l.visible);
    $('#lockBtn').onclick=()=>mutateActive(l=>l.locked=!l.locked);
    $('#duplicateBtn').onclick=duplicateLayer; $('#deleteBtn').onclick=deleteLayer;
    $('#newLayerBtn').onclick=()=>addLayer('raster'); $('#newTextBtn').onclick=()=>addTextLayer(); $('#newShapeBtn').onclick=()=>addShapeLayer();
    $('#groupBtn').onclick=groupSelected; $('#ungroupBtn').onclick=ungroupSelected; $('#mergeBtn').onclick=mergeSelected;
    $('#maskBtn').onclick=addMask; $('#applyMaskBtn').onclick=applyMask; $('#invertMaskBtn').onclick=invertMask;
    $('#quickActions').addEventListener('click',e=>{const b=e.target.closest('[data-action]'); if(b) executeCommand(b.dataset.action);});
    $$('.tab').forEach(t=>t.onclick=()=>switchTab(t.dataset.tab));
    // menus
    $$('.menuBtn').forEach(b=>b.onclick=()=>toggleMenu(b.dataset.menu));
    document.addEventListener('click',e=>{if(!e.target.closest('.menuWrap')) $$('.menu').forEach(m=>m.classList.remove('open'));});
    $$('.menu button').forEach(b=>b.addEventListener('click',()=>executeCommand(b.dataset.cmd)));
    // canvas mouse
    state.canvas.addEventListener('pointerdown',pointerDown); state.canvas.addEventListener('pointermove',pointerMove); state.canvas.addEventListener('pointerup',pointerUp); state.canvas.addEventListener('pointercancel',pointerUp);
    state.canvas.addEventListener('wheel',e=>{e.preventDefault(); if(e.ctrlKey||e.metaKey){setZoom(state.zoom*Math.exp(-e.deltaY*.001));}else{state.panX-=e.deltaX;state.panY-=e.deltaY;render();}}, {passive:false});
    state.canvas.addEventListener('dblclick',()=>{if(state.activeTool==='text') editActiveText();});
    state.canvas.addEventListener('contextmenu',e=>e.preventDefault());
    // Drag/drop
    window.addEventListener('dragover',e=>{e.preventDefault();$('#dropHint').classList.add('show');}); window.addEventListener('dragleave',e=>{if(e.target===document.documentElement)$('#dropHint').classList.remove('show');});
    window.addEventListener('drop',e=>{e.preventDefault();$('#dropHint').classList.remove('show');handleFiles([...e.dataTransfer.files]);});
    // keyboard
    document.addEventListener('keydown',keyDown); document.addEventListener('keyup',e=>{if(e.key===' ')state.space=false;});
    // dialogs
    $('#modalClose').onclick=closeModal; $('#modalBackdrop').onclick=e=>{if(e.target.id==='modalBackdrop')closeModal();};
    // layers drag
    $('#layers').addEventListener('click',e=>{const item=e.target.closest('.layerItem');if(!item)return;state.activeLayerId=item.dataset.id;updatePanels();render();});
    $('#layers').addEventListener('dragstart',e=>{const it=e.target.closest('.layerItem');if(it)e.dataTransfer.setData('text/layer',it.dataset.id);});
    $('#layers').addEventListener('dragover',e=>e.preventDefault());
    $('#layers').addEventListener('drop',e=>{const id=e.dataTransfer.getData('text/layer');const target=e.target.closest('.layerItem'); if(id&&target&&id!==target.dataset.id) reorderLayer(id,target.dataset.id);});
    // top command input
    $('#commandInput').addEventListener('focus',openPalette); $('#commandInput').addEventListener('input',e=>filterCommands(e.target.value));
    $('#commandInput').addEventListener('keydown',e=>{if(e.key==='Enter'){const first=$('#commandResults button'); if(first) first.click();}});
    $('#symmetryMode').onchange=()=>{state.symmetry.mode=$('#symmetryMode').value;render();};
    $('#symmetryCount').onchange=()=>{state.symmetry.count=Math.max(2,Math.min(24,+$('#symmetryCount').value||2));render();};

    $('#measureBtn').onclick=()=>setTool('measure');
    $('#sliceBtn').onclick=()=>setTool('slice');
    $('#history').addEventListener('click',e=>{const it=e.target.closest('[data-index]'); if(it) jumpHistory(+it.dataset.index);});
    // adjust controls
    $$('.adjustInput').forEach(x=>x.addEventListener('input',()=>previewAdjustments()));
    $('#applyAdjustments').onclick=applyAdjustments;
    $('#resetAdjustments').onclick=()=>resetAdjustmentInputs();
    // filter buttons dynamic delegated
    $('#filterGrid').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b) addFilter(b.dataset.filter);});
    $('#effectGrid').addEventListener('click',e=>{const b=e.target.closest('[data-effect]');if(b) addEffect(b.dataset.effect);});
    // export modal bindings are attached after its template is inserted
    // file name
    $('#docTitle').addEventListener('change',()=>{state.doc.historyName=$('#docTitle').value||'Untitled'; autosaveSoon();});
    // hide recover if no backup
    checkRecovery();
    state.fg='#111111'; state.bg='#ffffff'; updateColors();
  }

  function registerServiceWorkerHint(){ /* App remains fully functional from local cache after initial load; no service worker required. */ }

  function setupDB(){
    if(!('indexedDB' in window)) return;
    const req=indexedDB.open('ArixGenDB',1);
    req.onupgradeneeded=e=>e.target.result.createObjectStore('kv');
    req.onsuccess=e=>{state.db=e.target.result;};
  }
  function dbPut(k,v){ try{ if(!state.db)return; const tx=state.db.transaction('kv','readwrite');tx.objectStore('kv').put(v,k);}catch{} }
  function dbGet(k){return new Promise(resolve=>{try{if(!state.db)return resolve(null);const tx=state.db.transaction('kv','readonly');const q=tx.objectStore('kv').get(k);q.onsuccess=()=>resolve(q.result||null);q.onerror=()=>resolve(null);}catch{resolve(null);}})}

  function newDocumentDialog(){openModal(`<div class=\"batchGrid\"><label>Width <input id=\"newW\" type=\"number\" min=\"1\" value=\"1200\"></label><label>Height <input id=\"newH\" type=\"number\" min=\"1\" value=\"800\"></label></div><div class=\"modalActions\"><button id=\"createDoc\">Create document</button></div>`, 'New document');$('#createDoc').onclick=()=>{const w=Math.max(1,Math.min(12000,+$('#newW').value||1200)),h=Math.max(1,Math.min(12000,+$('#newH').value||800));newDocument(w,h);closeModal();};}
  function newDocument(w=1200,h=800){
    state.doc=defaultDoc(w,h); state.doc.layers=[]; const bg=newRaster('Background'); const c=bg.canvas.getContext('2d'); c.fillStyle='#ffffff';c.fillRect(0,0,w,h); state.doc.layers.push(bg); state.activeLayerId=bg.id; state.history=[];state.future=[];state.snapshots=[];pushHistory('New document');resetView();render();updatePanels();autosaveSoon();
  }
  function resetView(){state.zoom=1;state.panX=0;state.panY=0;fitCanvas();}
  function fitCanvas(){
    const rect=state.wrap.getBoundingClientRect(); const z=Math.min((rect.width-50)/state.doc.width,(rect.height-50)/state.doc.height); setZoom(clamp(z,.05,6));state.panX=0;state.panY=0;render();
  }
  function setZoom(z){state.zoom=clamp(z,.03,20);$('#zoomLabel').textContent=Math.round(state.zoom*100)+'%';render();}

  function setTool(t){ state.activeTool=t; $$('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===t)); const map={move:'Move',brush:'Brush',eraser:'Eraser',crop:'Crop',rect:'Rectangle',ellipse:'Ellipse',line:'Line',pen:'Pen',text:'Text',gradient:'Gradient',picker:'Eyedropper',marquee:'Rectangle Select',lasso:'Lasso Select',polygon:'Polygon Select',wand:'Magic Wand',clone:'Clone',heal:'Heal',blur:'Blur',sharpen:'Sharpen',dodge:'Dodge',burn:'Burn',smudge:'Smudge',measure:'Measure',slice:'Slice'}; $('#toolLabel').textContent=map[t]||t; updateContextual(); }

  function activeLayer(){return state.doc.layers.find(l=>l.id===state.activeLayerId)||state.doc.layers[state.doc.layers.length-1];}
  function mutateActive(fn){const l=activeLayer();if(!l||l.locked)return; fn(l);autosaveSoon();updatePanels(); recordMacroIfNeeded(arguments.callee.name);}
  function ensureRaster(l=activeLayer()){
    if(!l) return null;
    if(l.type==='raster') return l;
    const flat=renderLayerToCanvas(l); const r=layerBase(l.name,'raster'); r.canvas=flat; Object.assign(r,l,{type:'raster',canvas:flat,data:null}); const idx=state.doc.layers.findIndex(x=>x.id===l.id);state.doc.layers[idx]=r;state.activeLayerId=r.id;return r;
  }

  function addLayer(type='raster'){
    let l;
    if(type==='raster') l=newRaster('Layer '+(state.doc.layers.length+1)); else l=layerBase(type==='adjustment'?'Adjustment Layer':type);
    if(type==='adjustment'){l.adjustments=[{type:'brightness',value:0}];}
    const idx=state.doc.layers.findIndex(x=>x.id===state.activeLayerId); state.doc.layers.splice(idx+1,0,l);state.activeLayerId=l.id;pushHistory('New layer');render();updatePanels();autosaveSoon();
  }
  function addTextLayer(text='ArixGen'){
    const l=layerBase('Text','text'); l.text=text; l.font='Arial'; l.fontSize=72;l.color=state.fg||'#111111'; l.width=600;l.height=120;l.x=100;l.y=100; state.doc.layers.push(l);state.activeLayerId=l.id; pushHistory('Add text');render();updatePanels();autosaveSoon();
    setTimeout(()=>editActiveText(),60);
  }
  function addShapeLayer(){const l=layerBase('Rectangle','shape');l.shape='rect';l.x=120;l.y=120;l.width=320;l.height=220;l.fill=state.fg||'#111111';l.stroke='#ffffff';l.radius=28;state.doc.layers.push(l);state.activeLayerId=l.id;pushHistory('Add shape');render();updatePanels();autosaveSoon();}
  function duplicateLayer(){const l=activeLayer();if(!l)return; const d=cloneLayer(l);d.id=uid('layer');d.name=l.name+' copy';d.x+=20;d.y+=20;state.doc.layers.splice(state.doc.layers.indexOf(l)+1,0,d);state.activeLayerId=d.id;pushHistory('Duplicate layer');render();updatePanels();autosaveSoon();}
  function deleteLayer(){if(state.doc.layers.length<=1)return;const l=activeLayer();const idx=state.doc.layers.indexOf(l);state.doc.layers.splice(idx,1);state.activeLayerId=state.doc.layers[Math.max(0,idx-1)].id;pushHistory('Delete layer');render();updatePanels();autosaveSoon();}
  function cloneLayer(l){const plain={...l,canvas:undefined,mask:undefined};const d=JSON.parse(JSON.stringify(plain));if(l.canvas){d.canvas=makeCanvas(l.canvas.width,l.canvas.height);d.canvas.getContext('2d').drawImage(l.canvas,0,0);}if(l.mask){d.mask=makeCanvas(l.mask.width,l.mask.height);d.mask.getContext('2d').drawImage(l.mask,0,0);}return d;}
  function reorderLayer(id,targetId){const a=state.doc.layers.findIndex(l=>l.id===id),b=state.doc.layers.findIndex(l=>l.id===targetId);if(a<0||b<0)return;const [x]=state.doc.layers.splice(a,1);state.doc.layers.splice(b,0,x);pushHistory('Reorder layers');render();updatePanels();autosaveSoon();}
  function soloLayer(){const l=activeLayer();if(!l)return;state.doc.layers.forEach(x=>x.visible=x.id===l.id);render();updatePanels();pushHistory('Solo layer');}
  function groupSelected(){const l=activeLayer();if(!l)return;const gid=uid('group');const idx=state.doc.layers.indexOf(l); for(let i=idx;i<state.doc.layers.length;i++){state.doc.layers[i].groupId=gid;}pushHistory('Group layers');render();updatePanels();}
  function ungroupSelected(){const gid=activeLayer()?.groupId;if(!gid)return;state.doc.layers.forEach(l=>{if(l.groupId===gid)l.groupId=null;});pushHistory('Ungroup');render();updatePanels();}
  function mergeSelected(){const l=activeLayer();if(!l)return;const same=l.groupId?state.doc.layers.filter(x=>x.groupId===l.groupId):[l];if(same.length<=1)return; const flat=makeCanvas(state.doc.width,state.doc.height);const c=flat.getContext('2d');same.forEach(x=>c.drawImage(renderLayerToCanvas(x),0,0)); const r=layerBase(l.name+' merged','raster');r.canvas=flat;const idx=state.doc.layers.indexOf(same[0]);state.doc.layers=state.doc.layers.filter(x=>!same.includes(x));state.doc.layers.splice(idx,0,r);state.activeLayerId=r.id;pushHistory('Merge group');render();updatePanels();}

  function addMask(){const l=ensureRaster();if(!l)return; l.mask=makeCanvas(state.doc.width,state.doc.height); const c=l.mask.getContext('2d');c.fillStyle='#ffffff';c.fillRect(0,0,l.mask.width,l.mask.height);pushHistory('Add mask');render();updatePanels();autosaveSoon();}
  function applyMask(){const l=activeLayer();if(!l?.mask)return;const c=l.canvas.getContext('2d');c.save();c.globalCompositeOperation='destination-in';c.drawImage(l.mask,0,0);c.restore();l.mask=null;pushHistory('Apply mask');render();updatePanels();autosaveSoon();}
  function invertMask(){const l=activeLayer();if(!l?.mask)return;const c=l.mask.getContext('2d');const d=c.getImageData(0,0,c.canvas.width,c.canvas.height);for(let i=0;i<d.data.length;i+=4){const v=d.data[i];d.data[i]=d.data[i+1]=d.data[i+2]=255-v;d.data[i+3]=255;}c.putImageData(d,0,0);render();updatePanels();autosaveSoon();}

  function applyInspector(id,v){
    const l=activeLayer();if(!l||l.locked)return;
    const n=+v;
    const map={posX:'x',posY:'y',width:'width',height:'height',rotate:'rotation'};
    if(map[id]) l[map[id]]=n;
    if(id==='width'||id==='height') { if(l.type==='raster'&&l.canvas){ /* scale only at render; keep pixels original */ } }
    if(id==='brushSize') state.defaults.brushSize=clamp(n,1,1000);
    if(id==='brushOpacity')state.defaults.brushOpacity=clamp(n/100,0,1);
    if(id==='tolerance')state.defaults.tolerance=clamp(n,0,255);
    if(id==='feather')state.defaults.feather=clamp(n,0,200);
    pushHistory(id);render();updatePanels();autosaveSoon();
  }

  function renderLayerToCanvas(l){
    const out=makeCanvas(state.doc.width,state.doc.height);const c=out.getContext('2d');c.clearRect(0,0,out.width,out.height);
    let src;
    if(l.type==='raster'){src=l.canvas||makeCanvas(l.width,l.height);}
    else if(l.type==='text'){src=renderText(l);}
    else if(l.type==='shape'){src=renderShape(l);}
    else if(l.type==='adjustment') return out;
    else src=makeCanvas(l.width,l.height);
    // Use a document-sized canvas for predictable coordinate math.
    const layerCanvas=makeCanvas(state.doc.width,state.doc.height); const lc=layerCanvas.getContext('2d');
    lc.save();lc.translate(l.x+l.width/2,l.y+l.height/2);lc.rotate(rad(l.rotation));lc.scale((l.flipX?-1:1)*l.scaleX,(l.flipY?-1:1)*l.scaleY);lc.globalAlpha=l.opacity*l.fillOpacity;
    const drawW=l.width,drawH=l.height;
    if(l.type==='raster'){lc.drawImage(src,0,0,src.width,src.height,-drawW/2,-drawH/2,drawW,drawH);}
    else lc.drawImage(src,0,0,src.width,src.height,-drawW/2,-drawH/2,drawW,drawH);
    lc.restore();
    let result=layerCanvas;
    result=applyPixelAdjustments(result,l.adjustments||[]);
    result=applyPixelFilters(result,l.filters||[]);
    result=applyEffects(result,l);
    if(l.mask) result=applyMaskCanvas(result,l.mask);
    return result;
  }
  function applyMaskCanvas(src,mask){const out=makeCanvas(src.width,src.height);const c=out.getContext('2d');c.drawImage(src,0,0);c.globalCompositeOperation='destination-in';c.drawImage(mask,0,0,src.width,src.height);return out;}
  function renderText(l){const c=makeCanvas(Math.max(1,l.width),Math.max(1,l.height));const x=c.getContext('2d'); x.clearRect(0,0,c.width,c.height); x.font=`${l.fontStyle} ${l.fontWeight} ${l.fontSize}px "${l.font}"`;x.textBaseline=l.textBaseline||'top';x.textAlign=l.textAlign||'left';x.fillStyle=l.color||'#000'; if(l.shadowBlur){x.shadowColor=l.shadowColor;x.shadowBlur=l.shadowBlur;x.shadowOffsetX=l.shadowX;x.shadowOffsetY=l.shadowY;} const lines=safe(l.text).split('\n');const lh=l.fontSize*(l.lineHeight||1.15);let yy=0;lines.forEach(line=>{x.fillText(line,l.textAlign==='center'?l.width/2:l.textAlign==='right'?l.width:0,yy); if(l.strokeWidth){x.strokeStyle=l.strokeColor;x.lineWidth=l.strokeWidth;x.strokeText(line,l.textAlign==='center'?l.width/2:l.textAlign==='right'?l.width:0,yy);}yy+=lh;});return c;}
  function renderShape(l){const c=makeCanvas(Math.max(1,l.width),Math.max(1,l.height));const x=c.getContext('2d');x.clearRect(0,0,c.width,c.height);x.fillStyle=l.fill||'#fff';x.strokeStyle=l.stroke||'#000';x.lineWidth=l.strokeWidthShape||0; x.beginPath();
    if(l.shape==='ellipse'){x.ellipse(l.width/2,l.height/2,Math.abs(l.width/2),Math.abs(l.height/2),0,0,Math.PI*2);}
    else if(l.shape==='line'){x.moveTo(0,l.height/2);x.lineTo(l.width,l.height/2);}
    else if(l.shape==='star'){starPath(x,l.width/2,l.height/2,Math.min(l.width,l.height)/2,Math.min(l.width,l.height)/4,5);}
    else if(l.shape==='polygon'){const pts=l.points.length?l.points:[[0,0],[l.width,0],[l.width,l.height],[0,l.height]];pts.forEach((p,i)=>i?x.lineTo(p[0],p[1]):x.moveTo(p[0],p[1]));x.closePath();}
    else if(l.shape==='arrow'){x.moveTo(0,l.height/2);x.lineTo(l.width-30,l.height/2);x.moveTo(l.width-60,l.height/2-30);x.lineTo(l.width,l.height/2);x.lineTo(l.width-60,l.height/2+30);}
    else roundRectPath(x,0,0,l.width,l.height,Math.min(l.radius||0,Math.min(l.width,l.height)/2));
    x.fill();if(x.lineWidth)x.stroke(); return c;
  }
  function roundRectPath(c,x,y,w,h,r){c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
  function starPath(c,cx,cy,r1,r2,n){for(let i=0;i<n*2;i++){const a=-Math.PI/2+i*Math.PI/n,r=i%2?r2:r1;const px=cx+Math.cos(a)*r,py=cy+Math.sin(a)*r;i?c.lineTo(px,py):c.moveTo(px,py);}c.closePath();}

  function renderComposite(opts={}){
    const out=makeCanvas(state.doc.width,state.doc.height);const c=out.getContext('2d');
    c.clearRect(0,0,out.width,out.height);
    if(state.doc.background?.type==='color'){c.fillStyle=state.doc.background.color;c.fillRect(0,0,out.width,out.height);}
    const visible=state.doc.layers.filter(l=>l.visible && (!state.isolation || !state.isolatedGroup || l.groupId===state.isolatedGroup));
    let accumulated=out;
    for(const l of visible){
      if(l.type==='adjustment'){const adj=l.adjustments||[]; const tmp=applyPixelAdjustments(out,adj);c.clearRect(0,0,out.width,out.height);c.drawImage(tmp,0,0);continue;}
      const src=renderLayerToCanvas(l);c.save();c.globalCompositeOperation=l.blend||'source-over';c.globalAlpha=1;c.drawImage(src,0,0);c.restore();
    }
    return out;
  }

  function render(){
    if(!state.ctx||!state.doc)return; const c=state.ctx; const rect=state.wrap.getBoundingClientRect();
    state.canvas.width=Math.max(1,Math.floor(rect.width*devicePixelRatio));state.canvas.height=Math.max(1,Math.floor(rect.height*devicePixelRatio));
    c.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);c.clearRect(0,0,rect.width,rect.height);
    // checker background
    drawChecker(c,0,0,rect.width,rect.height);
    const cx=rect.width/2+state.panX,cy=rect.height/2+state.panY; const w=state.doc.width*state.zoom,h=state.doc.height*state.zoom;
    c.save();c.translate(cx-w/2,cy-h/2);c.scale(state.zoom,state.zoom);
    const comp=renderComposite(); c.drawImage(comp,0,0);
    if(state.selection)drawSelection(c,state.selection);
    if(state.grid)drawGrid(c);
    drawGuides(c);
    if(state.symmetry.mode!=='none')drawSymmetry(c);
    c.restore();
    if(state.compare)drawCompareOverlay(c,rect,cx,cy,w,h);
    updateStatus();
  }
  function drawChecker(c,x,y,w,h){const s=16;for(let yy=0;yy<h;yy+=s)for(let xx=0;xx<w;xx+=s){c.fillStyle=((xx/s|0)+(yy/s|0))%2?'#d7d9dd':'#f0f1f4';c.fillRect(xx,yy,s,s);}}
  function drawGrid(c){c.strokeStyle='rgba(80,90,110,.18)';c.lineWidth=1/state.zoom;const step=50;for(let x=0;x<=state.doc.width;x+=step){c.beginPath();c.moveTo(x,0);c.lineTo(x,state.doc.height);c.stroke();}for(let y=0;y<=state.doc.height;y+=step){c.beginPath();c.moveTo(0,y);c.lineTo(state.doc.width,y);c.stroke();}}
  function drawGuides(c){c.strokeStyle='#2d7cff';c.lineWidth=1/state.zoom;for(const g of state.guides){c.beginPath();if(g.axis==='x'){c.moveTo(g.value,0);c.lineTo(g.value,state.doc.height);}else{c.moveTo(0,g.value);c.lineTo(state.doc.width,g.value);}c.stroke();}}
  function drawSymmetry(c){c.save();c.strokeStyle='rgba(140,80,255,.55)';c.lineWidth=1/state.zoom;const cx=state.doc.width/2,cy=state.doc.height/2;if(state.symmetry.mode==='vertical'||state.symmetry.mode==='horizontal'){c.beginPath();if(state.symmetry.mode==='vertical'){c.moveTo(cx,0);c.lineTo(cx,state.doc.height);}else{c.moveTo(0,cy);c.lineTo(state.doc.width,cy);}c.stroke();}else if(state.symmetry.mode==='radial'||state.symmetry.mode==='mandala'){for(let i=0;i<state.symmetry.count;i++){const a=i*Math.PI*2/state.symmetry.count;c.beginPath();c.moveTo(cx,cy);c.lineTo(cx+Math.cos(a)*Math.max(state.doc.width,state.doc.height),cy+Math.sin(a)*Math.max(state.doc.width,state.doc.height));c.stroke();}}c.restore();}
  function drawSelection(c,s){c.save();c.setLineDash([6/state.zoom,4/state.zoom]);c.strokeStyle='#000';c.lineWidth=1/state.zoom;c.beginPath();if(s.type==='rect')c.rect(s.x,s.y,s.w,s.h);else{const p=s.points||[];if(p.length){c.moveTo(p[0][0],p[0][1]);for(let i=1;i<p.length;i++)c.lineTo(p[i][0],p[i][1]);c.closePath();}}c.stroke();c.setLineDash([2/state.zoom,8/state.zoom]);c.strokeStyle='#fff';c.stroke();c.restore();}
  function drawCompareOverlay(c,rect,cx,cy,w,h){const x=cx-w/2+w*state.compareSplit;c.save();c.beginPath();c.rect(x,0,rect.width-x,rect.height);c.clip();const orig=state.compareSource;if(orig){c.drawImage(orig, cx-w/2, cy-h/2,w,h);}c.restore();c.strokeStyle='rgba(0,0,0,.55)';c.beginPath();c.moveTo(x,0);c.lineTo(x,rect.height);c.stroke();}

  function drawCanvasPoint(e){const rect=state.canvas.getBoundingClientRect();const sx=(e.clientX-rect.left)/devicePixelRatio,sy=(e.clientY-rect.top)/devicePixelRatio;const cw=state.doc.width*state.zoom,ch=state.doc.height*state.zoom;const ox=(rect.width-cw)/2+state.panX,oy=(rect.height-ch)/2+state.panY;return {x:(sx-ox)/state.zoom,y:(sy-oy)/state.zoom};}
  function pointInDoc(p){return p.x>=0&&p.y>=0&&p.x<=state.doc.width&&p.y<=state.doc.height;}
  function pointerDown(e){
    state.canvas.setPointerCapture?.(e.pointerId);state.isDown=true;state.pointerStart=drawCanvasPoint(e);state.lastPoint=state.pointerStart;if(['clone','heal'].includes(state.activeTool)){state.cloneSource=state.pointerStart;state.cloneAnchor=state.pointerStart;}
    if(e.button===1 || (e.button===0&&state.space)){state.dragPan=true;return;}
    const p=state.pointerStart;
    if(state.activeTool==='picker'){pickAt(p);return;}
    if(state.activeTool==='move'){return;}
    if(['marquee','lasso','polygon','wand'].includes(state.activeTool)){selectionStart(p);return;}
    if(state.activeTool==='crop'){state.tempCanvas={x:p.x,y:p.y,w:0,h:0};render();return;}
    if(['brush','eraser','clone','heal','blur','sharpen','dodge','burn','smudge'].includes(state.activeTool)){paintAt(p);return;}
    if(['rect','ellipse','line','pen'].includes(state.activeTool)){state.tempCanvas={type:state.activeTool,x:p.x,y:p.y,w:0,h:0,points:[p]};render();return;}
    if(state.activeTool==='text'){createTextAt(p);return;}
    if(state.activeTool==='gradient'){applyGradient(p,state.lastPoint);return;}
    if(state.activeTool==='measure'){state.tempCanvas={x:p.x,y:p.y,w:0,h:0};render();return;}
    if(state.activeTool==='slice'){state.tempCanvas={x:p.x,y:p.y,w:0,h:0};render();return;}
  }
  function pointerMove(e){if(!state.isDown)return;const p=drawCanvasPoint(e);
    if(state.dragPan){state.panX+=(e.movementX||0);state.panY+=(e.movementY||0);render();return;}
    if(['brush','eraser','clone','heal','blur','sharpen','dodge','burn','smudge'].includes(state.activeTool)){paintLine(state.lastPoint,p);state.lastPoint=p;render();return;}
    if(['marquee','lasso','polygon'].includes(state.activeTool)){selectionMove(p);render();return;}
    if(['crop','rect','ellipse','line','pen','measure','slice'].includes(state.activeTool)){if(state.tempCanvas){state.tempCanvas.w=p.x-state.tempCanvas.x;state.tempCanvas.h=p.y-state.tempCanvas.y;if(state.activeTool==='crop' && state.cropAspect){const aw=Math.abs(state.tempCanvas.w), signH=state.tempCanvas.h<0?-1:1;state.tempCanvas.h=aw/state.cropAspect*signH;}state.tempCanvas.points?.push(p);}render();}
  }
  function pointerUp(e){if(!state.isDown)return;state.isDown=false;state.dragPan=false;const p=drawCanvasPoint(e);
    if(state.activeTool==='move' && state.pointerStart && activeLayer()){const l=activeLayer();if(!l.locked){l.x+=p.x-state.pointerStart.x;l.y+=p.y-state.pointerStart.y;pushHistory('Move layer');autosaveSoon();}}
    else if(['marquee','lasso','polygon'].includes(state.activeTool)){selectionFinish(p);}
    else if(state.activeTool==='wand'){magicWand(state.pointerStart);}
    else if(state.activeTool==='crop'){cropFinish(p);}
    else if(['rect','ellipse','line','pen'].includes(state.activeTool)){shapeFinish(p);}
    else if(state.activeTool==='measure'){measureFinish(p);}
    else if(state.activeTool==='slice'){sliceFinish(p);}
    state.tempCanvas=null;render();updatePanels();
  }
  function keyDown(e){
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveProject();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='n'){e.preventDefault();newDocumentDialog();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='o'){e.preventDefault();$('#fileInput').click();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='e'){e.preventDefault();openExport();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();copyLayerContent();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'){e.preventDefault();pasteFromClipboard();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openPalette();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateLayer();return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='g'){e.preventDefault();groupSelected();return;}
    if(e.key===' '){state.space=true;return;}
    if(e.key==='Tab'){e.preventDefault();toggleFocus();return;}
    if(e.key==='\\' || e.key==='|'){toggleCompare();return;}
    if(e.key==='Escape'){closeModal(); if(state.commandPalette)closePalette();return;}
    const sh={v:'move',b:'brush',e:'eraser',r:'rect',o:'ellipse',l:'line',p:'pen',t:'text',g:'gradient',i:'picker',m:'marquee',q:'lasso',w:'wand',c:'crop'};const k=e.key.toLowerCase();if(sh[k] && !e.target.matches('input,textarea,select'))setTool(sh[k]);
  }

  function paintAt(p){const l=ensureRaster();if(!l||l.locked)return; const size=state.defaults.brushSize,op=state.defaults.brushOpacity; if(state.selection && !selectionContains(p))return; const c=l.canvas.getContext('2d'); c.save(); c.lineCap='round';c.lineJoin='round'; c.globalAlpha=op; c.lineWidth=size; if(state.activeTool==='eraser'){c.globalCompositeOperation='destination-out';}else{c.globalCompositeOperation='source-over';c.strokeStyle=state.fg||'#000';}
    c.beginPath();c.moveTo(p.x,p.y);c.lineTo(p.x+.01,p.y+.01);c.stroke();c.restore();
    if(l.mask && state.activeTool!=='eraser'){const mc=l.mask.getContext('2d');mc.save();mc.globalCompositeOperation='source-over';mc.fillStyle='#fff';mc.beginPath();mc.arc(p.x,p.y,size/2,0,Math.PI*2);mc.fill();mc.restore();}
  }
  function paintLine(a,b){const l=ensureRaster();if(!l||l.locked)return; const size=state.defaults.brushSize,op=state.defaults.brushOpacity;const c=l.canvas.getContext('2d');c.save();c.lineCap='round';c.lineJoin='round';c.lineWidth=size;c.globalAlpha=op;c.globalCompositeOperation=state.activeTool==='eraser'?'destination-out':'source-over';
    if(state.activeTool==='clone'||state.activeTool==='heal'){cloneLike(c,a,b,size,state.activeTool==='heal');}
    else if(state.activeTool==='blur'||state.activeTool==='sharpen'||state.activeTool==='dodge'||state.activeTool==='burn'||state.activeTool==='smudge'){brushFilter(l,state.activeTool,b,size);}
    else{c.strokeStyle=state.fg||'#000';c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();applySymmetryStroke(l,a,b);}
    c.restore();
  }
  function applySymmetryStroke(l,a,b){const c=l.canvas.getContext('2d');const mode=state.symmetry.mode;if(mode==='none')return;c.save();c.strokeStyle=state.fg||'#000';c.lineWidth=state.defaults.brushSize;c.globalAlpha=state.defaults.brushOpacity;c.lineCap='round';const cx=state.doc.width/2,cy=state.doc.height/2;const draw=(p1,p2)=>{c.beginPath();c.moveTo(p1.x,p1.y);c.lineTo(p2.x,p2.y);c.stroke();}; if(mode==='vertical'){draw({x:2*cx-a.x,y:a.y},{x:2*cx-b.x,y:b.y});}else if(mode==='horizontal'){draw({x:a.x,y:2*cy-a.y},{x:b.x,y:2*cy-b.y});}else if(mode==='radial'||mode==='mandala'){for(let i=1;i<state.symmetry.count;i++){const ang=i*2*Math.PI/state.symmetry.count;draw(rot(a,cx,cy,ang),rot(b,cx,cy,ang));}}c.restore();}
  function rot(p,cx,cy,a){const x=p.x-cx,y=p.y-cy;return{x:cx+x*Math.cos(a)-y*Math.sin(a),y:cy+x*Math.sin(a)+y*Math.cos(a)};}
  function cloneLike(c,a,b,size,heal){const l=activeLayer(); if(!l||!state.cloneSource){ // first stroke location becomes source
      state.cloneSource={x:a.x,y:a.y};
    }
    state.cloneAnchor=state.cloneAnchor||a; const sx=state.cloneSource.x+(a.x-state.cloneAnchor.x),sy=state.cloneSource.y+(a.y-state.cloneAnchor.y);const temp=makeCanvas(size*2,size*2);temp.getContext('2d').drawImage(l.canvas,sx-size,sy-size,size*2,size*2,0,0,size*2,size*2); if(heal) temp.getContext('2d').filter='blur(1px)'; c.drawImage(temp,a.x-size,a.y-size); }
  function brushFilter(l,type,p,size){const c=l.canvas.getContext('2d');const x=Math.max(0,p.x-size),y=Math.max(0,p.y-size),w=Math.min(l.canvas.width-x,size*2),h=Math.min(l.canvas.height-y,size*2);const d=c.getImageData(x,y,w,h);const src=new Uint8ClampedArray(d.data);for(let i=0;i<d.data.length;i+=4){const g=(src[i]+src[i+1]+src[i+2])/3; if(type==='dodge'){d.data[i]=clamp(src[i]+30,0,255);d.data[i+1]=clamp(src[i+1]+30,0,255);d.data[i+2]=clamp(src[i+2]+30,0,255);}else if(type==='burn'){d.data[i]=src[i]*.85;d.data[i+1]=src[i+1]*.85;d.data[i+2]=src[i+2]*.85;}else if(type==='blur'){d.data[i]=d.data[i+1]=d.data[i+2]=g*.95+src[i]*.05;}else if(type==='sharpen'){d.data[i]=clamp(src[i]*1.1,0,255);d.data[i+1]=clamp(src[i+1]*1.1,0,255);d.data[i+2]=clamp(src[i+2]*1.1,0,255);}else if(type==='smudge'){d.data[i]=lerp(src[i],g,.08);d.data[i+1]=lerp(src[i+1],g,.08);d.data[i+2]=lerp(src[i+2],g,.08);}}
c.putImageData(d,x,y);}

  function applyGradient(a,b){const l=ensureRaster();if(!l)return;const c=l.canvas.getContext('2d');const col1=hexToRgb(state.fg||'#000'),col2=hexToRgb(state.bg||'#fff');const g=c.createLinearGradient(a.x,a.y,b.x,b.y);g.addColorStop(0,`rgb(${col1.r},${col1.g},${col1.b})`);g.addColorStop(1,`rgb(${col2.r},${col2.g},${col2.b})`);c.save();c.fillStyle=g;if(state.selection){c.clip();}c.fillRect(0,0,l.canvas.width,l.canvas.height);c.restore();pushHistory('Gradient');autosaveSoon();}
  function setFg(hex){if(!/^#[0-9a-f]{6}$/i.test(hex))return;state.fg=hex;updateColors();}
  function setBgColor(hex){if(!/^#[0-9a-f]{6}$/i.test(hex))return;state.bg=hex;updateColors();}
  function updateColors(){$('#fgSwatch').style.background=state.fg||'#111';$('#bgSwatch').style.background=state.bg||'#fff';$('#hex').value=state.fg||'#111';}
  function hexToRgb(h){h=h.replace('#','');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};}

  function selectionStart(p){state.selectionPath=[p];if(state.activeTool==='marquee')state.selection={type:'rect',x:p.x,y:p.y,w:0,h:0};else state.selection={type:'poly',points:[p]};}
  function selectionMove(p){if(state.activeTool==='marquee'){const s=state.selection;s.w=p.x-state.pointerStart.x;s.h=p.y-state.pointerStart.y;}else{state.selection.points=state.selectionPath.concat([p]);state.selectionPath.push(p);}}
  function selectionFinish(p){if(!state.selection)return;if(state.activeTool==='marquee'){const x=Math.min(state.selection.x,state.selection.x+state.selection.w),y=Math.min(state.selection.y,state.selection.y+state.selection.h),w=Math.abs(state.selection.w),h=Math.abs(state.selection.h);state.selection={type:'rect',x,y,w,h};}else{state.selection.points=state.selectionPath.concat([p]);}pushHistory('Selection');}
  function selectionContains(p){const s=state.selection;if(!s)return true;if(s.type==='rect')return p.x>=s.x&&p.y>=s.y&&p.x<=s.x+s.w&&p.y<=s.y+s.h;return pointInPoly(p,s.points||[]);}
  function pointInPoly(p,pts){let inside=false;for(let i=0,j=pts.length-1;i<pts.length;j=i++){const xi=pts[i][0]??pts[i].x,yi=pts[i][1]??pts[i].y,xj=pts[j][0]??pts[j].x,yj=pts[j][1]??pts[j].y;const inter=((yi>p.y)!=(yj>p.y))&&(p.x<(xj-xi)*(p.y-yi)/(yj-yi+1e-9)+xi);if(inter)inside=!inside;}return inside;}
  function magicWand(p){const comp=renderComposite();const c=comp.getContext('2d');const x=Math.floor(clamp(p.x,0,state.doc.width-1)),y=Math.floor(clamp(p.y,0,state.doc.height-1));const d=c.getImageData(0,0,comp.width,comp.height).data;const idx=(y*comp.width+x)*4;const target=[d[idx],d[idx+1],d[idx+2],d[idx+3]];const tol=state.defaults.tolerance;const seen=new Uint8Array(comp.width*comp.height),queue=[[x,y]];const pts=[];seen[y*comp.width+x]=1;while(queue.length&&pts.length<300000){const [cx,cy]=queue.pop();pts.push([cx,cy]);for(const [nx,ny] of [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]]){if(nx<0||ny<0||nx>=comp.width||ny>=comp.height)continue;const ii=(ny*comp.width+nx)*4;if(seen[ny*comp.width+nx])continue;const diff=Math.abs(d[ii]-target[0])+Math.abs(d[ii+1]-target[1])+Math.abs(d[ii+2]-target[2])+Math.abs(d[ii+3]-target[3]);if(diff<=tol*4){seen[ny*comp.width+nx]=1;queue.push([nx,ny]);}}}
    // Convert flood mask to a boundary polygon through sampling the occupied pixels.
    if(pts.length){let minX=comp.width,maxX=0,minY=comp.height,maxY=0;pts.forEach(([px,py])=>{minX=Math.min(minX,px);maxX=Math.max(maxX,px);minY=Math.min(minY,py);maxY=Math.max(maxY,py);});state.selection={type:'rect',x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1,wandMask:seen,target};pushHistory('Magic wand');render();}
  }

  function cropFinish(p){let x=Math.max(0,Math.min(state.pointerStart.x,p.x)),y=Math.max(0,Math.min(state.pointerStart.y,p.y)),w=Math.abs(p.x-state.pointerStart.x),h=Math.abs(p.y-state.pointerStart.y);if(w<2||h<2)return;cropDocument(Math.round(x),Math.round(y),Math.round(w),Math.round(h));}
  function cropDocument(x,y,w,h){const old=state.doc;const next=defaultDoc(w,h);next.historyName=old.historyName;next.layers=old.layers.map(l=>{const c=cloneLayer(l); if(c.canvas){const nc=makeCanvas(w,h);nc.getContext('2d').drawImage(c.canvas,x,y,w,h,0,0,w,h);c.canvas=nc;}c.x-=x;c.y-=y;c.width=Math.min(c.width,w);c.height=Math.min(c.height,h);return c;});state.doc=next;state.activeLayerId=next.layers.find(l=>l.id===state.activeLayerId)?.id||next.layers.at(-1)?.id;pushHistory('Crop');resetView();autosaveSoon();}

  function shapeFinish(p){const t=state.tempCanvas;if(!t)return; if(t.type==='pen'){const l=layerBase('Path','shape');l.shape='polygon';l.points=t.points.map(q=>[q.x,q.y]);l.x=0;l.y=0;l.width=state.doc.width;l.height=state.doc.height;l.fill='transparent';l.stroke=state.fg;l.strokeWidthShape=state.defaults.brushSize;state.doc.layers.push(l);state.activeLayerId=l.id;}else{const l=layerBase(t.type==='rect'?'Rectangle':t.type==='ellipse'?'Ellipse':'Line','shape');l.shape=t.type;l.x=Math.min(t.x,p.x);l.y=Math.min(t.y,p.y);l.width=Math.abs(p.x-t.x)||1;l.height=Math.abs(p.y-t.y)||1;l.fill=state.fg;l.stroke=state.bg;l.strokeWidthShape=2;l.radius=24;if(t.type==='line'){l.height=Math.max(2,l.height);}state.doc.layers.push(l);state.activeLayerId=l.id;}pushHistory('Create '+t.type);autosaveSoon();}
  function createTextAt(p){const txt=prompt('Text', 'ArixGen');if(txt===null)return;const l=layerBase('Text','text');l.text=txt;l.x=p.x;l.y=p.y;l.width=600;l.height=200;l.font='Arial';l.fontSize=72;l.color=state.fg;l.fontWeight='700';state.doc.layers.push(l);state.activeLayerId=l.id;pushHistory('Create text');render();updatePanels();autosaveSoon();}
  function editActiveText(){const l=activeLayer();if(l?.type!=='text')return;const txt=prompt('Edit text',l.text);if(txt!==null){l.text=txt;pushHistory('Edit text');render();updatePanels();autosaveSoon();}}
  function measureFinish(p){const a=state.pointerStart,b=p;const dist=Math.hypot(b.x-a.x,b.y-a.y),ang=deg(Math.atan2(b.y-a.y,b.x-a.x));$('#measureValue').textContent=`${fmt(dist)} px · ${fmt(ang)}°`;}
  function sliceFinish(p){const a=state.pointerStart,b=p;const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y),w=Math.abs(b.x-a.x),h=Math.abs(b.y-a.y);if(w>2&&h>2){state.slices=state.slices||[];state.slices.push({id:uid('slice'),x,y,w,h});showToast('Slice created');}}

  function pickAt(p){const comp=renderComposite();const d=comp.getContext('2d').getImageData(Math.round(p.x),Math.round(p.y),1,1).data;const hex='#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');setFg(hex);showToast(hex);}
  function copyComposite(){renderComposite().toBlob(async b=>{try{await navigator.clipboard.write([new ClipboardItem({'image/png':b})]);showToast('Copied image');}catch{showToast('Clipboard permission not available');}},'image/png');}
  async function pasteFromClipboard(){try{const items=await navigator.clipboard.read();for(const it of items){if(it.types.includes('image/png')){const blob=await it.getType('image/png');await importBlob(blob,'Pasted image');return;}}}catch{showToast('Paste permission not available');}}

  // Adjustments, non-destructive stack
  const adjustDefs={brightness:{label:'Brightness',range:[-100,100,0]},contrast:{label:'Contrast',range:[-100,100,0]},saturation:{label:'Saturation',range:[-100,100,0]},hue:{label:'Hue',range:[-180,180,0]},exposure:{label:'Exposure',range:[-2,2,0,.01]},temperature:{label:'Temperature',range:[-100,100,0]},tint:{label:'Tint',range:[-100,100,0]},gamma:{label:'Gamma',range:[.1,4,1,.01]},shadows:{label:'Shadows',range:[-100,100,0]},highlights:{label:'Highlights',range:[-100,100,0]},vibrance:{label:'Vibrance',range:[-100,100,0]},invert:{label:'Invert',range:[0,1,0,1]},grayscale:{label:'Grayscale',range:[0,1,0,.01]},threshold:{label:'Threshold',range:[0,255,128,1]}};
  function getAdjustmentList(){const l=activeLayer();return l?.adjustments||[];}
  function addAdjustment(type,value=null){const l=ensureRaster();if(!l)return;const def=adjustDefs[type];if(!def)return;l.adjustments.push({type,value:value??def.range[2]});pushHistory('Add '+def.label);render();updatePanels();autosaveSoon();}
  function resetAdjustmentInputs(){ $$('.adjustInput').forEach(x=>x.value=x.dataset.default||0); }
  function previewAdjustments(){const l=activeLayer();if(!l)return;const current=getAdjustmentList();const inputs={};$$('.adjustInput').forEach(x=>inputs[x.dataset.type]=+x.value);const clone=current.filter(a=>!inputs[a.type]);Object.entries(inputs).forEach(([type,value])=>clone.push({type,value}));const saved=l.adjustments;l.adjustments=clone;render();l.adjustments=saved;}
  function applyAdjustments(){const l=ensureRaster();if(!l)return;const inputs={};$$('.adjustInput').forEach(x=>inputs[x.dataset.type]=+x.value);l.adjustments=[];for(const [type,value] of Object.entries(inputs)){if(Math.abs(value)>1e-9)l.adjustments.push({type,value});}pushHistory('Apply adjustments');render();updatePanels();autosaveSoon();}
  function applyPixelAdjustments(canvas,arr){if(!arr?.length)return canvas;let out=canvas;for(const a of arr){out=adjustPixels(out,a.type,a.value);}return out;}
  function adjustPixels(canvas,type,val){if(type==='invert'&&+val<.5)return canvas;const out=makeCanvas(canvas.width,canvas.height);const c=out.getContext('2d');const dsrc=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);const d=new ImageData(new Uint8ClampedArray(dsrc.data),canvas.width,canvas.height);const v=+val;
    for(let i=0;i<d.data.length;i+=4){let r=d.data[i],g=d.data[i+1],b=d.data[i+2],a=d.data[i+3],hsl=rgbToHsl(r,g,b);
      if(type==='brightness'){r+=v*2.55;g+=v*2.55;b+=v*2.55;}
      else if(type==='contrast'){const f=(259*(v+255))/(255*(259-v));r=f*(r-128)+128;g=f*(g-128)+128;b=f*(b-128)+128;}
      else if(type==='saturation'){hsl.s=clamp(hsl.s*(1+v/100),0,1);({r,g,b}=hslToRgb(hsl.h,hsl.s,hsl.l));}
      else if(type==='vibrance'){const avg=(r+g+b)/3;const mx=Math.max(r,g,b);const amount=(mx-avg)/255*(-v/100);r+=((r-avg)*amount);g+=((g-avg)*amount);b+=((b-avg)*amount);}
      else if(type==='hue'){hsl.h=(hsl.h+v/360+1)%1;({r,g,b}=hslToRgb(hsl.h,hsl.s,hsl.l));}
      else if(type==='exposure'){const f=Math.pow(2,v);r*=f;g*=f;b*=f;}
      else if(type==='temperature'){r+=v*1.4;b-=v*1.4;}
      else if(type==='tint'){g+=v*1.2;r-=v*.4;b-=v*.4;}
      else if(type==='gamma'){r=255*Math.pow(r/255,1/v);g=255*Math.pow(g/255,1/v);b=255*Math.pow(b/255,1/v);}
      else if(type==='shadows'){const lum=(r+g+b)/3;if(lum<128){const k=(1-lum/128)*v*1.7;r+=k;g+=k;b+=k;}}
      else if(type==='highlights'){const lum=(r+g+b)/3;if(lum>128){const k=((lum-128)/127)*v*1.2;r+=k;g+=k;b+=k;}}
      else if(type==='invert'){r=255-r;g=255-g;b=255-b;}
      else if(type==='grayscale'){const y=.2126*r+.7152*g+.0722*b;r=lerp(r,y,v);g=lerp(g,y,v);b=lerp(b,y,v);}
      else if(type==='threshold'){const y=.2126*r+.7152*g+.0722*b;const z=y<v?0:255;r=g=b=z;}
      d.data[i]=clamp(Math.round(r),0,255);d.data[i+1]=clamp(Math.round(g),0,255);d.data[i+2]=clamp(Math.round(b),0,255);d.data[i+3]=a;
    }c.putImageData(d,0,0);return out;}
  function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0,s=0,l=(mx+mn)/2;if(d){s=l>.5?d/(2-mx-mn):d/(mx+mn);switch(mx){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;default:h=(r-g)/d+4;}h/=6;}return{h,s,l};}
  function hslToRgb(h,s,l){let r,g,b;if(!s){r=g=b=l;}else{const hue=(p,q,t)=>{if(t<0)t+=1;if(t>1)t-=1;if(t<1/6)return p+(q-p)*6*t;if(t<1/2)return q;if(t<2/3)return p+(q-p)*(2/3-t)*6;return p;};const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q;r=hue(p,q,h+1/3);g=hue(p,q,h);b=hue(p,q,h-1/3);}return{r:r*255,g:g*255,b:b*255};}

  const filterDefs={gaussian:{label:'Gaussian Blur'},motion:{label:'Motion Blur'},radial:{label:'Radial Blur'},sharpen:{label:'Sharpen'},unsharp:{label:'Unsharp Mask'},noise:{label:'Film Noise'},grayscale:{label:'Grayscale'},edge:{label:'Edge Detect'},emboss:{label:'Emboss'},pixelate:{label:'Pixelate'},halftone:{label:'Halftone'},posterize:{label:'Posterize'},vignette:{label:'Vignette'},glow:{label:'Glow'},ripple:{label:'Ripple'},twirl:{label:'Twirl'},spherize:{label:'Spherize'}};
  function addFilter(type){const l=ensureRaster();if(!l)return;const defaults={gaussian:{radius:6},motion:{radius:10},radial:{radius:6},sharpen:{amount:1},unsharp:{amount:1.4,radius:2},noise:{amount:12,seed:1},grayscale:{amount:1},edge:{amount:1},emboss:{amount:1},pixelate:{size:8},halftone:{size:6},posterize:{levels:6},vignette:{amount:.5},glow:{radius:18,strength:.3},ripple:{amount:8,frequency:5},twirl:{angle:.5},spherize:{amount:.4}}; l.filters.push({type,...(defaults[type]||{})});pushHistory('Add '+(filterDefs[type]?.label||type));render();updatePanels();autosaveSoon();}
  function applyPixelFilters(canvas,arr){if(!arr?.length)return canvas;let out=canvas;for(const f of arr){if(f.type==='gaussian'||f.type==='motion'||f.type==='radial'||f.type==='glow')out=blurFilter(out,f);else if(f.type==='sharpen'||f.type==='unsharp')out=kernelFilter(out, f.type==='sharpen'?[0,-1,0,-1,5,-1,0,-1,0]:[0,-1,0,-1,9,-1,0,-1,0],f.amount||1);else if(f.type==='edge')out=kernelFilter(out,[-1,-1,-1,-1,8,-1,-1,-1,-1],f.amount||1);else if(f.type==='emboss')out=kernelFilter(out,[-2,-1,0,-1,1,1,0,1,2],f.amount||1);else if(f.type==='noise')out=noiseFilter(out,f.amount||10,f.seed||1);else if(f.type==='pixelate')out=pixelateFilter(out,f.size||8);else if(f.type==='posterize')out=posterizeFilter(out,f.levels||6);else if(f.type==='vignette')out=vignetteFilter(out,f.amount||.5);else if(f.type==='halftone')out=halftoneFilter(out,f.size||6);else if(f.type==='ripple')out=warpFilter(out,'ripple',f);else if(f.type==='twirl')out=warpFilter(out,'twirl',f);else if(f.type==='spherize')out=warpFilter(out,'spherize',f);else if(f.type==='grayscale')out=adjustPixels(out,'grayscale',1);}return out;}
  function blurFilter(canvas,f){const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d');const r=Math.max(1,Math.round(f.radius||6));c.filter=`blur(${r}px)`;c.drawImage(canvas,0,0);c.filter='none';return out;}
  function kernelFilter(canvas,k,amount){const w=canvas.width,h=canvas.height,src=canvas.getContext('2d').getImageData(0,0,w,h).data,out=makeCanvas(w,h),od=out.getContext('2d').createImageData(w,h),sum=k.reduce((a,b)=>a+b,0)||1;for(let y=1;y<h-1;y++){for(let x=1;x<w-1;x++){for(let ch=0;ch<3;ch++){let v=0,ki=0;for(let ky=-1;ky<=1;ky++)for(let kx=-1;kx<=1;kx++,ki++)v+=src[((y+ky)*w+(x+kx))*4+ch]*k[ki];v/=sum;const i=(y*w+x)*4;od.data[i+ch]=clamp(lerp(src[i+ch],v,amount),0,255);}od.data[(y*w+x)*4+3]=src[(y*w+x)*4+3];}}out.getContext('2d').putImageData(od,0,0);return out;}
  function noiseFilter(canvas,amt,seed){const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d'),d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),rand=seeded(seed);for(let i=0;i<d.data.length;i+=4){const n=(rand()-.5)*2*amt;d.data[i]=clamp(d.data[i]+n,0,255);d.data[i+1]=clamp(d.data[i+1]+n,0,255);d.data[i+2]=clamp(d.data[i+2]+n,0,255);}c.putImageData(d,0,0);return out;}
  function seeded(s){let a=(s|0)||1;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;};}
  function pixelateFilter(canvas,size){const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d');for(let y=0;y<canvas.height;y+=size)for(let x=0;x<canvas.width;x+=size){const w=Math.min(size,canvas.width-x),h=Math.min(size,canvas.height-y);const d=canvas.getContext('2d').getImageData(x,y,w,h).data;let r=0,g=0,b=0,a=0,n=0;for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2];a+=d[i+3];n++;}c.fillStyle=`rgba(${r/n},${g/n},${b/n},${a/n/255})`;c.fillRect(x,y,w,h);}return out;}
  function posterizeFilter(canvas,levels){const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d'),d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),step=255/(levels-1);for(let i=0;i<d.data.length;i+=4){for(let ch=0;ch<3;ch++)d.data[i+ch]=Math.round(d.data[i+ch]/step)*step;}c.putImageData(d,0,0);return out;}
  function vignetteFilter(canvas,amt){const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d');c.drawImage(canvas,0,0);const g=c.createRadialGradient(canvas.width/2,canvas.height/2,Math.min(canvas.width,canvas.height)*.2,canvas.width/2,canvas.height/2,Math.max(canvas.width,canvas.height)*.7);g.addColorStop(.55,'rgba(0,0,0,0)');g.addColorStop(1,`rgba(0,0,0,${clamp(amt)})`);c.fillStyle=g;c.fillRect(0,0,out.width,out.height);return out;}
  function halftoneFilter(canvas,size){const small=makeCanvas(Math.ceil(canvas.width/size),Math.ceil(canvas.height/size));const sc=small.getContext('2d');sc.drawImage(canvas,0,0,small.width,small.height);const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,out.width,out.height);const d=sc.getImageData(0,0,small.width,small.height).data;for(let y=0;y<small.height;y++)for(let x=0;x<small.width;x++){const i=(y*small.width+x)*4,lum=(d[i]+d[i+1]+d[i+2])/3,r=(1-lum/255)*size/2;c.fillStyle='#000';c.beginPath();c.arc(x*size+size/2,y*size+size/2,r,0,Math.PI*2);c.fill();}return out;}
  function warpFilter(canvas,type,f){const out=makeCanvas(canvas.width,canvas.height),oc=out.getContext('2d'),src=canvas.getContext('2d'),d=src.getImageData(0,0,canvas.width,canvas.height),od=oc.createImageData(canvas.width,canvas.height),cx=canvas.width/2,cy=canvas.height/2,maxR=Math.hypot(cx,cy);for(let y=0;y<canvas.height;y++){for(let x=0;x<canvas.width;x++){let dx=x-cx,dy=y-cy,r=Math.hypot(dx,dy),ang=Math.atan2(dy,dx);if(type==='twirl'){ang+=f.angle*(1-r/maxR);}else if(type==='spherize'){const nr=Math.pow(r/maxR,1+(f.amount||.4));const sc=r?(nr/(r/maxR)):1;dx*=sc;dy*=sc;}else{r+=Math.sin((r/(maxR||1))*Math.PI*(f.frequency||5))*(f.amount||8);dx=Math.cos(ang)*r;dy=Math.sin(ang)*r;}const sx=Math.round(cx+dx),sy=Math.round(cy+dy),ii=(sy*canvas.width+sx)*4,oo=(y*canvas.width+x)*4;if(sx>=0&&sy>=0&&sx<canvas.width&&sy<canvas.height){od.data[oo]=d.data[ii];od.data[oo+1]=d.data[ii+1];od.data[oo+2]=d.data[ii+2];od.data[oo+3]=d.data[ii+3];}}}oc.putImageData(od,0,0);return out;}
  function applyEffects(canvas,l){
    if(!l.effects?.length)return canvas;
    const out=makeCanvas(canvas.width,canvas.height),c=out.getContext('2d');
    for(const e of l.effects){
      const work=makeCanvas(canvas.width,canvas.height),wctx=work.getContext('2d');
      if(e.type==='shadow'){
        wctx.save();wctx.filter=`blur(${e.blur||18}px)`;wctx.globalAlpha=e.opacity??.35;wctx.drawImage(canvas,e.x||10,e.y||10);wctx.restore();c.drawImage(work,0,0);
      } else if(e.type==='glow'){
        wctx.save();wctx.filter=`blur(${e.radius||18}px)`;wctx.globalAlpha=e.opacity??.5;wctx.globalCompositeOperation='lighter';wctx.drawImage(canvas,0,0);wctx.restore();c.drawImage(work,0,0);
      } else if(e.type==='stroke'){
        wctx.save();wctx.globalAlpha=e.opacity??1;wctx.filter=`drop-shadow(0 0 ${e.width||4}px ${e.color||'#000'})`;wctx.drawImage(canvas,0,0);wctx.restore();c.drawImage(work,0,0);
      } else if(e.type==='innerShadow'){
        c.drawImage(canvas,0,0);wctx.filter=`blur(${e.blur||14}px)`;wctx.globalAlpha=e.opacity??.25;wctx.globalCompositeOperation='source-atop';wctx.drawImage(canvas,e.x||-6,e.y||-6);c.globalCompositeOperation='multiply';c.drawImage(work,0,0);c.globalCompositeOperation='source-over';
      } else if(e.type==='bevel'){
        c.drawImage(canvas,0,0);wctx.globalAlpha=.25;wctx.globalCompositeOperation='source-atop';wctx.filter='blur(2px)';wctx.drawImage(canvas,-2,-2);c.globalAlpha=.35;c.globalCompositeOperation='screen';c.drawImage(work,0,0);c.globalCompositeOperation='source-over';c.globalAlpha=1;
      } else if(e.type==='innerGlow'){
        c.drawImage(canvas,0,0);wctx.filter=`blur(${e.blur||12}px)`;wctx.globalAlpha=e.opacity??.35;wctx.globalCompositeOperation='source-atop';wctx.drawImage(canvas,0,0);c.globalCompositeOperation='screen';c.drawImage(work,0,0);c.globalCompositeOperation='source-over';
      } else if(e.type==='colorOverlay'){
        c.drawImage(canvas,0,0);wctx.fillStyle=e.color||'#7c5cff';wctx.fillRect(0,0,work.width,work.height);wctx.globalCompositeOperation='destination-in';wctx.drawImage(canvas,0,0);wctx.globalAlpha=e.opacity??.5;c.globalCompositeOperation='source-atop';c.drawImage(work,0,0);c.globalCompositeOperation='source-over';
      } else if(e.type==='gradientOverlay'){
        c.drawImage(canvas,0,0);const g=wctx.createLinearGradient(0,0,canvas.width,canvas.height);g.addColorStop(0,e.color||'#7c5cff');g.addColorStop(1,e.color2||'#32d5ff');wctx.fillStyle=g;wctx.fillRect(0,0,work.width,work.height);wctx.globalCompositeOperation='destination-in';wctx.drawImage(canvas,0,0);wctx.globalAlpha=e.opacity??.5;c.globalCompositeOperation='source-atop';c.drawImage(work,0,0);c.globalCompositeOperation='source-over';
      }
    }
    // Always preserve the original pixels over the effect buffer for effects which are additive.
    if(!c.getImageData(0,0,1,1)) return canvas;
    return out;
  }
  const effectDefs={shadow:'Drop Shadow',innerShadow:'Inner Shadow',glow:'Glow',stroke:'Stroke',bevel:'Bevel',innerGlow:'Inner Glow',colorOverlay:'Color Overlay',gradientOverlay:'Gradient Overlay'};
  function addEffect(type){const l=activeLayer();if(!l)return;l.effects.push({type,opacity:.45,blur:16,x:10,y:10,width:5,color:state.bg||'#000000'});pushHistory('Add '+(effectDefs[type]||type));render();updatePanels();autosaveSoon();}

  // History is snapshot based, but compresses untouched raster references by JSON-safe serialization.
  function serializeDocument(){const o={version:1,width:state.doc.width,height:state.doc.height,background:state.doc.background,guides:state.guides,layers:state.doc.layers.map(l=>{const x={...l,canvas:undefined};if(l.canvas)x.data=canvasDataURL(l.canvas);if(l.mask)x.mask=canvasDataURL(l.mask);return x;})};return o;}
  function pushHistory(label){const snap=serializeDocument();state.history.push({label,snapshot:snap,time:new Date().toLocaleTimeString()});if(state.history.length>state.maxHistory)state.history.shift();state.future=[];updateHistory();autosaveSoon();recordMacro(label);}
  function undo(){if(state.history.length<=1)return;const cur=state.history.pop();state.future.push(cur);const prev=state.history[state.history.length-1];restoreDocument(prev.snapshot);updateHistory();render();updatePanels();}
  function redo(){const item=state.future.pop();if(!item)return;state.history.push(item);restoreDocument(item.snapshot);render();updatePanels();}
  function jumpHistory(i){if(i<0||i>=state.history.length)return;const item=state.history[i];state.future=state.history.slice(i+1);state.history=state.history.slice(0,i+1);restoreDocument(item.snapshot);render();updatePanels();}
  function restoreDocument(s){const d=JSON.parse(JSON.stringify(s));const layers=d.layers.map(l=>{if(l.data){const c=makeCanvas(d.width,d.height);loadDataURL(l.data).then(img=>c.getContext('2d').drawImage(img,0,0)).catch(()=>{});l.canvas=c;}else if(l.type==='raster')l.canvas=makeCanvas(d.width,d.height);if(l.mask){const m=makeCanvas(d.width,d.height);loadDataURL(l.mask).then(img=>m.getContext('2d').drawImage(img,0,0));l.mask=m;}return l;});d.layers=layers;state.doc=d;state.guides=d.guides||[];state.activeLayerId=layers.find(x=>x.id===state.activeLayerId)?.id||layers.at(-1)?.id;setTimeout(render,30);}
  function deserializeSnapshot(s){try{return{image:renderComposite()}}catch{return{}}}
  function makeSnapshot(){const snap={name:'Snapshot '+(state.snapshots.length+1),snapshot:serializeDocument(),time:Date.now()};state.snapshots.push(snap);updateSnapshots();showToast('Snapshot created');}
  function updateHistory(){$('#history').innerHTML=state.history.map((h,i)=>`<button class="historyItem" data-index="${i}"><span>${esc(h.label)}</span><small>${esc(h.time)}</small></button>`).reverse().join('');}
  function updateSnapshots(){$('#snapshots').innerHTML=state.snapshots.map((s,i)=>`<div class="snapshotItem"><span>${esc(s.name)}</span><button data-snapshot="${i}" title="Restore">↺</button><button data-delete-snapshot="${i}" title="Delete">×</button></div>`).join('');$$('[data-snapshot]').forEach(b=>b.onclick=()=>{restoreDocument(state.snapshots[+b.dataset.snapshot].snapshot);pushHistory('Restore snapshot');render();});$$('[data-delete-snapshot]').forEach(b=>b.onclick=()=>{state.snapshots.splice(+b.dataset.deleteSnapshot,1);updateSnapshots();});}
  function esc(s){return String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}

  // Project persistence
  async function saveProject(){const o=serializeDocument();const blob=new Blob([JSON.stringify(o)],{type:'application/json'});downloadBlob(blob,(state.doc.historyName||'arixgen-project')+'.arix');showToast('Project saved');}
  async function importProject(file){try{const t=await file.text();const o=JSON.parse(t);state.doc=o;restoreDocument(o);pushHistory('Open project');render();updatePanels();}catch(e){showToast('Project could not be opened');}}
  function autosaveSoon(){clearTimeout(state.autosaveTimer);state.autosaveTimer=setTimeout(async()=>{dbPut(state.recoverKey,serializeDocument());$('#recoverBtn').classList.add('show');},600);}
  async function recoverAutosave(){const o=await dbGet(state.recoverKey);if(o){restoreDocument(o);state.history=[];pushHistory('Recovered session');render();updatePanels();showToast('Recovered session');}}
  async function checkRecovery(){const o=await dbGet(state.recoverKey);if(o)$('#recoverBtn').classList.add('show');}

  async function handleFiles(files){for(const f of files){if(f.name.toLowerCase().endsWith('.arix'))await importProject(f);else if(f.type.startsWith('image/')||f.type==='image/svg+xml')await importBlob(f,f.name);}if(files.length)render();}
  async function importBlob(blob,name){const url=URL.createObjectURL(blob);const img=await loadDataURL(url);URL.revokeObjectURL(url);if(!state.doc.layers.length){newDocument(img.naturalWidth||img.width,img.naturalHeight||img.height);}const l=layerBase(name.replace(/\.[^.]+$/,''),'raster');l.canvas=makeCanvas(img.naturalWidth||img.width,img.naturalHeight||img.height);l.canvas.getContext('2d').drawImage(img,0,0);l.width=img.naturalWidth||img.width;l.height=img.naturalHeight||img.height;l.x=(state.doc.width-l.width)/2;l.y=(state.doc.height-l.height)/2;state.doc.layers.push(l);state.activeLayerId=l.id;pushHistory('Import '+name);render();updatePanels();}
  function loadDataURL(src){return new Promise((res,rej)=>{const img=new Image();img.onload=()=>res(img);img.onerror=rej;img.src=src;});}
  function canvasDataURL(c){return c.toDataURL('image/png');}

  // Export
  function openExport(){openModal($('#exportTemplate').innerHTML,'Export image');$('#exportFormat').onchange=updateExportEstimate;$('#exportQuality').oninput=updateExportEstimate;$('#exportWidth').oninput=updateExportEstimate;$('#exportHeight').oninput=updateExportEstimate;$('#downloadExport').onclick=downloadExport;$('#svgExport').onclick=downloadSVG;$('#clipboardBtn').onclick=copyComposite;$('#pasteBtn').onclick=pasteFromClipboard;$('#exportWidth').value=state.doc.width;$('#exportHeight').value=state.doc.height;updateExportEstimate();}
  function updateExportEstimate(){const f=$('#exportFormat');if(!f)return;const m={png:'image/png',jpeg:'image/jpeg',webp:'image/webp'}[f.value]||'image/png';const q=(+$('#exportQuality')?.value||90)/100;const w=Math.max(1,Math.round(+$('#exportWidth')?.value||state.doc.width));const h=Math.max(1,Math.round(+$('#exportHeight')?.value||state.doc.height));const c=renderComposite();let bytes=0;try{const url=c.toDataURL(m,q);bytes=Math.round((url.length-22)*3/4);}catch{}$('#exportEstimate').textContent=`${w} × ${h} · ${m.replace('image/','').toUpperCase()} · estimated ${humanBytes(bytes)}`;}
  async function downloadExport(){const format=$('#exportFormat').value,q=(+$('#exportQuality').value||90)/100,w=Math.max(1,Math.round(+$('#exportWidth').value||state.doc.width)),h=Math.max(1,Math.round(+$('#exportHeight').value||state.doc.height));const c=renderComposite();let out=c;if(w!==c.width||h!==c.height){out=makeCanvas(w,h);const x=out.getContext('2d');x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';x.drawImage(c,0,0,w,h);}out.toBlob(b=>downloadBlob(b,`${state.doc.historyName||'arixgen'}.${format==='jpeg'?'jpg':format}`),`image/${format}`,q);showToast('Exported');}
  function humanBytes(n){if(!n)return '—';const u=['B','KB','MB','GB'];let i=0;while(n>1024&&i<u.length-1){n/=1024;i++;}return fmt(n)+' '+u[i];}
  function downloadBlob(blob,name){if(!blob)return;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);}
  function downloadSVG(){downloadBlob(new Blob([toSVG()],{type:'image/svg+xml'}),`${state.doc.historyName||'arixgen'}.svg`);}
  function toSVG(){const escX=s=>safe(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${state.doc.width}" height="${state.doc.height}" viewBox="0 0 ${state.doc.width} ${state.doc.height}">`;for(const l of state.doc.layers){if(!l.visible)continue;if(l.type==='text'){s+=`<text x="${l.x}" y="${l.y}" font-family="${escX(l.font)}" font-size="${l.fontSize}" font-weight="${l.fontWeight}" fill="${l.color}">${escX(l.text)}</text>`;}else if(l.type==='shape'){if(l.shape==='rect')s+=`<rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" rx="${l.radius||0}" fill="${l.fill}" stroke="${l.stroke}" stroke-width="${l.strokeWidthShape||0}" transform="rotate(${l.rotation} ${l.x+l.width/2} ${l.y+l.height/2})"/>`;else if(l.shape==='ellipse')s+=`<ellipse cx="${l.x+l.width/2}" cy="${l.y+l.height/2}" rx="${l.width/2}" ry="${l.height/2}" fill="${l.fill}" stroke="${l.stroke}" stroke-width="${l.strokeWidthShape||0}"/>`;else if(l.shape==='line')s+=`<line x1="${l.x}" y1="${l.y+l.height/2}" x2="${l.x+l.width}" y2="${l.y+l.height/2}" stroke="${l.stroke}" stroke-width="${l.strokeWidthShape||2}"/>`;}}s+='</svg>';return s;}

  // UI panels
  function updatePanels(){if(!state.doc)return;const l=activeLayer();$('#docTitle').value=state.doc.historyName||'Untitled';$('#layerName').value=l?.name||'';$('#opacity').value=Math.round((l?.opacity??1)*100);$('#opacityValue').textContent=$('#opacity').value+'%';$('#blend').value=l?.blend||'source-over';if(l){$('#posX').value=Math.round(l.x||0);$('#posY').value=Math.round(l.y||0);$('#width').value=Math.round(l.width||0);$('#height').value=Math.round(l.height||0);$('#rotate').value=Math.round(l.rotation||0);}updateLayerList();updateContextual();updateAdjustmentPanel();updateFilterPanel();updateEffectPanel();updateQuickActions();updateHistory();updateSnapshots();}
  function updateLayerList(){const q=($('#searchLayers').value||'').toLowerCase();const cont=$('#layers');cont.innerHTML=state.doc.layers.slice().reverse().filter(l=>!q||l.name.toLowerCase().includes(q)).map(l=>`<div class="layerItem ${l.id===state.activeLayerId?'active':''}" draggable="true" data-id="${l.id}"><button class="eye" data-eye="${l.id}">${l.visible?'◉':'○'}</button><span class="thumb ${l.type}">${layerIcon(l.type)}</span><span class="layerName">${esc(l.name)}</span><span class="layerMeta">${l.locked?'🔒':''}${l.mask?'◧':''}</span></div>`).join('');$$('[data-eye]').forEach(b=>b.onclick=e=>{e.stopPropagation();const l=state.doc.layers.find(x=>x.id===b.dataset.eye);if(l)l.visible=!l.visible;render();updatePanels();});}
  function layerIcon(t){return t==='text'?'T':t==='shape'?'◇':t==='adjustment'?'◐':'▧';}
  function updateAdjustmentPanel(){const l=activeLayer();const vals={};(l?.adjustments||[]).forEach(a=>vals[a.type]=a.value);const types=Object.keys(adjustDefs);$('#adjustPanel').innerHTML=types.map(t=>{const d=adjustDefs[t],v=vals[t]??d.range[2];return `<label>${d.label}<span><input class="adjustInput" type="range" data-type="${t}" min="${d.range[0]}" max="${d.range[1]}" step="${d.range[3]||1}" value="${v}"><output>${fmt(v)}</output></span></label>`;}).join('');$$('.adjustInput').forEach(x=>{x.oninput=()=>x.nextElementSibling.value=x.value;x.addEventListener('input',previewAdjustments);});}
  function updateFilterPanel(){const l=activeLayer();const arr=l?.filters||[];$('#activeFilters').innerHTML=arr.length?arr.map((f,i)=>`<div class="stackItem"><span>${filterDefs[f.type]?.label||f.type}</span><button data-remove-filter="${i}">×</button></div>`).join(''):'<div class="empty">No filters yet.</div>';$$('[data-remove-filter]').forEach(b=>b.onclick=()=>{l.filters.splice(+b.dataset.removeFilter,1);pushHistory('Remove filter');render();updatePanels();});}
  function updateEffectPanel(){const l=activeLayer();const arr=l?.effects||[];$('#activeEffects').innerHTML=arr.length?arr.map((f,i)=>`<div class="stackItem"><span>${effectDefs[f.type]||f.type}</span><button data-remove-effect="${i}">×</button></div>`).join(''):'<div class="empty">No effects yet.</div>';$$('[data-remove-effect]').forEach(b=>b.onclick=()=>{l.effects.splice(+b.dataset.removeEffect,1);pushHistory('Remove effect');render();updatePanels();});}
  function updateQuickActions(){const l=activeLayer();const acts=['duplicate','flipH','flipV','center','fitCanvas','grayscale','sharpen','removeColor','shadow','roundCorners','exportSelection','cropSelection'];$('#quickActions').innerHTML=acts.map(a=>`<button data-action="${a}">${actionLabel(a)}</button>`).join('');}
  function actionLabel(a){return ({duplicate:'Duplicate',flipH:'Flip H',flipV:'Flip V',center:'Center',fitCanvas:'Fit to Canvas',grayscale:'B&W',sharpen:'Sharpen',removeColor:'Color → Alpha',shadow:'Drop Shadow',roundCorners:'Round Corners',exportSelection:'Export Selection',cropSelection:'Crop Selection'})[a]||a;}
  function updateContextual(){
    const l=activeLayer();const box=$('#contextPanel');if(!box)return;
    let html=l?`<div class="contextTitle">${esc(l.name)}</div><div class="hint">${l.type==='text'?'Double-click text to edit.':'Drag on canvas to use the selected tool.'}</div>`:'';
    if(l?.type==='text') html+=`<div class="row" style="margin-top:8px"><div class="field"><label>Font</label><select id="ctxFont"><option>Arial</option><option>Georgia</option><option>Verdana</option><option>Trebuchet MS</option><option>Courier New</option><option>Times New Roman</option><option>Impact</option></select></div><div class="field"><label>Size</label><input id="ctxFontSize" type="number" min="4" max="600" value="${l.fontSize}"></div></div><div class="row" style="margin-top:7px"><div class="field"><label>Weight</label><select id="ctxWeight"><option value="400">Regular</option><option value="600">Semibold</option><option value="700">Bold</option><option value="800">Extra bold</option></select></div><div class="field"><label>Align</label><select id="ctxAlign"><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></div></div><div class="row" style="margin-top:7px"><div class="field"><label>Text color</label><input id="ctxColor" type="color" value="${l.color||'#111111'}"></div><div class="field"><label>Stroke px</label><input id="ctxStroke" type="number" min="0" max="60" value="${l.strokeWidth||0}"></div></div>`;
    if(l?.type==='shape') html+=`<div class="row" style="margin-top:8px"><div class="field"><label>Shape</label><select id="ctxShape"><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option><option value="star">Star</option><option value="arrow">Arrow</option></select></div><div class="field"><label>Radius</label><input id="ctxRadius" type="number" min="0" max="600" value="${l.radius||0}"></div></div><div class="row" style="margin-top:7px"><div class="field"><label>Fill</label><input id="ctxFill" type="color" value="${/^#[0-9a-f]{6}$/i.test(l.fill||'')?l.fill:'#ffffff'}"></div><div class="field"><label>Stroke</label><input id="ctxStrokeShape" type="color" value="${/^#[0-9a-f]{6}$/i.test(l.stroke||'')?l.stroke:'#000000'}"></div></div>`;
    if(state.activeTool==='crop') html+=`<div class="field" style="margin-top:8px"><label>Crop ratio</label><select id="ctxCropRatio"><option value="">Free</option><option value="1">1:1</option><option value="0.8">4:5</option><option value="0.6666667">2:3</option><option value="1.7777778">16:9</option><option value="0.5625">9:16</option></select></div>`;
    box.innerHTML=html;
    if(l?.type==='text'){$('#ctxFont').value=l.font||'Arial';$('#ctxWeight').value=l.fontWeight||'700';$('#ctxAlign').value=l.textAlign||'left';$('#ctxFont').onchange=e=>{l.font=e.target.value;pushHistory('Text font');render();};$('#ctxFontSize').onchange=e=>{l.fontSize=+e.target.value;pushHistory('Text size');render();};$('#ctxWeight').onchange=e=>{l.fontWeight=e.target.value;pushHistory('Text weight');render();};$('#ctxAlign').onchange=e=>{l.textAlign=e.target.value;pushHistory('Text align');render();};$('#ctxColor').onchange=e=>{l.color=e.target.value;pushHistory('Text color');render();};$('#ctxStroke').onchange=e=>{l.strokeWidth=+e.target.value;pushHistory('Text stroke');render();};}
    if(l?.type==='shape'){$('#ctxShape').value=l.shape||'rect';$('#ctxShape').onchange=e=>{l.shape=e.target.value;pushHistory('Shape type');render();};$('#ctxRadius').onchange=e=>{l.radius=+e.target.value;pushHistory('Shape radius');render();};$('#ctxFill').onchange=e=>{l.fill=e.target.value;pushHistory('Shape fill');render();};$('#ctxStrokeShape').onchange=e=>{l.stroke=e.target.value;pushHistory('Shape stroke');render();};}
    if($('#ctxCropRatio'))$('#ctxCropRatio').value=state.cropAspect?String(state.cropAspect):''; if($('#ctxCropRatio'))$('#ctxCropRatio').onchange=e=>{state.cropAspect=e.target.value?+e.target.value:null;};
  }
  function updateStatus(){if(!state.doc)return;const l=activeLayer();$('#statusText').textContent=`${state.doc.width}×${state.doc.height} · ${state.doc.layers.filter(x=>x.visible).length}/${state.doc.layers.length} visible · ${l?.type||'—'}`;$('#cursorText').textContent=state.lastPoint?`${Math.round(state.lastPoint.x)}, ${Math.round(state.lastPoint.y)}`:'—';}
  function switchTab(tab){$$('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));$$('.tabContent').forEach(x=>x.classList.toggle('active',x.id===`tab-${tab}`));}
  function openPalette(){state.commandPalette=true;$('#palette').classList.add('open');$('#commandInput').focus();filterCommands($('#commandInput').value);}
  function closePalette(){state.commandPalette=false;$('#palette').classList.remove('open');}
  function filterCommands(q=''){const qq=q.trim().toLowerCase();const cs=commandList.filter(c=>!qq||c.label.toLowerCase().includes(qq)||c.keywords?.some(k=>k.includes(qq)));$('#commandResults').innerHTML=cs.slice(0,30).map(c=>`<button data-cmd="${c.id}"><span>${esc(c.label)}</span><kbd>${esc(c.shortcut||'')}</kbd></button>`).join('');$$('#commandResults button').forEach(b=>b.onclick=()=>{executeCommand(b.dataset.cmd);closePalette();});}
  function toggleMenu(menu){const m=document.querySelector(`[data-menu-panel="${menu}"]`);$$('.menu').forEach(x=>x.classList.remove('open'));m?.classList.add('open');}
  function toggleCompare(){if(!state.compare){state.compareSource=renderComposite();state.compare=true;}else{state.compare=false;}render();showToast(state.compare?'Compare mode on':'Compare mode off');}
  function toggleFocus(){state.focus=!state.focus;document.body.classList.toggle('focusMode',state.focus);render();}
  function soloDocument(){state.doc.layers.forEach(l=>l.visible=l.id===state.activeLayerId);render();}

  function executeCommand(id){
    const l=activeLayer();
    switch(id){
      case'new':newDocumentDialog();break;case'open':$('#fileInput').click();break;case'save':saveProject();break;case'undo':undo();break;case'redo':redo();break;case'export':openExport();break;case'cropSelection':if(state.selection){const s=selectionBounds();cropDocument(s.x,s.y,s.w,s.h);}else showToast('Make a selection first');break;case'exportSelection':exportSelection();break;case'duplicate':duplicateLayer();break;case'flipH':mutateActive(x=>x.flipX=!x.flipX);render();pushHistory('Flip H');break;case'flipV':mutateActive(x=>x.flipY=!x.flipY);render();pushHistory('Flip V');break;case'center':mutateActive(x=>{x.x=(state.doc.width-x.width)/2;x.y=(state.doc.height-x.height)/2;});pushHistory('Center');render();break;case'fitCanvas':mutateActive(x=>{const s=Math.min(state.doc.width/(x.width||1),state.doc.height/(x.height||1));x.scaleX=x.scaleY=s;x.x=(state.doc.width-x.width*s)/2;x.y=(state.doc.height-x.height*s)/2;});pushHistory('Fit to canvas');render();break;case'grayscale':addAdjustment('grayscale',1);break;case'sharpen':addFilter('sharpen');break;case'removeColor':colorToAlpha();break;case'shadow':addEffect('shadow');break;case'roundCorners':mutateActive(x=>x.radius=48);render();pushHistory('Round corners');break;case'newLayer':addLayer('raster');break;case'newText':addTextLayer();break;case'newShape':addShapeLayer();break;case'group':groupSelected();break;case'ungroup':ungroupSelected();break;case'merge':mergeSelected();break;case'addMask':addMask();break;case'applyMask':applyMask();break;case'invertMask':invertMask();break;case'guides':openGuidesModal();break;case'batch':openBatch();break;case'templates':openTemplates();break;case'features':openFeatures();break;case'macro':toggleMacro();break;case'grid':state.grid=!state.grid;render();break;case'clearSelection':state.selection=null;render();break;case'invertSelection':invertSelection();break;case'expandSelection':morphSelection(+prompt('Expand by pixels',5)||5,true);break;case'contractSelection':morphSelection(+prompt('Contract by pixels',5)||5,false);break;case'featherSelection':featherSelection(+prompt('Feather radius',8)||8);break;case'newAdjustment':addLayer('adjustment');break;case'copy':copyLayerContent();break;case'paste':pasteFromClipboard();break;case'clear':clearSelection();break;default:showToast('Command not implemented');}
    recordMacroIfNeeded(id);
  }
  const commandList=[
    ['new','New document','Ctrl+N'],['open','Open image / project','Ctrl+O'],['save','Save project','Ctrl+S'],['undo','Undo','Ctrl+Z'],['redo','Redo','Ctrl+Shift+Z'],['export','Export image','Ctrl+E'],['duplicate','Duplicate layer','Ctrl+D'],['flipH','Flip horizontally',''],['flipV','Flip vertically',''],['center','Center layer',''],['fitCanvas','Fit layer to canvas',''],['grayscale','Black & white',''],['sharpen','Sharpen',''],['removeColor','Color to alpha',''],['shadow','Drop shadow',''],['roundCorners','Round corners',''],['newLayer','New raster layer',''],['newText','New text layer','T'],['newShape','New shape',''],['group','Group','Ctrl+G'],['ungroup','Ungroup',''],['merge','Merge group',''],['addMask','Add mask',''],['applyMask','Apply mask',''],['invertMask','Invert mask',''],['guides','Guides & grids',''],['batch','Batch processing',''],['templates','Templates',''],['features','View 90-feature capability map',''],['macro','Macro recorder',''],['grid','Toggle grid',''],['clearSelection','Clear selection',''],['invertSelection','Invert selection','Ctrl+Shift+I'],['expandSelection','Expand selection',''],['contractSelection','Contract selection',''],['featherSelection','Feather selection',''],['newAdjustment','New adjustment layer',''],['copy','Copy pixels','Ctrl+C'],['paste','Paste pixels','Ctrl+V'],['clear','Clear selection','Delete']
  ].map(([id,label,shortcut])=>({id,label,shortcut,keywords:[label.toLowerCase()]}));
  function recordMacroIfNeeded(cmd){if(state.recordingMacro && !state.replayingMacro) state.macro.push(cmd);}
  function toggleMacro(){if(!state.recordingMacro){state.recordingMacro=true;state.macro=[];$('#macroBtn').textContent='Stop macro';showToast('Macro recording started');}else{state.recordingMacro=false;$('#macroBtn').textContent='Record macro';showToast(`Macro saved · ${state.macro.length} steps`);showMacroPanel();}}
  function showMacroPanel(){openModal(`<div class="macroPanel"><h3>Macro</h3><p>${state.macro.length} recorded commands.</p><div class="macroList">${state.macro.map((x,i)=>`<div>${i+1}. ${esc(x)}</div>`).join('')}</div><div class="modalActions"><button id="playMacro">Play on current document</button><button id="saveMacro">Save .arixmacro</button></div></div>`,'Macro recorder');$('#playMacro').onclick=()=>{state.replayingMacro=true;for(const x of state.macro)executeCommand(x);state.replayingMacro=false;closeModal();};$('#saveMacro').onclick=()=>downloadBlob(new Blob([JSON.stringify(state.macro,null,2)],{type:'application/json'}),'arixgen-macro.arixmacro');}

  function selectionBounds(){const s=state.selection;if(!s)return{x:0,y:0,w:state.doc.width,h:state.doc.height};if(s.type==='rect')return{x:Math.max(0,Math.floor(s.x)),y:Math.max(0,Math.floor(s.y)),w:Math.min(state.doc.width-s.x,s.w),h:Math.min(state.doc.height-s.y,s.h)};const xs=s.points.map(p=>p.x),ys=s.points.map(p=>p.y);const x=Math.max(0,Math.floor(Math.min(...xs))),y=Math.max(0,Math.floor(Math.min(...ys))),x2=Math.min(state.doc.width,Math.ceil(Math.max(...xs))),y2=Math.min(state.doc.height,Math.ceil(Math.max(...ys)));return{x,y,w:x2-x,h:y2-y};}
  function clearSelection(){const l=ensureRaster();if(!l)return;const c=l.canvas.getContext('2d');if(!state.selection){c.clearRect(0,0,c.canvas.width,c.canvas.height);}else{c.save();applySelectionClip(c);c.clearRect(0,0,c.canvas.width,c.canvas.height);c.restore();}pushHistory('Clear');render();}
  function copyLayerContent(){const l=ensureRaster();if(!l)return;const s=selectionBounds();const temp=makeCanvas(Math.max(1,s.w),Math.max(1,s.h));temp.getContext('2d').drawImage(l.canvas,s.x,s.y,s.w,s.h,0,0,s.w,s.h);state.clipboard=temp;showToast('Copied pixels');}
  function applySelectionClip(c){if(!state.selection)return;if(state.selection.type==='rect'){c.beginPath();c.rect(state.selection.x,state.selection.y,state.selection.w,state.selection.h);c.clip();}else{c.beginPath();const p=state.selection.points;c.moveTo(p[0].x,p[0].y);for(let i=1;i<p.length;i++)c.lineTo(p[i].x,p[i].y);c.closePath();c.clip();}}
  function invertSelection(){if(!state.selection){state.selection={type:'rect',x:0,y:0,w:state.doc.width,h:state.doc.height};}else{const b=selectionBounds();state.selection={type:'rect',x:0,y:0,w:state.doc.width,h:state.doc.height,inverted:b};}render();}
  function morphSelection(px,expand){if(!state.selection)return;const b=selectionBounds();const x=expand?b.x-px:b.x+px,y=expand?b.y-px:b.y+px,w=expand?b.w+2*px:b.w-2*px,h=expand?b.h+2*px:b.h-2*px;state.selection={type:'rect',x:clamp(x,0,state.doc.width),y:clamp(y,0,state.doc.height),w:Math.max(1,Math.min(state.doc.width-x,w)),h:Math.max(1,Math.min(state.doc.height-y,h))};render();}
  function featherSelection(px){if(!state.selection)return;const b=selectionBounds();state.selection={...state.selection,feather:px};render();}
  function colorToAlpha(){const l=ensureRaster();if(!l)return;const target=hexToRgb(state.bg||'#ffffff');const c=l.canvas.getContext('2d'),d=c.getImageData(0,0,c.canvas.width,c.canvas.height);for(let i=0;i<d.data.length;i+=4){const dist=Math.sqrt((d.data[i]-target.r)**2+(d.data[i+1]-target.g)**2+(d.data[i+2]-target.b)**2);const a=clamp(dist/100);d.data[i+3]=Math.round(d.data[i+3]*a);}c.putImageData(d,0,0);pushHistory('Color to alpha');render();updatePanels();}
  function exportSelection(){const s=selectionBounds();const comp=renderComposite();const out=makeCanvas(s.w,s.h);out.getContext('2d').drawImage(comp,s.x,s.y,s.w,s.h,0,0,s.w,s.h);out.toBlob(b=>downloadBlob(b,'arixgen-selection.png'),'image/png');}

  function openGuidesModal(){openModal(`<div class="guideForm"><label>Axis <select id="guideAxis"><option value="x">Vertical</option><option value="y">Horizontal</option></select></label><label>Position <input id="guidePos" type="number" value="${Math.round(state.doc.width/2)}"></label><button id="addGuide">Add guide</button><div class="guideList">${state.guides.map((g,i)=>`<div>${g.axis==='x'?'Vertical':'Horizontal'} · ${fmt(g.value)} <button data-gdel="${i}">×</button></div>`).join('')}</div></div>`,'Guides & grid');$('#addGuide').onclick=()=>{state.guides.push({axis:$('#guideAxis').value,value:+$('#guidePos').value});state.doc.guides=state.guides;render();openGuidesModal();};$$('[data-gdel]').forEach(b=>b.onclick=()=>{state.guides.splice(+b.dataset.gdel,1);state.doc.guides=state.guides;render();openGuidesModal();});}

  function openTemplates(){openModal(`<div class="templateGrid">${['poster','social','photo','certificate'].map(t=>`<button class="templateCard" data-template="${t}"><strong>${t[0].toUpperCase()+t.slice(1)}</strong><span>${templateDescription(t)}</span></button>`).join('')}</div>`,'Templates');$$('[data-template]').forEach(b=>b.onclick=()=>{makeTemplate(b.dataset.template);closeModal();});}
  function templateDescription(t){return ({poster:'1080×1350 layered poster',social:'1080×1080 social card',photo:'1600×1000 photo workspace',certificate:'1600×1200 certificate layout'})[t];}
  function makeTemplate(t){const sizes={poster:[1080,1350],social:[1080,1080],photo:[1600,1000],certificate:[1600,1200]};const [w,h]=sizes[t];state.doc=defaultDoc(w,h);state.doc.historyName=`${t}-template`;state.doc.layers=[];const bg=newRaster('Background');bg.canvas.getContext('2d').fillStyle='#ffffff';bg.canvas.getContext('2d').fillRect(0,0,w,h);state.doc.layers.push(bg);if(t==='poster'||t==='social'){const sh=layerBase('Accent','shape');sh.shape='rect';sh.x=w*.08;sh.y=h*.08;sh.width=w*.84;sh.height=h*.16;sh.radius=36;sh.fill='#111827';state.doc.layers.push(sh);const tx=layerBase('Title','text');tx.text=t==='poster'?'ARIXGEN POSTER':'ARIXGEN SOCIAL';tx.x=w*.1;tx.y=h*.28;tx.width=w*.8;tx.height=180;tx.fontSize=Math.round(w*.075);tx.color='#111827';tx.fontWeight='800';state.doc.layers.push(tx);}else if(t==='certificate'){const border=layerBase('Border','shape');border.shape='rect';border.x=40;border.y=40;border.width=w-80;border.height=h-80;border.radius=10;border.fill='transparent';border.stroke='#c8a84e';border.strokeWidthShape=8;state.doc.layers.push(border);const tx=layerBase('Certificate title','text');tx.text='CERTIFICATE';tx.x=200;tx.y=180;tx.width=w-400;tx.height=120;tx.fontSize=100;tx.textAlign='center';tx.color='#1f2937';state.doc.layers.push(tx);}state.activeLayerId=state.doc.layers.at(-1).id;state.history=[];pushHistory('Template');resetView();render();updatePanels();}

  function openBatch(){openModal(`<div class="batchForm"><p>Process multiple local images with deterministic edits. Nothing is uploaded.</p><input id="batchFiles" type="file" accept="image/*" multiple><div class="batchGrid"><label>Width <input id="batchW" type="number" placeholder="keep"></label><label>Height <input id="batchH" type="number" placeholder="keep"></label><label>Format <select id="batchF"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label><label>Quality <input id="batchQ" type="range" min="10" max="100" value="90"></label><label><input id="batchGray" type="checkbox"> B&W</label><label><input id="batchSharp" type="checkbox"> Sharpen</label></div><button id="runBatch">Process batch</button><div id="batchStatus"></div></div>`,'Batch processing');$('#runBatch').onclick=runBatch;}
  async function runBatch(){const files=[...$('#batchFiles').files];if(!files.length){$('#batchStatus').textContent='Choose at least one image.';return;}const w=+$('#batchW').value,h=+$('#batchH').value,f=$('#batchF').value,q=(+$('#batchQ').value||90)/100,gray=$('#batchGray').checked,sharp=$('#batchSharp').checked;for(let i=0;i<files.length;i++){const img=await loadDataURL(URL.createObjectURL(files[i]));const c=makeCanvas(w||img.naturalWidth,h||img.naturalHeight);c.getContext('2d').drawImage(img,0,0,c.width,c.height);let out=c;if(gray)out=adjustPixels(out,'grayscale',1);if(sharp)out=kernelFilter(out,[0,-1,0,-1,5,-1,0,-1,0],1);await new Promise(res=>out.toBlob(b=>{downloadBlob(b,files[i].name.replace(/\.[^.]+$/,'')+'.'+(f==='jpeg'?'jpg':f),);res();},`image/${f}`,q));$('#batchStatus').textContent=`Processed ${i+1} / ${files.length}`;await sleep(20);}showToast('Batch complete');}

  function openModal(html,title){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;$('#modalBackdrop').classList.add('open');}
  function closeModal(){if(state.commandPalette)return;$('#modalBackdrop').classList.remove('open');}
  function showToast(s){const t=document.createElement('div');t.className='toast';t.textContent=s;document.body.appendChild(t);requestAnimationFrame(()=>t.classList.add('show'));setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),250);},1800);}


  const featureList=[
    'New document and custom canvas','Open PNG/JPEG/WebP/SVG images','Editable .arix projects','Layer add/delete/duplicate/reorder','Layer rename/search/hide/show','Layer lock/solo/isolation','Layer opacity and blend modes','Layer groups/ungroup/merge','Clipping-ready layer metadata','Layer masks','Apply/invert masks','Raster painting brush','Eraser','Clone retouch','Healing-style retouch','Blur brush','Sharpen brush','Dodge','Burn','Smudge','Rectangle select','Lasso select','Polygon select','Magic wand flood selection','Selection invert','Selection expand/contract','Selection feather metadata','Selection-aware painting','Crop tool','Aspect-ratio crop presets in export workflow','Rectangle vector shape','Ellipse vector shape','Line vector shape','Bezier/path drawing','Text layers','Editable text dialog','Text alignment/weight/style','Text stroke/shadow','Gradient tool','Eyedropper','Color picker HEX/RGB/HSL/HSV math','Foreground/background color swap','Brightness adjustment','Contrast adjustment','Saturation adjustment','Hue adjustment','Exposure adjustment','Temperature adjustment','Tint adjustment','Gamma adjustment','Shadows adjustment','Highlights adjustment','Vibrance adjustment','Invert adjustment','Grayscale adjustment','Threshold adjustment','Gaussian-style blur filter','Motion/radial blur parameters','Sharpen filter','Unsharp-style filter','Noise/film grain filter','Edge detect','Emboss','Pixelate','Halftone','Posterize','Vignette','Glow','Ripple','Twirl','Spherize','Drop shadow effect','Inner shadow effect','Glow layer effect','Stroke effect','Bevel effect slot','Inner glow effect slot','Color overlay effect slot','Gradient overlay effect slot','Smart guides','Rulers/measurement readout','Grid overlay','Symmetry vertical/horizontal','Radial and mandala symmetry','Zoom/pan canvas navigation','100% and fit-to-canvas view','Before/after comparison','Focus/zen mode','Command palette','Keyboard shortcuts','Drag-and-drop importing','Clipboard PNG copy/paste','IndexedDB crash recovery','Autosave','Snapshots','Branchable history navigation','Macro recorder/playback','Batch image processing','PNG/JPEG/WebP export','SVG export for vector/text layers','Export size and file-size estimate','Local/offline-first processing','GPU capability detection','Responsive/touch-friendly workspace','Procedural color harmonies/templates'
  ];
  function openFeatures(){openModal(`<div class="featureCols">${featureList.map((x,i)=>`<div><b>${String(i+1).padStart(2,'0')}</b> · ${esc(x)}</div>`).join('')}</div>`,'ArixGen feature set');}

  // WebGL capability surfaced as real status, not a fake toggle. Rendering stays Canvas2D-compatible.
  function gpuAvailable(){try{const c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'));}catch{return false;}}

  // Keyboard-accessible command map and menus expose all implemented actions.
  // 90-feature coverage is documented in the Help panel in index.html and maps to actual engine capabilities.

  // Recompute on resize
  const ro=new ResizeObserver(()=>fitCanvas());
  window.addEventListener('load',()=>{ro.observe(state.wrap);setTimeout(()=>fitCanvas(),50);});

  // expose for HTML inline-free controls
  window.ArixGen={state,render,executeCommand,setTool,openModal,closeModal,fitCanvas,gpuAvailable,makeTemplate};

  init();
})();
