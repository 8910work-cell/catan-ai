// ============================================================
//  カタン シミュレーター (標準ルール準拠 / 4人プレイ)
// ============================================================

const HEX_SIZE = 58;
const BOARD_CX = 410;
const BOARD_CY = 390;

const RES = ['wood','brick','wheat','sheep','ore'];
const RES_JP = {wood:'木',brick:'土',wheat:'麦',sheep:'羊',ore:'鉄',desert:'砂漠'};
const TERRAIN_TO_RES = {forest:'wood',hill:'brick',field:'wheat',pasture:'sheep',mountain:'ore'};
const TERRAIN_COLOR = {forest:'#2f6a2f',hill:'#a06a3a',field:'#d4b246',pasture:'#9ed26a',mountain:'#888899',desert:'#e8d39a'};

// 19 hexes (axial coords)
const HEX_COORDS = [
  [0,-2],[1,-2],[2,-2],
  [-1,-1],[0,-1],[1,-1],[2,-1],
  [-2,0],[-1,0],[0,0],[1,0],[2,0],
  [-2,1],[-1,1],[0,1],[1,1],
  [-2,2],[-1,2],[0,2]
];

const TERRAIN_DECK = [
  ...Array(4).fill('forest'),
  ...Array(3).fill('hill'),
  ...Array(4).fill('field'),
  ...Array(4).fill('pasture'),
  ...Array(3).fill('mountain'),
  'desert'
];

const NUMBER_DECK = [2,3,3,4,4,5,5,6,6,8,8,9,9,10,10,11,11,12];

// 9 ports: [q, r, edgeIndex, type]
const PORT_LAYOUT = [
  [0,-2,5,'generic'],
  [1,-2,0,'sheep'],
  [2,-2,0,'generic'],
  [2,-1,1,'ore'],
  [2,0,1,'generic'],
  [1,1,2,'wheat'],
  [-1,2,3,'generic'],
  [-2,2,4,'brick'],
  [-2,0,4,'wood']
];

const DEV_DECK_DEF = [
  ...Array(14).fill('knight'),
  ...Array(5).fill('vp'),
  ...Array(2).fill('road_building'),
  ...Array(2).fill('year_of_plenty'),
  ...Array(2).fill('monopoly')
];
const DEV_JP = {knight:'騎士',vp:'勝利点',road_building:'街道建設',year_of_plenty:'収穫',monopoly:'独占'};

const PLAYER_COLORS = ['#d44','#48a','#fff','#fc4'];
const PLAYER_NAMES = ['あなた','AI青','AI白','AI黄'];

const PIECES_PER_PLAYER = {road:15,settlement:5,city:4};

// ============================================================
//  Geometry helpers
// ============================================================
function hexToPixel(q, r) {
  return {
    x: BOARD_CX + HEX_SIZE * Math.sqrt(3) * (q + r/2),
    y: BOARD_CY + HEX_SIZE * 1.5 * r
  };
}
// vertex i (0..5) of a hex, pointy-top, starting at top, clockwise
function hexCornerPx(cx, cy, i) {
  const angle = Math.PI/2 - i * Math.PI/3;
  return { x: cx + HEX_SIZE * Math.cos(angle), y: cy - HEX_SIZE * Math.sin(angle) };
}
const HEX_DIRS = [[1,-1],[1,0],[0,1],[-1,1],[-1,0],[0,-1]]; // NE,E,SE,SW,W,NW

function key(x, y) { return Math.round(x*10) + ',' + Math.round(y*10); }

// ============================================================
//  Build board graph
// ============================================================
function buildBoard() {
  const hexes = [];
  const vertices = [];
  const edges = [];
  const vMap = new Map();
  const eMap = new Map();

  // shuffle terrain
  const terrainShuffled = shuffle([...TERRAIN_DECK]);
  // numbers in standard "spiral" order to avoid 6/8 adjacency? We'll just shuffle and re-roll if 6/8 adjacent
  let numbers;
  let tries = 0;
  do {
    numbers = shuffle([...NUMBER_DECK]);
    tries++;
  } while (tries < 200 && !validateNumberPlacement(terrainShuffled, numbers));

  let numIdx = 0;
  for (let i=0; i<HEX_COORDS.length; i++) {
    const [q,r] = HEX_COORDS[i];
    const {x,y} = hexToPixel(q,r);
    const type = terrainShuffled[i];
    const hex = {
      id: i, q, r, x, y, type,
      number: type === 'desert' ? null : numbers[numIdx++],
      hasRobber: type === 'desert',
      vertices: [], edges: []
    };
    hexes.push(hex);
  }

  // Build vertices/edges
  for (const hex of hexes) {
    const corners = [];
    for (let i=0; i<6; i++) {
      const p = hexCornerPx(hex.x, hex.y, i);
      const k = key(p.x, p.y);
      let vid = vMap.get(k);
      if (vid === undefined) {
        vid = vertices.length;
        vertices.push({id: vid, x: p.x, y: p.y, port: null, building: null, adjV: new Set(), edges: new Set(), hexes: new Set()});
        vMap.set(k, vid);
      }
      vertices[vid].hexes.add(hex.id);
      corners.push(vid);
    }
    hex.vertices = corners;
    for (let i=0; i<6; i++) {
      const v1 = corners[i], v2 = corners[(i+1)%6];
      const ek = v1 < v2 ? v1 + '-' + v2 : v2 + '-' + v1;
      let eid = eMap.get(ek);
      if (eid === undefined) {
        eid = edges.length;
        edges.push({id: eid, v1, v2, road: null, hexes: new Set()});
        eMap.set(ek, eid);
        vertices[v1].edges.add(eid);
        vertices[v2].edges.add(eid);
        vertices[v1].adjV.add(v2);
        vertices[v2].adjV.add(v1);
      }
      edges[eid].hexes.add(hex.id);
      hex.edges.push(eid);
    }
  }

  // Ports: assign to two vertices of an outward edge
  for (const [q,r,ei,type] of PORT_LAYOUT) {
    const hex = hexes.find(h => h.q===q && h.r===r);
    if (!hex) continue;
    const eid = hex.edges[ei];
    const e = edges[eid];
    vertices[e.v1].port = type;
    vertices[e.v2].port = type;
    e.isPortEdge = true;
    e.portType = type;
  }

  return {hexes, vertices, edges};
}

function validateNumberPlacement(terrain, numbers) {
  // 6/8 should not be adjacent
  let numIdx = 0;
  const hexNumbers = [];
  for (let i=0; i<terrain.length; i++) {
    hexNumbers.push(terrain[i] === 'desert' ? null : numbers[numIdx++]);
  }
  for (let i=0; i<HEX_COORDS.length; i++) {
    if (hexNumbers[i] !== 6 && hexNumbers[i] !== 8) continue;
    const [q,r] = HEX_COORDS[i];
    for (const [dq,dr] of HEX_DIRS) {
      const ni = HEX_COORDS.findIndex(([q2,r2]) => q2===q+dq && r2===r+dr);
      if (ni >= 0 && (hexNumbers[ni] === 6 || hexNumbers[ni] === 8)) return false;
    }
  }
  return true;
}

function shuffle(a) {
  for (let i=a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// ============================================================
//  Game state
// ============================================================
let state;
let canvas, ctx;
let pendingAction = null; // {type: 'road'|'settlement'|'city'|'moveRobber'|...}
let hoverTarget = null;

function newGame() {
  if (typeof nnOnNewGame === 'function') nnOnNewGame();
  const board = buildBoard();
  const players = PLAYER_NAMES.map((name,i) => ({
    id: i, name, color: PLAYER_COLORS[i], isAI: i !== 0,
    resources: {wood:0,brick:0,wheat:0,sheep:0,ore:0},
    devCards: [], // {type, playedThisTurn:bool, boughtTurn:n}
    knightsPlayed: 0,
    settlements: [], cities: [], roads: [],
    hasLongestRoad: false, hasLargestArmy: false,
    longestRoadLen: 0,
    playedDevThisTurn: false,
    vpCardsPlayed: 0, // (we count all hidden VP cards as immediately scored)
  }));

  state = {
    board,
    players,
    currentPlayer: 0,
    turn: 0,
    phase: 'setup1', // setup1, setup2, roll, main, discard, moveRobber, steal, gameover
    dice: [0,0],
    devDeck: shuffle([...DEV_DECK_DEF]),
    setupOrder: [0,1,2,3,3,2,1,0], // snake (placement order indices)
    setupIndex: 0,
    setupSettlement: null, // vertex just placed in current setup step
    longestRoadOwner: null, largestArmyOwner: null,
    log: [],
    pendingDiscards: [], // playerIds who need to discard
    pendingSteal: false,
    roadBuildingRoads: 0,
    winner: null
  };

  logMsg('ゲーム開始！初期配置フェーズです。', 'system');
  logMsg(`${players[state.setupOrder[0]].name} から開拓地を配置します。`, 'important');
}

// ============================================================
//  Logging / UI feedback
// ============================================================
function logMsg(msg, cls='') {
  if (typeof _fastMode !== 'undefined' && _fastMode) return;
  if (typeof _evaluatingNN !== 'undefined' && _evaluatingNN) return;
  state.log.push({msg, cls});
  if (state.log.length > 200) state.log.shift();
  renderLog();
}
function showOverlay(msg, ms=1800) {
  const el = document.getElementById('overlay-msg');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showOverlay._t);
  showOverlay._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ============================================================
//  Rendering
// ============================================================
function render() {
  if (typeof _fastMode !== 'undefined' && _fastMode) return;
  if (!ctx) return;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // Draw all edges (background lines) - skip, only draw built roads
  // Draw hexes
  for (const hex of state.board.hexes) drawHex(hex);
  // Draw port markers (lines from hex edge to port circle)
  for (const v of state.board.vertices) {
    if (v.port) {/* drawn with hex later */}
  }
  drawPorts();
  // Edges
  for (const e of state.board.edges) drawEdge(e);
  // Vertices
  for (const v of state.board.vertices) drawVertex(v);
  // Robber
  for (const hex of state.board.hexes) if (hex.hasRobber) drawRobber(hex);
  // Hover highlight
  if (hoverTarget) drawHover();
  // Hint highlight (analysis.js から設定される最善手ターゲット)
  if (typeof drawHintHighlight === 'function') drawHintHighlight();
}

function drawHex(hex) {
  ctx.beginPath();
  for (let i=0; i<6; i++) {
    const p = hexCornerPx(hex.x, hex.y, i);
    if (i===0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = TERRAIN_COLOR[hex.type];
  ctx.fill();
  ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 2;
  ctx.stroke();

  if (hex.number != null) {
    ctx.beginPath();
    ctx.arc(hex.x, hex.y, 18, 0, Math.PI*2);
    ctx.fillStyle = '#f5e8c8';
    ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = (hex.number === 6 || hex.number === 8) ? '#c22' : '#222';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(hex.number, hex.x, hex.y - 3);
    // probability dots
    const pips = {2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1}[hex.number];
    ctx.fillStyle = (hex.number === 6 || hex.number === 8) ? '#c22' : '#222';
    const dotY = hex.y + 8;
    const dotSpacing = 4;
    for (let i=0; i<pips; i++) {
      ctx.beginPath();
      ctx.arc(hex.x + (i - (pips-1)/2) * dotSpacing, dotY, 1.3, 0, Math.PI*2);
      ctx.fill();
    }
  } else {
    ctx.fillStyle = '#000a';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('砂漠', hex.x, hex.y);
  }
}

function drawPorts() {
  for (const [q,r,ei,type] of PORT_LAYOUT) {
    const hex = state.board.hexes.find(h=>h.q===q&&h.r===r);
    if (!hex) continue;
    const e = state.board.edges[hex.edges[ei]];
    const v1 = state.board.vertices[e.v1];
    const v2 = state.board.vertices[e.v2];
    // port marker offset outward
    const mx = (v1.x + v2.x)/2, my = (v1.y + v2.y)/2;
    const dx = mx - hex.x, dy = my - hex.y;
    const len = Math.hypot(dx,dy);
    const ox = mx + dx/len * 22, oy = my + dy/len * 22;
    // lines
    ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(v1.x, v1.y); ctx.lineTo(ox, oy); ctx.moveTo(v2.x, v2.y); ctx.lineTo(ox, oy); ctx.stroke();
    // circle
    ctx.beginPath(); ctx.arc(ox, oy, 14, 0, Math.PI*2);
    ctx.fillStyle = type === 'generic' ? '#bbb' : '#fee';
    ctx.fill(); ctx.strokeStyle = '#333'; ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const label = type === 'generic' ? '3:1' : '2:1';
    ctx.fillText(label, ox, oy - 3);
    ctx.font = 'bold 9px sans-serif';
    const sub = type === 'generic' ? '?' : RES_JP[type];
    ctx.fillText(sub, ox, oy + 6);
  }
}

function drawEdge(e) {
  if (e.road === null) return;
  const v1 = state.board.vertices[e.v1];
  const v2 = state.board.vertices[e.v2];
  ctx.strokeStyle = PLAYER_COLORS[e.road];
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(v1.x,v1.y); ctx.lineTo(v2.x,v2.y); ctx.stroke();
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
  ctx.stroke();
}

function drawVertex(v) {
  if (!v.building) return;
  if (v.building.type === 'settlement') {
    ctx.beginPath();
    ctx.moveTo(v.x-9, v.y+6);
    ctx.lineTo(v.x-9, v.y-3);
    ctx.lineTo(v.x, v.y-12);
    ctx.lineTo(v.x+9, v.y-3);
    ctx.lineTo(v.x+9, v.y+6);
    ctx.closePath();
    ctx.fillStyle = PLAYER_COLORS[v.building.player];
    ctx.fill(); ctx.strokeStyle='#000'; ctx.lineWidth=1; ctx.stroke();
  } else {
    ctx.fillStyle = PLAYER_COLORS[v.building.player];
    ctx.fillRect(v.x-12, v.y-4, 24, 14);
    ctx.beginPath();
    ctx.moveTo(v.x-12, v.y-4);
    ctx.lineTo(v.x-12, v.y-12);
    ctx.lineTo(v.x-4, v.y-12);
    ctx.lineTo(v.x-4, v.y-18);
    ctx.lineTo(v.x+4, v.y-18);
    ctx.lineTo(v.x+4, v.y-4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle='#000'; ctx.lineWidth=1; ctx.stroke();
    ctx.strokeRect(v.x-12, v.y-4, 24, 14);
  }
}

function drawRobber(hex) {
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(hex.x + 18, hex.y - 18, 9, 0, Math.PI*2);
  ctx.fill();
  ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.stroke();
}

function drawHover() {
  if (hoverTarget.type === 'vertex') {
    const v = state.board.vertices[hoverTarget.id];
    ctx.beginPath();
    ctx.arc(v.x, v.y, 10, 0, Math.PI*2);
    ctx.strokeStyle = '#ff0'; ctx.lineWidth = 2; ctx.stroke();
  } else if (hoverTarget.type === 'edge') {
    const e = state.board.edges[hoverTarget.id];
    const v1 = state.board.vertices[e.v1];
    const v2 = state.board.vertices[e.v2];
    ctx.strokeStyle = '#ff0'; ctx.lineWidth = 9; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(v1.x,v1.y); ctx.lineTo(v2.x,v2.y); ctx.stroke();
  } else if (hoverTarget.type === 'hex') {
    const h = state.board.hexes[hoverTarget.id];
    ctx.beginPath();
    for (let i=0; i<6; i++) {
      const p = hexCornerPx(h.x, h.y, i);
      if (i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#ff0'; ctx.lineWidth = 3; ctx.stroke();
  }
}

// ============================================================
//  UI updating
// ============================================================
function updateUI() {
  if (typeof _fastMode !== 'undefined' && _fastMode) return;
  // Players panel — リッチカード
  const pp = document.getElementById('players-panel');
  pp.innerHTML = '';
  for (const p of state.players) {
    const vp = computeVP(p);
    const visibleVP = p.id === 0 ? vp : vp - countHiddenVP(p); // 相手の隠しVPカードは非表示
    const card = document.createElement('div');
    card.className = 'player-card' + (state.currentPlayer === p.id ? ' active':'');
    card.style.borderLeftColor = p.color;
    const totalRes = RES.reduce((s,r)=>s+p.resources[r],0);
    let badges = '';
    if (p.id === 0) badges += '<span class="badge you">YOU</span>';
    if (p.hasLongestRoad) badges += '<span class="badge lr">最長街道</span>';
    if (p.hasLargestArmy) badges += '<span class="badge la">最大騎士</span>';

    const nameColor = p.color === '#fff' ? '#ddd' : p.color;
    const vpClass = visibleVP >= 8 ? 'player-vp-big win-soon' : 'player-vp-big';
    const barPct = Math.min(100, (visibleVP / 10) * 100);

    card.innerHTML = `
      <div class="row1">
        <span class="player-name" style="color:${nameColor}">${p.name}${badges}</span>
        <div style="text-align:right">
          <div class="${vpClass}">${visibleVP}</div>
          <div class="player-vp-label">/10 VP</div>
        </div>
      </div>
      <div class="vp-bar-wrap"><div class="vp-bar" style="width:${barPct}%"></div></div>
      <div class="player-icons">
        <span class="ico" title="手札">🃏 ${totalRes}</span>
        <span class="ico" title="開拓地">🏠 ${p.settlements.length}</span>
        <span class="ico" title="都市">🏰 ${p.cities.length}</span>
        <span class="ico" title="街道">🛣️ ${p.roads.length}</span>
        <span class="ico" title="発展カード">📜 ${p.devCards.length}</span>
        <span class="ico" title="プレイ済み騎士">⚔️ ${p.knightsPlayed}</span>
      </div>`;
    pp.appendChild(card);
  }

  // ターンバナー (自分の番のみ表示)
  const banner = document.getElementById('turn-banner');
  if (banner) {
    const isMyTurnBanner = state.currentPlayer === 0 && !state.players[0].isAI
      && state.phase !== 'gameover';
    if (isMyTurnBanner && (state.phase === 'roll' || state.phase === 'main'
        || state.phase === 'discard' || state.phase === 'moveRobber' || state.phase === 'steal')) {
      let txt = 'あなたの番';
      if (state.phase === 'roll') txt = '🎲 サイコロを振ってください';
      else if (state.phase === 'main') txt = '⚔️ アクションを選んでください';
      else if (state.phase === 'discard') txt = '⚠️ カードを捨てる';
      else if (state.phase === 'moveRobber') txt = '👤 盗賊を移動';
      else if (state.phase === 'steal') txt = '👤 奪う相手を選ぶ';
      banner.textContent = txt;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }
  }

  // Phase
  const ph = document.getElementById('phase-display');
  const cp = state.players[state.currentPlayer];
  let phText = '';
  if (state.phase === 'setup1') phText = `初期配置1: ${cp.name}が開拓地+街道を配置`;
  else if (state.phase === 'setup2') phText = `初期配置2: ${cp.name}が開拓地+街道を配置`;
  else if (state.phase === 'roll') phText = `${cp.name}のターン - サイコロを振る`;
  else if (state.phase === 'main') phText = `${cp.name}のターン - アクション`;
  else if (state.phase === 'discard') phText = `7の出目！手札を半分捨てる`;
  else if (state.phase === 'moveRobber') phText = `${cp.name}が盗賊を移動`;
  else if (state.phase === 'steal') phText = `${cp.name}がカードを奪う`;
  else if (state.phase === 'gameover') phText = `ゲーム終了！勝者: ${state.winner != null ? state.players[state.winner].name : '-'}`;
  ph.textContent = phText;

  // Dice + sum
  document.getElementById('die1').textContent = state.dice[0] || '-';
  document.getElementById('die2').textContent = state.dice[1] || '-';
  const diceSumEl = document.getElementById('dice-sum');
  if (diceSumEl) {
    const sum = (state.dice[0] || 0) + (state.dice[1] || 0);
    diceSumEl.textContent = sum > 0 ? `合計 ${sum}` : '合計 -';
    diceSumEl.style.color = sum === 7 ? '#f88' : '#ffea7a';
  }

  // Resources (current player view = human always for resources)
  const me = state.players[0];
  const rp = document.getElementById('resources-panel');
  rp.innerHTML = '';
  for (const r of RES) {
    rp.innerHTML += `<div class="resource-tile res-${r}"><div class="label">${RES_JP[r]}</div><div class="count">${me.resources[r]}</div></div>`;
  }

  // Dev cards
  const dp = document.getElementById('devcards-panel');
  dp.innerHTML = '';
  if (me.devCards.length === 0) {
    dp.innerHTML = '<span style="color:#666;font-size:11px">手札なし</span>';
  } else {
    for (let i=0; i<me.devCards.length; i++) {
      const c = me.devCards[i];
      const isNew = c.boughtTurn === state.turn;
      const tooltip = {
        knight: '騎士: 盗賊を移動し、相手のカードを1枚奪う',
        vp: '勝利点: 自動で1VP加算 (常に隠し持つ)',
        road_building: '街道建設: 無料で街道を2本建てる',
        year_of_plenty: '収穫: 好きな資源を2枚得る',
        monopoly: '独占: 全プレイヤーから指定資源を奪う'
      }[c.type] || '';
      dp.innerHTML += `<span class="devcard-item ${isNew?'new':''}" data-idx="${i}" title="${tooltip}${isNew?' (今ターンは使用不可)':''}">${DEV_JP[c.type]}${isNew?'(新)':''}</span>`;
    }
  }
  const dch = document.getElementById('devcards-hint');
  if (dch) dch.style.display = me.devCards.length === 0 ? 'none' : '';

  // Buttons
  const isMyTurn = state.currentPlayer === 0 && !state.players[0].isAI;
  const inMain = isMyTurn && state.phase === 'main';
  document.getElementById('btn-roll').disabled = !(isMyTurn && state.phase === 'roll');
  document.getElementById('btn-build-road').disabled = !inMain || !canAffordRoad(me) || me.roads.length >= PIECES_PER_PLAYER.road;
  document.getElementById('btn-build-settlement').disabled = !inMain || !canAffordSettlement(me) || me.settlements.length >= PIECES_PER_PLAYER.settlement;
  document.getElementById('btn-build-city').disabled = !inMain || !canAffordCity(me) || me.cities.length >= PIECES_PER_PLAYER.city || me.settlements.length === 0;
  document.getElementById('btn-buy-dev').disabled = !inMain || !canAffordDev(me) || state.devDeck.length === 0;
  document.getElementById('btn-trade').disabled = !inMain;
  document.getElementById('btn-play-dev').disabled = !inMain || me.playedDevThisTurn || !me.devCards.some(c => c.type !== 'vp' && c.boughtTurn < state.turn);
  document.getElementById('btn-end-turn').disabled = !inMain;
  document.getElementById('btn-cancel').disabled = !pendingAction;

  renderLog();
  render();
}

function renderLog() {
  const lp = document.getElementById('log-panel');
  lp.innerHTML = state.log.slice(-100).map(e => `<div class="log-entry ${e.cls}">${e.msg}</div>`).join('');
  lp.scrollTop = lp.scrollHeight;
}

function countHiddenVP(p) {
  // For human, show all VP. For AI, hide unplayed VP cards.
  if (p.id === 0) return 0;
  return p.devCards.filter(c => c.type === 'vp').length;
}

// ============================================================
//  Costs / can-afford
// ============================================================
const COSTS = {
  road: {wood:1, brick:1},
  settlement: {wood:1, brick:1, wheat:1, sheep:1},
  city: {wheat:2, ore:3},
  dev: {wheat:1, sheep:1, ore:1}
};
function canAfford(p, cost) { return Object.entries(cost).every(([r,n]) => p.resources[r] >= n); }
function canAffordRoad(p) { return canAfford(p, COSTS.road); }
function canAffordSettlement(p) { return canAfford(p, COSTS.settlement); }
function canAffordCity(p) { return canAfford(p, COSTS.city); }
function canAffordDev(p) { return canAfford(p, COSTS.dev); }
function payCost(p, cost) { for (const [r,n] of Object.entries(cost)) p.resources[r] -= n; }

// ============================================================
//  Building validity
// ============================================================
function isVertexBuildable(vid, playerId, isSetup) {
  const v = state.board.vertices[vid];
  if (v.building) return false;
  // distance rule
  for (const nv of v.adjV) {
    if (state.board.vertices[nv].building) return false;
  }
  if (!isSetup) {
    // must be connected to a road of this player
    const connected = [...v.edges].some(eid => state.board.edges[eid].road === playerId);
    if (!connected) return false;
  }
  return true;
}

function isEdgeBuildable(eid, playerId, allowFromVertex=null) {
  const e = state.board.edges[eid];
  if (e.road !== null) return false;
  // must connect to: a player's existing road, settlement, or city
  // OR for setup, must be adjacent to the just-placed settlement (allowFromVertex)
  if (allowFromVertex != null) {
    return e.v1 === allowFromVertex || e.v2 === allowFromVertex;
  }
  for (const vid of [e.v1, e.v2]) {
    const v = state.board.vertices[vid];
    if (v.building && v.building.player === playerId) return true;
    // road continuation - but blocked if opponent settlement sits on that vertex
    if (v.building && v.building.player !== playerId) continue;
    for (const eid2 of v.edges) {
      if (eid2 !== eid && state.board.edges[eid2].road === playerId) return true;
    }
  }
  return false;
}

// ============================================================
//  Place buildings
// ============================================================
function placeRoad(playerId, eid) {
  state.board.edges[eid].road = playerId;
  state.players[playerId].roads.push(eid);
  updateLongestRoad();
}
function placeSettlement(playerId, vid) {
  state.board.vertices[vid].building = {player: playerId, type:'settlement'};
  state.players[playerId].settlements.push(vid);
  updateLongestRoad(); // may break opponent's longest road
}
function placeCity(playerId, vid) {
  state.board.vertices[vid].building = {player: playerId, type:'city'};
  const p = state.players[playerId];
  p.settlements = p.settlements.filter(x => x !== vid);
  p.cities.push(vid);
}

// ============================================================
//  Setup phase
// ============================================================
function setupStep() {
  // Called when human or AI needs to place next settlement
  // setupOrder = [0,1,2,3,3,2,1,0]; idx 0-3 = setup1, 4-7 = setup2
  if (state.setupIndex >= 8) {
    // Done; start regular play
    state.phase = 'roll';
    state.currentPlayer = 0;
    logMsg('初期配置完了！通常ターン開始。', 'important');
    updateUI();
    return;
  }
  state.currentPlayer = state.setupOrder[state.setupIndex];
  state.phase = state.setupIndex < 4 ? 'setup1' : 'setup2';
  state.setupSettlement = null;
  pendingAction = null;
  updateUI();

  if (state.players[state.currentPlayer].isAI) {
    setTimeout(() => aiSetupTurn(), 400);
  } else {
    pendingAction = {type: 'setup-settlement'};
    showOverlay('開拓地を配置してください');
    updateUI();
  }
}

function setupPlaceSettlement(vid) {
  if (!isVertexBuildable(vid, state.currentPlayer, true)) return false;
  placeSettlement(state.currentPlayer, vid);
  state.setupSettlement = vid;
  const v = state.board.vertices[vid];
  logMsg(`${state.players[state.currentPlayer].name} が開拓地を配置 (${v.port ? '港:' + (v.port==='generic'?'3:1':'2:1 '+RES_JP[v.port]) : ''})`);
  // 2nd setup: give resources
  if (state.phase === 'setup2') {
    const p = state.players[state.currentPlayer];
    const gains = [];
    for (const hid of v.hexes) {
      const hex = state.board.hexes[hid];
      if (hex.type !== 'desert') {
        const r = TERRAIN_TO_RES[hex.type];
        p.resources[r]++;
        gains.push(RES_JP[r]);
      }
    }
    if (gains.length) logMsg(`  → ${p.name}が初期資源を獲得: ${gains.join(',')}`);
  }
  pendingAction = {type: 'setup-road'};
  showOverlay('街道を配置してください');
  updateUI();
  return true;
}

function setupPlaceRoad(eid) {
  if (!isEdgeBuildable(eid, state.currentPlayer, state.setupSettlement)) return false;
  placeRoad(state.currentPlayer, eid);
  logMsg(`${state.players[state.currentPlayer].name} が街道を配置`);
  state.setupIndex++;
  setTimeout(setupStep, 200);
  return true;
}

function aiSetupTurn() {
  const pid = state.currentPlayer;
  // NN フック: 学習済み NN で初期配置を選ぶ
  if (typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer()
      && typeof aiSetupTurnNN === 'function') {
    return aiSetupTurnNN();
  }
  // ヒューリスティック用にサンプル収集 (学習時)
  if (typeof _trainingSamples !== 'undefined' && _trainingSamples !== null &&
      typeof nnExtractFeatures === 'function') {
    _trainingSamples.push({ playerId: pid, features: nnExtractFeatures(pid), turn: 0 });
  }
  // Pick best vertex by resource probability + diversity
  let bestV = -1, bestScore = -Infinity;
  for (let i=0; i<state.board.vertices.length; i++) {
    if (!isVertexBuildable(i, pid, true)) continue;
    const score = evaluateVertex(i, pid);
    if (score > bestScore) { bestScore = score; bestV = i; }
  }
  if (bestV < 0) { state.setupIndex++; setTimeout(setupStep, 100); return; }
  setupPlaceSettlement(bestV);
  // place road adjacent to that vertex - pick one that points toward a good direction (away from edges if possible)
  const v = state.board.vertices[bestV];
  const candidates = [...v.edges];
  let bestE = candidates[0], bestEScore = -Infinity;
  for (const eid of candidates) {
    if (!isEdgeBuildable(eid, pid, bestV)) continue;
    const e = state.board.edges[eid];
    const otherV = e.v1 === bestV ? e.v2 : e.v1;
    const score = evaluateVertex(otherV, pid) - (state.board.vertices[otherV].port ? -2:0);
    if (score > bestEScore) { bestEScore = score; bestE = eid; }
  }
  setTimeout(() => setupPlaceRoad(bestE), 300);
}

const PROB_PIPS = {2:1,3:2,4:3,5:4,6:5,8:5,9:4,10:3,11:2,12:1};

function evaluateVertex(vid, pid) {
  const v = state.board.vertices[vid];
  const p = state.players[pid];
  let score = 0;
  const resScore = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
  for (const hid of v.hexes) {
    const hex = state.board.hexes[hid];
    if (hex.type === 'desert') continue;
    const r = TERRAIN_TO_RES[hex.type];
    const pips = PROB_PIPS[hex.number] || 0;
    resScore[r] += pips;
    score += pips * 2;
  }
  // Diversity bonus
  const distinct = Object.values(resScore).filter(v => v>0).length;
  score += distinct * 3;
  // Port: small bonus if we have resource production for it
  if (v.port === 'generic') score += 2;
  else if (v.port) score += resScore[v.port] > 0 ? 4 : 1;
  // Existing resource synergy (for 2nd settlement)
  for (const r of RES) {
    const cur = p.settlements.concat(p.cities).reduce((s,vv) => {
      const vert = state.board.vertices[vv];
      for (const hid of vert.hexes) {
        const hex = state.board.hexes[hid];
        if (hex.type !== 'desert' && TERRAIN_TO_RES[hex.type] === r) s += PROB_PIPS[hex.number] || 0;
      }
      return s;
    }, 0);
    if (cur === 0 && resScore[r] > 0) score += 3;
  }
  return score;
}

// ============================================================
//  Turn / Dice
// ============================================================
function startTurn() {
  state.phase = 'roll';
  const p = state.players[state.currentPlayer];
  p.playedDevThisTurn = false;
  p._tradesThisTurn = 0; // 1ターンあたりの島内交渉回数をリセット
  // unlock dev cards bought previous turns
  for (const c of p.devCards) if (c.boughtTurn < state.turn) c.canPlay = true;
  logMsg(`--- ${p.name} のターン (${state.turn}) ---`, 'important');
  updateUI();
  if (p.isAI) setTimeout(() => aiRollDice(), 500);
}

function rollDice() {
  if (state.phase !== 'roll') return;
  state.dice = [1 + Math.floor(Math.random()*6), 1 + Math.floor(Math.random()*6)];
  const total = state.dice[0] + state.dice[1];
  logMsg(`${state.players[state.currentPlayer].name} がサイコロを振った: ${state.dice[0]} + ${state.dice[1]} = ${total}`, 'important');
  if (total === 7) {
    handleSeven();
  } else {
    distributeResources(total);
    state.phase = 'main';
    updateUI();
    if (state.players[state.currentPlayer].isAI) setTimeout(aiMainTurn, 600);
  }
}

function distributeResources(roll) {
  const gains = state.players.map(() => ({wood:0,brick:0,wheat:0,sheep:0,ore:0}));
  for (const hex of state.board.hexes) {
    if (hex.number !== roll || hex.hasRobber || hex.type === 'desert') continue;
    const r = TERRAIN_TO_RES[hex.type];
    for (const vid of hex.vertices) {
      const v = state.board.vertices[vid];
      if (!v.building) continue;
      const amt = v.building.type === 'city' ? 2 : 1;
      gains[v.building.player][r] += amt;
    }
  }
  for (let i=0; i<state.players.length; i++) {
    const g = gains[i];
    const total = Object.values(g).reduce((a,b)=>a+b,0);
    if (total === 0) continue;
    for (const r of RES) state.players[i].resources[r] += g[r];
    const parts = RES.filter(r=>g[r]>0).map(r => `${RES_JP[r]}x${g[r]}`).join(', ');
    logMsg(`  ${state.players[i].name}: ${parts}`);
  }
}

// ============================================================
//  7 / Robber
// ============================================================
function handleSeven() {
  // Anyone with 8+ cards discards half (rounded down)
  state.pendingDiscards = [];
  for (const p of state.players) {
    const total = RES.reduce((s,r)=>s+p.resources[r], 0);
    if (total >= 8) {
      state.pendingDiscards.push({playerId: p.id, target: Math.floor(total/2)});
    }
  }
  if (state.pendingDiscards.length > 0) {
    state.phase = 'discard';
    logMsg('7の出目！手札8枚以上のプレイヤーは半分を捨てます。', 'important');
    updateUI();
    processNextDiscard();
  } else {
    proceedToMoveRobber();
  }
}

function processNextDiscard() {
  if (state.pendingDiscards.length === 0) {
    proceedToMoveRobber();
    return;
  }
  const d = state.pendingDiscards[0];
  const p = state.players[d.playerId];
  if (p.isAI) {
    // AI discards: prefer abundant resources
    const cards = [];
    for (const r of RES) for (let i=0; i<p.resources[r]; i++) cards.push(r);
    cards.sort((a,b) => p.resources[b] - p.resources[a]);
    for (let i=0; i<d.target; i++) p.resources[cards[i]]--;
    logMsg(`${p.name} が ${d.target} 枚捨てた`);
    state.pendingDiscards.shift();
    setTimeout(processNextDiscard, 300);
  } else {
    showDiscardModal(d.target);
  }
}

function showDiscardModal(target) {
  const p = state.players[0];
  const picked = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
  const update = () => {
    const total = RES.reduce((s,r)=>s+picked[r],0);
    document.getElementById('modal-content').innerHTML = `
      <div>手札合計 ${RES.reduce((s,r)=>s+p.resources[r],0)}枚のうち <b>${target}枚</b> を捨ててください。</div>
      <div style="margin-top:6px">現在 ${total}/${target} 枚選択中</div>
      <div class="discard-grid">
        ${RES.map(r => `<div class="discard-cell res-${r}">
          <div>${RES_JP[r]}</div>
          <div>${p.resources[r] - picked[r]}/${p.resources[r]}</div>
          <div>選択: ${picked[r]}</div>
          <button data-r="${r}" data-d="-1">−</button>
          <button data-r="${r}" data-d="1">+</button>
        </div>`).join('')}
      </div>`;
    document.getElementById('modal-buttons').innerHTML =
      `<button id="discard-ok" ${total===target?'':'disabled'}>確定</button>`;
    document.getElementById('discard-ok').onclick = () => {
      for (const r of RES) p.resources[r] -= picked[r];
      hideModal();
      logMsg(`あなたが ${target} 枚捨てた`);
      state.pendingDiscards.shift();
      setTimeout(processNextDiscard, 200);
    };
    document.querySelectorAll('.discard-cell button').forEach(b => {
      b.onclick = () => {
        const r = b.dataset.r, d = parseInt(b.dataset.d);
        if (d > 0 && picked[r] < p.resources[r] && total < target) picked[r]++;
        else if (d < 0 && picked[r] > 0) picked[r]--;
        update();
      };
    });
  };
  showModal('カードを捨てる', '', '');
  update();
}

function proceedToMoveRobber() {
  // 強盗処理後にどのフェーズに戻るかを記憶
  // - 騎士事前プレイ → 明示的に 'roll' をセット済み → 振り直しへ
  // - 7の出目 → state.phase は 'roll' (討議なし) または 'discard' だが、振り直しさせず 'main' へ
  if (!state.preRobberPhase) {
    state.preRobberPhase = 'main';
  }
  state.phase = 'moveRobber';
  updateUI();
  const p = state.players[state.currentPlayer];
  if (p.isAI) {
    setTimeout(aiMoveRobber, 500);
  } else {
    pendingAction = {type: 'moveRobber'};
    showOverlay('盗賊を移動させる六角タイルをクリック');
  }
}

function moveRobberTo(hid) {
  const hex = state.board.hexes[hid];
  if (hex.hasRobber) return false; // must move
  for (const h of state.board.hexes) h.hasRobber = false;
  hex.hasRobber = true;
  logMsg(`${state.players[state.currentPlayer].name} が盗賊を ${hex.type} (${hex.number||'-'}) に移動`);
  // find victims (players with building on this hex, excluding current)
  const victims = new Set();
  for (const vid of hex.vertices) {
    const v = state.board.vertices[vid];
    if (v.building && v.building.player !== state.currentPlayer
        && RES.reduce((s,r)=>s+state.players[v.building.player].resources[r],0) > 0) {
      victims.add(v.building.player);
    }
  }
  const victimList = [...victims];
  if (victimList.length === 0) {
    finishRobber();
  } else if (victimList.length === 1) {
    stealFrom(victimList[0]);
    finishRobber();
  } else {
    const p = state.players[state.currentPlayer];
    if (p.isAI) {
      // steal from highest VP victim
      victimList.sort((a,b) => computeVP(state.players[b]) - computeVP(state.players[a]));
      stealFrom(victimList[0]);
      finishRobber();
    } else {
      showStealModal(victimList);
    }
  }
  return true;
}

function stealFrom(victimId) {
  const v = state.players[victimId];
  const cards = [];
  for (const r of RES) for (let i=0; i<v.resources[r]; i++) cards.push(r);
  if (cards.length === 0) return;
  const stolen = cards[Math.floor(Math.random()*cards.length)];
  v.resources[stolen]--;
  state.players[state.currentPlayer].resources[stolen]++;
  logMsg(`${state.players[state.currentPlayer].name} が ${v.name} から1枚奪った` +
    (state.currentPlayer === 0 ? `: ${RES_JP[stolen]}` : ''));
}

function showStealModal(victims) {
  const buttons = victims.map(vid => `<button data-v="${vid}">${state.players[vid].name}</button>`).join('');
  showModal('奪う相手を選んでください', '盗賊を置いたタイルに開拓地/都市があるプレイヤー:', buttons);
  document.querySelectorAll('#modal-buttons button').forEach(b => {
    b.onclick = () => {
      stealFrom(parseInt(b.dataset.v));
      hideModal();
      finishRobber();
    };
  });
}

function finishRobber() {
  // 騎士をサイコロ前に使った場合は'roll'に戻る、7の出目またはダイス後は'main'
  state.phase = state.preRobberPhase === 'roll' ? 'roll' : 'main';
  state.preRobberPhase = null;
  pendingAction = null;
  updateUI();
  if (state.players[state.currentPlayer].isAI) {
    if (state.phase === 'roll') setTimeout(aiRollDice, 500);
    else setTimeout(aiMainTurn, 500);
  }
}

// ============================================================
//  Maritime Trade
// ============================================================
function getTradeRatio(player, resource) {
  // 4:1 default, 3:1 generic port, 2:1 specific port
  let ratio = 4;
  for (const vid of player.settlements.concat(player.cities)) {
    const v = state.board.vertices[vid];
    if (v.port === resource) ratio = Math.min(ratio, 2);
    else if (v.port === 'generic') ratio = Math.min(ratio, 3);
  }
  return ratio;
}

function maritimeTrade(player, give, get) {
  const ratio = getTradeRatio(player, give);
  if (player.resources[give] < ratio) return false;
  player.resources[give] -= ratio;
  player.resources[get]++;
  logMsg(`${player.name}: ${RES_JP[give]}x${ratio} → ${RES_JP[get]}x1 (海上交易)`);
  return true;
}

function showTradeModal() {
  const me = state.players[0];
  let tab = 'maritime';
  const giveCounts = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
  const getCounts = {wood:0,brick:0,wheat:0,sheep:0,ore:0};

  const renderMaritime = () => {
    return '<h4 style="margin:6px 0">海上取引（銀行）</h4>' +
      RES.map(give => {
        const ratio = getTradeRatio(me, give);
        const can = me.resources[give] >= ratio;
        return `<div style="display:flex;align-items:center;gap:4px;margin:3px 0">
          <span class="resource-tile res-${give}" style="padding:3px 8px">${RES_JP[give]} (${me.resources[give]}) ${ratio}:1</span> →
          ${RES.filter(r=>r!==give).map(get => `<button class="mar-btn" data-give="${give}" data-get="${get}" ${can?'':'disabled'}>${RES_JP[get]}</button>`).join(' ')}
        </div>`;
      }).join('');
  };

  const renderPlayer = () => {
    return '<h4 style="margin:6px 0">島内取引（他のプレイヤーへ提案）</h4>' +
      `<div style="margin:6px 0">渡す資源:</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${RES.map(r => `<div class="resource-tile res-${r}" style="padding:3px 6px">
          ${RES_JP[r]} (手持${me.resources[r]})
          <button class="give-btn" data-r="${r}" data-d="-1">−</button>${giveCounts[r]}<button class="give-btn" data-r="${r}" data-d="1">+</button>
        </div>`).join('')}
      </div>
      <div style="margin:6px 0">欲しい資源:</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${RES.map(r => `<div class="resource-tile res-${r}" style="padding:3px 6px">
          ${RES_JP[r]}
          <button class="get-btn" data-r="${r}" data-d="-1">−</button>${getCounts[r]}<button class="get-btn" data-r="${r}" data-d="1">+</button>
        </div>`).join('')}
      </div>
      <div style="margin:8px 0"><button id="propose-all">全員に提案</button>
        ${state.players.filter(p=>p.id!==0).map(p=>`<button class="propose-one" data-pid="${p.id}">${p.name} に提案</button>`).join(' ')}
      </div>`;
  };

  const update = () => {
    const tabs = `<div style="margin-bottom:8px">
      <button id="tab-mar" ${tab==='maritime'?'style="background:#5a7a9a"':''}>海上取引</button>
      <button id="tab-player" ${tab==='player'?'style="background:#5a7a9a"':''}>島内取引</button>
    </div>`;
    document.getElementById('modal-content').innerHTML = tabs + (tab === 'maritime' ? renderMaritime() : renderPlayer());
    document.getElementById('modal-buttons').innerHTML = '<button id="trade-close">閉じる</button>';
    document.getElementById('trade-close').onclick = hideModal;
    document.getElementById('tab-mar').onclick = () => { tab='maritime'; update(); };
    document.getElementById('tab-player').onclick = () => { tab='player'; update(); };
    document.querySelectorAll('.mar-btn').forEach(b => {
      b.onclick = () => {
        if (maritimeTrade(me, b.dataset.give, b.dataset.get)) { update(); updateUI(); }
      };
    });
    document.querySelectorAll('.give-btn').forEach(b => {
      b.onclick = () => {
        const r = b.dataset.r, d = parseInt(b.dataset.d);
        if (d > 0 && giveCounts[r] < me.resources[r]) giveCounts[r]++;
        else if (d < 0 && giveCounts[r] > 0) giveCounts[r]--;
        update();
      };
    });
    document.querySelectorAll('.get-btn').forEach(b => {
      b.onclick = () => {
        const r = b.dataset.r, d = parseInt(b.dataset.d);
        if (d > 0) getCounts[r]++;
        else if (d < 0 && getCounts[r] > 0) getCounts[r]--;
        update();
      };
    });
    const doProposal = (targetIds) => {
      const giveTotal = RES.reduce((s,r)=>s+giveCounts[r],0);
      const getTotal = RES.reduce((s,r)=>s+getCounts[r],0);
      if (giveTotal === 0 || getTotal === 0) { showOverlay('贈与はできません。両方の資源を選んでください。'); return; }
      proposeTrade(me, targetIds, giveCounts, getCounts);
      hideModal();
    };
    const propAll = document.getElementById('propose-all');
    if (propAll) propAll.onclick = () => doProposal(state.players.filter(p=>p.id!==0).map(p=>p.id));
    document.querySelectorAll('.propose-one').forEach(b => {
      b.onclick = () => doProposal([parseInt(b.dataset.pid)]);
    });
  };

  showModal('取引', '', '');
  update();
}

function proposeTrade(proposer, targetIds, give, get) {
  // 各対象AIが受諾するか判定
  const accepted = [];
  for (const tid of targetIds) {
    const target = state.players[tid];
    // hasResources?
    if (!RES.every(r => target.resources[r] >= get[r])) continue;
    if (aiAcceptsTrade(target, give, get)) accepted.push(tid);
  }
  if (accepted.length === 0) {
    logMsg('提案: 受諾されませんでした');
    showOverlay('誰も受諾しませんでした');
    return;
  }
  // 最初に受諾したプレイヤーと取引
  const tid = accepted[0];
  const target = state.players[tid];
  for (const r of RES) {
    proposer.resources[r] -= give[r];
    proposer.resources[r] += get[r];
    target.resources[r] += give[r];
    target.resources[r] -= get[r];
  }
  const giveStr = RES.filter(r=>give[r]>0).map(r=>`${RES_JP[r]}x${give[r]}`).join(',');
  const getStr = RES.filter(r=>get[r]>0).map(r=>`${RES_JP[r]}x${get[r]}`).join(',');
  logMsg(`島内取引成立: ${proposer.name} → ${target.name} : ${giveStr} ⇔ ${getStr}`, 'important');
  updateUI();
}

function aiAcceptsTrade(ai, give, get) {
  // AIは自分のニーズと余剰を見て判定
  const needs = aiResourceNeeds(ai);
  // AIにとって受け取る = give配列、渡す = get配列
  let gainScore = 0, lossScore = 0;
  for (const r of RES) {
    // 受け取るgive[r]
    gainScore += give[r] * (1 + needs[r] * 2);
    // 渡すget[r] - もし手持ち少ない/必要なら高評価
    const after = ai.resources[r] - get[r];
    lossScore += get[r] * (1 + needs[r] * 3 + (after < 0 ? 100 : 0));
  }
  return gainScore > lossScore + 1; // 多少の余裕で受諾
}

// ============================================================
//  Dev cards
// ============================================================
function buyDevCard(player) {
  if (!canAffordDev(player) || state.devDeck.length === 0) return false;
  payCost(player, COSTS.dev);
  const type = state.devDeck.pop();
  player.devCards.push({type, boughtTurn: state.turn});
  logMsg(`${player.name} が発展カードを購入`);
  if (type === 'vp' && player.id !== 0) {
    // AI plays VP card immediately to its hidden total (counted in computeVP)
  }
  return true;
}

function playDevCard(player, idx) {
  const c = player.devCards[idx];
  if (!c) return false;
  if (c.boughtTurn === state.turn && c.type !== 'vp') return false;
  if (player.playedDevThisTurn && c.type !== 'vp') return false;

  if (c.type === 'knight') {
    player.devCards.splice(idx,1);
    player.knightsPlayed++;
    player.playedDevThisTurn = true;
    logMsg(`${player.name} が騎士カードを使った`, 'important');
    updateLargestArmy();
    proceedToMoveRobber();
    return true;
  } else if (c.type === 'road_building') {
    player.devCards.splice(idx,1);
    player.playedDevThisTurn = true;
    logMsg(`${player.name} が街道建設カードを使った（無料で街道2本）`, 'important');
    state.roadBuildingRoads = 2;
    if (player.isAI) {
      aiPlaceFreeRoads();
    } else {
      pendingAction = {type:'free-road'};
      showOverlay('無料で街道を配置 (残り2本)');
    }
    return true;
  } else if (c.type === 'year_of_plenty') {
    player.devCards.splice(idx,1);
    player.playedDevThisTurn = true;
    logMsg(`${player.name} が収穫カードを使った`, 'important');
    if (player.isAI) {
      // pick 2 most-needed
      const needs = aiResourceNeeds(player);
      const sorted = RES.slice().sort((a,b) => needs[b] - needs[a]);
      player.resources[sorted[0]]++;
      player.resources[sorted[1] === sorted[0] ? sorted[1] : sorted[1]]++;
      logMsg(`  → ${RES_JP[sorted[0]]} と ${RES_JP[sorted[1]]} を獲得`);
    } else {
      showYearOfPlentyModal();
    }
    return true;
  } else if (c.type === 'monopoly') {
    player.devCards.splice(idx,1);
    player.playedDevThisTurn = true;
    if (player.isAI) {
      // pick resource AI needs most or others have most of
      const totals = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
      for (const op of state.players) if (op.id !== player.id) for (const r of RES) totals[r] += op.resources[r];
      const best = RES.slice().sort((a,b) => totals[b] - totals[a])[0];
      executeMonopoly(player, best);
    } else {
      showMonopolyModal();
    }
    return true;
  } else if (c.type === 'vp') {
    // VP cards are not "played" - they count in score automatically
    return false;
  }
}

function executeMonopoly(player, resource) {
  let taken = 0;
  for (const op of state.players) {
    if (op.id === player.id) continue;
    taken += op.resources[resource];
    op.resources[resource] = 0;
  }
  player.resources[resource] += taken;
  logMsg(`${player.name} が独占カードで ${RES_JP[resource]} を ${taken} 枚奪った`, 'important');
}

function showYearOfPlentyModal() {
  const me = state.players[0];
  const picked = [];
  const update = () => {
    document.getElementById('modal-content').innerHTML = `
      <div>2種類（同種でも可）の資源を選んでください。選択: ${picked.length}/2</div>
      <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">
        ${RES.map(r => `<button data-r="${r}" ${picked.length>=2?'disabled':''}>${RES_JP[r]}</button>`).join('')}
      </div>
      <div>選択中: ${picked.map(r=>RES_JP[r]).join(', ') || 'なし'}</div>`;
    document.getElementById('modal-buttons').innerHTML = `<button id="yop-ok" ${picked.length===2?'':'disabled'}>確定</button>`;
    document.getElementById('yop-ok').onclick = () => {
      for (const r of picked) me.resources[r]++;
      logMsg(`収穫で ${picked.map(r=>RES_JP[r]).join(', ')} を獲得`);
      hideModal();
      updateUI();
    };
    document.querySelectorAll('#modal-content button').forEach(b => {
      b.onclick = () => { picked.push(b.dataset.r); update(); };
    });
  };
  showModal('収穫', '', '');
  update();
}

function showMonopolyModal() {
  const me = state.players[0];
  const buttons = RES.map(r => `<button data-r="${r}">${RES_JP[r]}</button>`).join(' ');
  showModal('独占', '宣言する資源を選んでください:', buttons);
  document.querySelectorAll('#modal-buttons button').forEach(b => {
    b.onclick = () => {
      executeMonopoly(me, b.dataset.r);
      hideModal();
      updateUI();
    };
  });
}

// ============================================================
//  Longest Road / Largest Army
// ============================================================
function updateLargestArmy() {
  // 「最大騎士力」を持っているプレイヤーより多く出した人が奪う（タイでは保有者が維持）
  const ownerN = state.largestArmyOwner !== null
    ? state.players[state.largestArmyOwner].knightsPlayed : 2;
  let best = null, bestN = ownerN;
  for (const p of state.players) {
    if (p.knightsPlayed >= 3 && p.knightsPlayed > bestN) {
      best = p.id; bestN = p.knightsPlayed;
    }
  }
  if (best === null) return;
  if (state.largestArmyOwner !== null) state.players[state.largestArmyOwner].hasLargestArmy = false;
  state.players[best].hasLargestArmy = true;
  state.largestArmyOwner = best;
  logMsg(`${state.players[best].name} が最大騎士力を獲得！(2点)`, 'important');
}

function updateLongestRoad() {
  // 全員の街道の長さを計算
  for (const p of state.players) p.longestRoadLen = computeLongestRoad(p.id);
  const maxLen = Math.max(...state.players.map(p => p.longestRoadLen));
  // 誰も5本以上いない場合
  if (maxLen < 5) {
    if (state.longestRoadOwner !== null) {
      state.players[state.longestRoadOwner].hasLongestRoad = false;
      state.longestRoadOwner = null;
      logMsg('最長交易路はなくなった');
    }
    return;
  }
  const tops = state.players.filter(p => p.longestRoadLen === maxLen);
  if (state.longestRoadOwner !== null) {
    const cur = state.players[state.longestRoadOwner];
    if (cur.longestRoadLen === maxLen) return; // 現保有者がトップタイなら維持
    // 保有者が最長でなくなった
    cur.hasLongestRoad = false;
    state.longestRoadOwner = null;
    if (tops.length === 1) {
      tops[0].hasLongestRoad = true;
      state.longestRoadOwner = tops[0].id;
      logMsg(`${tops[0].name} が最長交易路を獲得！(2点)`, 'important');
    } else {
      logMsg('最長交易路はタイのため誰のものでもなくなった');
    }
  } else {
    // 保有者なし: 単独最長なら獲得、タイなら誰も獲得しない
    if (tops.length === 1) {
      tops[0].hasLongestRoad = true;
      state.longestRoadOwner = tops[0].id;
      logMsg(`${tops[0].name} が最長交易路を獲得！(2点)`, 'important');
    }
  }
}

function computeLongestRoad(playerId) {
  const myEdges = state.players[playerId].roads;
  if (myEdges.length === 0) return 0;
  let max = 0;
  for (const start of myEdges) {
    const visited = new Set([start]);
    max = Math.max(max, dfsRoad(playerId, start, state.board.edges[start].v1, visited));
    max = Math.max(max, dfsRoad(playerId, start, state.board.edges[start].v2, visited));
  }
  return max;
}

function dfsRoad(playerId, currentEdge, fromVertex, visited) {
  const e = state.board.edges[currentEdge];
  const nextVertex = e.v1 === fromVertex ? e.v2 : e.v1;
  // Check if nextVertex is blocked by opponent
  const v = state.board.vertices[nextVertex];
  if (v.building && v.building.player !== playerId) return 1;
  let best = 1;
  for (const eid of v.edges) {
    if (visited.has(eid)) continue;
    if (state.board.edges[eid].road !== playerId) continue;
    visited.add(eid);
    best = Math.max(best, 1 + dfsRoad(playerId, eid, nextVertex, visited));
    visited.delete(eid);
  }
  return best;
}

// ============================================================
//  VP / Win
// ============================================================
function computeVP(p) {
  let vp = p.settlements.length + p.cities.length * 2;
  if (p.hasLongestRoad) vp += 2;
  if (p.hasLargestArmy) vp += 2;
  vp += p.devCards.filter(c => c.type === 'vp').length;
  return vp;
}

function checkWin() {
  const p = state.players[state.currentPlayer];
  if (computeVP(p) >= 10) {
    state.phase = 'gameover';
    state.winner = p.id;
    if (typeof _fastMode !== 'undefined' && _fastMode) return true;
    if (typeof nnOnGameEnd === 'function') nnOnGameEnd(p.id === 0);
    logMsg(`🏆 ${p.name} が ${computeVP(p)} 点で勝利！`, 'important');
    showModal('ゲーム終了', `${p.name}の勝利！ (${computeVP(p)}点)`,
      '<button onclick="location.reload()">新しいゲーム</button>');
    return true;
  }
  return false;
}

// ============================================================
//  End Turn
// ============================================================
function endTurn() {
  if (state.phase !== 'main') return;
  if (checkWin()) return;
  state.currentPlayer = (state.currentPlayer + 1) % 4;
  state.turn++;
  startTurn();
}

// ============================================================
//  AI
// ============================================================
function aiRollDice() {
  // Optional: play knight before roll if our productive hex is blocked
  const p = state.players[state.currentPlayer];
  const playableKnight = p.devCards.find(c => c.type === 'knight' && c.boughtTurn < state.turn);
  if (playableKnight && !p.playedDevThisTurn) {
    const ourHexes = new Set();
    for (const vid of p.settlements.concat(p.cities)) {
      for (const hid of state.board.vertices[vid].hexes) ourHexes.add(hid);
    }
    const blocked = [...ourHexes].some(hid => state.board.hexes[hid].hasRobber);
    if (blocked && Math.random() < 0.7) {
      state.preRobberPhase = 'roll';
      playDevCard(p, p.devCards.indexOf(playableKnight));
      return;
    }
  }
  rollDice();
}

function aiMainTurn() {
  if (state.phase !== 'main') return;
  if (state.players[state.currentPlayer].isAI === false) return;
  // NN hook: when NN AI is active for this player, delegate to NN-based selection
  // MCTSロールアウト中はNN/MCTSを使わずヒューリスティックにフォールバック（無限再帰防止）
  const _inRollout = typeof _insideMCTSRollout !== 'undefined' && _insideMCTSRollout;
  if (!_inRollout && typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer()) {
    // MCTS 強化学習モード時は MCTS-guided 決定を使用
    if (typeof _mctsTrainMode !== 'undefined' && _mctsTrainMode &&
        typeof aiMainTurnMCTS === 'function' && typeof window._analysisEval !== 'undefined') {
      return aiMainTurnMCTS(state.currentPlayer);
    }
    return aiMainTurnNN();
  }

  // Collect features for heuristic players too — gives 4× training data in mixed mode
  if (typeof _trainingSamples !== 'undefined' && _trainingSamples !== null &&
      typeof nnExtractFeatures === 'function') {
    _trainingSamples.push({
      playerId: state.currentPlayer,
      features: nnExtractFeatures(state.currentPlayer),
      turn: state.turn
    });
  }
  const p = state.players[state.currentPlayer];
  if (checkWin()) return;

  // Try to play a knight or progress card if useful
  const knightToPlay = p.devCards.find(c => c.type === 'knight' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && knightToPlay && p.knightsPlayed >= 2 && !p.hasLargestArmy) {
    playDevCard(p, p.devCards.indexOf(knightToPlay));
    return;
  }
  const monopolyToPlay = p.devCards.find(c => c.type === 'monopoly' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && monopolyToPlay) {
    playDevCard(p, p.devCards.indexOf(monopolyToPlay));
    setTimeout(aiMainTurn, 300);
    return;
  }
  const yopToPlay = p.devCards.find(c => c.type === 'year_of_plenty' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && yopToPlay && canAlmostBuild(p)) {
    playDevCard(p, p.devCards.indexOf(yopToPlay));
    setTimeout(aiMainTurn, 300);
    return;
  }
  const rbToPlay = p.devCards.find(c => c.type === 'road_building' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && rbToPlay && p.roads.length < 13 && (computeVP(p) >= 7 || p.longestRoadLen >= 3)) {
    playDevCard(p, p.devCards.indexOf(rbToPlay));
    return;
  }

  // Try to build
  // 1) City > Settlement > Road > Dev
  if (canAffordCity(p) && p.cities.length < PIECES_PER_PLAYER.city) {
    const vid = aiBestCitySpot(p);
    if (vid != null) {
      payCost(p, COSTS.city);
      placeCity(p.id, vid);
      logMsg(`${p.name} が都市を建設`);
      setTimeout(aiMainTurn, 400);
      return;
    }
  }
  if (canAffordSettlement(p) && p.settlements.length < PIECES_PER_PLAYER.settlement) {
    const vid = aiBestSettlementSpot(p);
    if (vid != null) {
      payCost(p, COSTS.settlement);
      placeSettlement(p.id, vid);
      logMsg(`${p.name} が開拓地を建設`);
      setTimeout(aiMainTurn, 400);
      return;
    }
  }
  if (canAffordRoad(p) && p.roads.length < PIECES_PER_PLAYER.road) {
    // Only build road if it leads somewhere useful or extends longest road
    const eid = aiBestRoadSpot(p);
    if (eid != null) {
      payCost(p, COSTS.road);
      placeRoad(p.id, eid);
      logMsg(`${p.name} が街道を建設`);
      setTimeout(aiMainTurn, 400);
      return;
    }
  }
  if (canAffordDev(p) && state.devDeck.length > 0 && Math.random() < 0.7) {
    buyDevCard(p);
    setTimeout(aiMainTurn, 400);
    return;
  }
  // Try player-to-player trade first (better rates than maritime)
  const tr = aiPlayerTrade(p);
  if (tr === 'pending') return; // 人間 P0 への提案中: モーダル応答時に AI ターンを再開する
  if (tr) {
    setTimeout(aiMainTurn, 400);
    return;
  }
  // Then maritime (bank) trade
  if (aiMaritimeTrade(p)) {
    setTimeout(aiMainTurn, 400);
    return;
  }

  // End turn
  setTimeout(() => {
    endTurn();
  }, 500);
}

function canAlmostBuild(p) {
  // Returns true if player is close (1-2 resources) from building anything useful
  for (const [name,cost] of Object.entries(COSTS)) {
    const need = Object.entries(cost).reduce((s,[r,n]) => s + Math.max(0, n - p.resources[r]), 0);
    if (need > 0 && need <= 2) return true;
  }
  return false;
}

function aiBestCitySpot(p) {
  let best = null, bestScore = -Infinity;
  for (const vid of p.settlements) {
    const score = evaluateVertex(vid, p.id);
    if (score > bestScore) { bestScore = score; best = vid; }
  }
  return best;
}

function aiBestSettlementSpot(p) {
  let best = null, bestScore = -Infinity;
  for (let i=0; i<state.board.vertices.length; i++) {
    if (!isVertexBuildable(i, p.id, false)) continue;
    const score = evaluateVertex(i, p.id);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function aiBestRoadSpot(p) {
  // Find road that maximizes nearest reachable settlement spot value
  let best = null, bestScore = -Infinity;
  for (let i=0; i<state.board.edges.length; i++) {
    if (!isEdgeBuildable(i, p.id, null)) continue;
    const e = state.board.edges[i];
    // Score = reachability of nearby vertices
    let s = 0;
    for (const vid of [e.v1, e.v2]) {
      if (state.board.vertices[vid].building) continue;
      // Can we build there? Check distance rule
      let canBuild = true;
      for (const nv of state.board.vertices[vid].adjV) {
        if (state.board.vertices[nv].building) { canBuild = false; break; }
      }
      if (canBuild) s += evaluateVertex(vid, p.id);
    }
    // Bonus for extending longest road
    const baselineLen = p.longestRoadLen;
    placeRoadDryRun(p.id, i);
    const newLen = computeLongestRoad(p.id);
    unplaceRoadDryRun(i);
    if (newLen > baselineLen) s += (newLen - baselineLen) * 4;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

function placeRoadDryRun(pid, eid) { state.board.edges[eid].road = pid; }
function unplaceRoadDryRun(eid) { state.board.edges[eid].road = null; }

// AI 同士の島内交渉 (1対1, 不足資源↔余剰資源)
// - AI同士: aiAcceptsTrade で即時判定
// - P0 (人間): モーダル提示で Y/N 待ち。trainingやfast modeでは P0 提案はスキップ
// 同ターン最大 2 回まで (無限ループ防止)
function aiPlayerTrade(p) {
  if ((p._tradesThisTurn || 0) >= 2) return false;
  // 学習・ロールアウト中は人間への提案は出さない (UI不可)
  const fastNow = (typeof _fastMode !== 'undefined' && _fastMode);
  const needs = aiResourceNeeds(p);
  const wantedRes = RES.filter(r => needs[r] > 0).sort((a,b) => needs[b] - needs[a]);
  if (wantedRes.length === 0) return false;
  const surplus = RES.filter(r => p.resources[r] >= 2 && !wantedRes.includes(r));
  if (surplus.length === 0) return false;

  const beforeCity = canAffordCity(p) && p.cities.length < PIECES_PER_PLAYER.city && p.settlements.length > 0;
  const beforeSett = canAffordSettlement(p) && p.settlements.length < PIECES_PER_PLAYER.settlement;
  const beforeRoad = canAffordRoad(p) && p.roads.length < PIECES_PER_PLAYER.road;
  const beforeDev  = canAffordDev(p);

  let pendingHumanProposal = null;

  for (const get of wantedRes) {
    for (const give of surplus) {
      if (give === get) continue;
      p.resources[give]--; p.resources[get]++;
      const afterCity = canAffordCity(p) && p.cities.length < PIECES_PER_PLAYER.city && p.settlements.length > 0;
      const afterSett = canAffordSettlement(p) && p.settlements.length < PIECES_PER_PLAYER.settlement;
      const afterRoad = canAffordRoad(p) && p.roads.length < PIECES_PER_PLAYER.road;
      const afterDev  = canAffordDev(p);
      p.resources[give]++; p.resources[get]--;

      const enablesNew = (afterCity && !beforeCity) || (afterSett && !beforeSett)
                      || (afterRoad && !beforeRoad) || (afterDev && !beforeDev);
      if (!enablesNew) continue;

      const giveObj = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
      const getObj  = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
      giveObj[give] = 1; getObj[get] = 1;

      // AI 受諾候補を優先
      for (let oppId = 0; oppId < state.players.length; oppId++) {
        if (oppId === p.id) continue;
        const opp = state.players[oppId];
        if (!opp.isAI) continue;
        if (opp.resources[get] < 1) continue;
        if (aiAcceptsTrade(opp, giveObj, getObj)) {
          proposeTrade(p, [oppId], giveObj, getObj);
          p._tradesThisTurn = (p._tradesThisTurn || 0) + 1;
          return true;
        }
      }

      // 該当 AI が受諾しないが、P0 (人間) がその資源を持っている → 候補として記憶
      if (!fastNow && !pendingHumanProposal) {
        const human = state.players[0];
        if (human && !human.isAI && human.resources[get] >= 1) {
          pendingHumanProposal = { give, get, giveObj, getObj };
        }
      }
    }
  }

  // AI同士で成立しなかったが、P0に提案できる候補があればモーダル提示
  if (pendingHumanProposal && typeof askHumanTrade === 'function') {
    const shown = askHumanTrade(p, pendingHumanProposal);
    if (shown) {
      p._tradesThisTurn = (p._tradesThisTurn || 0) + 1;
      return 'pending'; // ユーザー応答待ち (AIターン継続を停止)
    }
  }
  return false;
}

// AI が人間 P0 に取引を提案する。戻り値: モーダル提示成功なら true。
function askHumanTrade(proposer, proposal) {
  const { give, get, giveObj, getObj } = proposal;
  const giveJP = RES_JP[give];
  const getJP  = RES_JP[get];
  if (typeof showModal !== 'function') return false;
  const content = `
    <div style="font-size:14px;line-height:1.6">
      <b style="color:${proposer.color === '#fff' ? '#ddd' : proposer.color}">${proposer.name}</b> があなたに取引を提案:
    </div>
    <div style="margin-top:12px;padding:10px;background:#1a1f25;border-radius:6px;font-size:15px;text-align:center">
      <span style="color:#7ee87e">${proposer.name} → あなた</span>: ${giveJP}×1<br>
      <span style="color:#f88">あなた → ${proposer.name}</span>: ${getJP}×1
    </div>
    <div style="margin-top:8px;font-size:12px;color:#aac">あなたの所持: ${getJP}×${state.players[0].resources[get]}</div>
  `;
  showModal(`取引提案 from ${proposer.name}`, content,
    `<button id="trade-yes" style="background:linear-gradient(135deg,#4a8a4a,#3a7a3a);border-color:#6aaa6a">承諾 (Y)</button>
     <button id="trade-no">拒否 (N)</button>`);

  const finish = (accept) => {
    document.removeEventListener('keydown', onKey, true);
    hideModal();
    if (accept) {
      // 人間が既に承諾したので、proposeTrade経由でなく直接実行
      const human = state.players[0];
      for (const r of RES) {
        proposer.resources[r] -= giveObj[r];
        proposer.resources[r] += getObj[r];
        human.resources[r] += giveObj[r];
        human.resources[r] -= getObj[r];
      }
      const giveStr = RES.filter(r=>giveObj[r]>0).map(r=>`${RES_JP[r]}x${giveObj[r]}`).join(',');
      const getStr = RES.filter(r=>getObj[r]>0).map(r=>`${RES_JP[r]}x${getObj[r]}`).join(',');
      logMsg(`島内取引成立: ${proposer.name} → あなた : ${giveStr} ⇔ ${getStr}`, 'important');
    } else {
      logMsg(`あなたが ${proposer.name} の提案を拒否`, 'system');
    }
    updateUI();
    // AI のターンを再開
    if (proposer.isAI && state.phase === 'main') {
      setTimeout(aiMainTurn, 300);
    }
  };
  const onKey = (e) => {
    if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  document.getElementById('trade-yes').onclick = () => finish(true);
  document.getElementById('trade-no').onclick = () => finish(false);
  document.addEventListener('keydown', onKey, true);
  return true;
}

function aiMaritimeTrade(p) {
  // If we have lots of one resource and missing pieces for a building, trade
  for (const give of RES) {
    const ratio = getTradeRatio(p, give);
    if (p.resources[give] < ratio + 1) continue;
    // What do we need most?
    const needs = aiResourceNeeds(p);
    const want = RES.filter(r => r !== give).sort((a,b) => needs[b] - needs[a])[0];
    if (needs[want] > 0) {
      maritimeTrade(p, give, want);
      return true;
    }
  }
  return false;
}

function aiResourceNeeds(p) {
  const needs = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
  for (const cost of Object.values(COSTS)) {
    for (const [r,n] of Object.entries(cost)) {
      needs[r] += Math.max(0, n - p.resources[r]);
    }
  }
  return needs;
}

function aiMoveRobber() {
  const p = state.players[state.currentPlayer];
  // NN フック: 学習済み NN で盗賊配置を選ぶ
  if (typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer()
      && typeof aiMoveRobberNN === 'function') {
    return aiMoveRobberNN();
  }
  // ヒューリスティック用にサンプル収集 (学習時)
  if (typeof _trainingSamples !== 'undefined' && _trainingSamples !== null &&
      typeof nnExtractFeatures === 'function') {
    _trainingSamples.push({ playerId: p.id, features: nnExtractFeatures(p.id), turn: state.turn });
  }
  // Find best hex: adjacent to high-VP opponent without our buildings
  let best = -1, bestScore = -Infinity;
  for (const hex of state.board.hexes) {
    if (hex.hasRobber) continue;
    let touchesUs = false;
    let score = 0;
    for (const vid of hex.vertices) {
      const v = state.board.vertices[vid];
      if (!v.building) continue;
      if (v.building.player === p.id) { touchesUs = true; break; }
      const vp = computeVP(state.players[v.building.player]);
      const res = RES.reduce((s,r)=>s+state.players[v.building.player].resources[r],0);
      score += vp * 3 + res;
    }
    if (touchesUs) continue;
    score += (PROB_PIPS[hex.number] || 0);
    if (score > bestScore) { bestScore = score; best = hex.id; }
  }
  if (best < 0) {
    // fallback: any non-current
    for (const hex of state.board.hexes) if (!hex.hasRobber) { best = hex.id; break; }
  }
  moveRobberTo(best);
}

function aiPlaceFreeRoads() {
  const p = state.players[state.currentPlayer];
  for (let i=0; i<2 && state.roadBuildingRoads > 0; i++) {
    const eid = aiBestRoadSpot(p);
    if (eid == null) break;
    placeRoad(p.id, eid);
    state.roadBuildingRoads--;
    logMsg(`${p.name} が無料街道を配置`);
  }
  state.roadBuildingRoads = 0;
  setTimeout(aiMainTurn, 400);
}

// ============================================================
//  Mouse interaction
// ============================================================
function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function findVertex(x, y) {
  for (const v of state.board.vertices) {
    if (Math.hypot(x - v.x, y - v.y) < 12) return v.id;
  }
  return -1;
}
function findEdge(x, y) {
  let best = -1, bestD = 8;
  for (const e of state.board.edges) {
    const v1 = state.board.vertices[e.v1], v2 = state.board.vertices[e.v2];
    const d = distPointSegment(x, y, v1.x, v1.y, v2.x, v2.y);
    if (d < bestD) { bestD = d; best = e.id; }
  }
  return best;
}
function findHex(x, y) {
  let best = -1, bestD = HEX_SIZE;
  for (const h of state.board.hexes) {
    const d = Math.hypot(x - h.x, y - h.y);
    if (d < bestD) { bestD = d; best = h.id; }
  }
  return best;
}
function distPointSegment(px, py, ax, ay, bx, by) {
  const dx = bx-ax, dy = by-ay;
  const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
}

function onMouseMove(e) {
  if (!pendingAction) { if (hoverTarget) { hoverTarget = null; render(); } return; }
  const {x,y} = getMousePos(e);
  let newTarget = null;
  if (pendingAction.type === 'setup-settlement' || pendingAction.type === 'settlement' || pendingAction.type === 'city') {
    const vid = findVertex(x,y);
    if (vid >= 0) newTarget = {type:'vertex', id: vid};
  } else if (pendingAction.type === 'setup-road' || pendingAction.type === 'road' || pendingAction.type === 'free-road') {
    const eid = findEdge(x,y);
    if (eid >= 0) newTarget = {type:'edge', id: eid};
  } else if (pendingAction.type === 'moveRobber') {
    const hid = findHex(x,y);
    if (hid >= 0) newTarget = {type:'hex', id: hid};
  }
  if (JSON.stringify(newTarget) !== JSON.stringify(hoverTarget)) {
    hoverTarget = newTarget;
    render();
  }
}

function onCanvasClick(e) {
  if (!pendingAction) return;
  const {x,y} = getMousePos(e);
  const pid = state.currentPlayer;
  if (pendingAction.type === 'setup-settlement') {
    const vid = findVertex(x,y);
    if (vid >= 0) setupPlaceSettlement(vid);
  } else if (pendingAction.type === 'setup-road') {
    const eid = findEdge(x,y);
    if (eid >= 0) setupPlaceRoad(eid);
  } else if (pendingAction.type === 'road') {
    const eid = findEdge(x,y);
    if (eid >= 0 && isEdgeBuildable(eid, pid, null)) {
      if (typeof nnRecordHumanAction === 'function') nnRecordHumanAction();
      const p = state.players[pid];
      payCost(p, COSTS.road);
      placeRoad(pid, eid);
      logMsg(`あなたが街道を建設`);
      pendingAction = null;
      hoverTarget = null;
      updateUI();
    }
  } else if (pendingAction.type === 'settlement') {
    const vid = findVertex(x,y);
    if (vid >= 0 && isVertexBuildable(vid, pid, false)) {
      if (typeof nnRecordHumanAction === 'function') nnRecordHumanAction();
      const p = state.players[pid];
      payCost(p, COSTS.settlement);
      placeSettlement(pid, vid);
      logMsg(`あなたが開拓地を建設`);
      pendingAction = null;
      hoverTarget = null;
      updateUI();
      if (checkWin()) return;
    }
  } else if (pendingAction.type === 'city') {
    const vid = findVertex(x,y);
    if (vid >= 0) {
      const v = state.board.vertices[vid];
      if (v.building && v.building.player === pid && v.building.type === 'settlement') {
        if (typeof nnRecordHumanAction === 'function') nnRecordHumanAction();
        const p = state.players[pid];
        payCost(p, COSTS.city);
        placeCity(pid, vid);
        logMsg(`あなたが都市を建設`);
        pendingAction = null;
        hoverTarget = null;
        updateUI();
        if (checkWin()) return;
      }
    }
  } else if (pendingAction.type === 'moveRobber') {
    const hid = findHex(x,y);
    if (hid >= 0) {
      if (moveRobberTo(hid)) {
        pendingAction = null;
        hoverTarget = null;
        updateUI();
      }
    }
  } else if (pendingAction.type === 'free-road') {
    const eid = findEdge(x,y);
    if (eid >= 0 && isEdgeBuildable(eid, pid, null)) {
      placeRoad(pid, eid);
      logMsg(`あなたが無料街道を配置`);
      state.roadBuildingRoads--;
      if (state.roadBuildingRoads <= 0) {
        pendingAction = null;
        hoverTarget = null;
      } else {
        showOverlay(`残り ${state.roadBuildingRoads} 本`);
      }
      updateUI();
    }
  }
}

// ============================================================
//  Modal helpers
// ============================================================
function showModal(title, content, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-content').innerHTML = content;
  document.getElementById('modal-buttons').innerHTML = buttons;
  document.getElementById('modal-bg').classList.remove('hidden');
}
function hideModal() {
  document.getElementById('modal-bg').classList.add('hidden');
}

// ============================================================
//  Button handlers
// ============================================================
function setupButtons() {
  document.getElementById('btn-roll').onclick = () => rollDice();
  document.getElementById('btn-build-road').onclick = () => {
    pendingAction = {type:'road'};
    showOverlay('街道を建設する辺をクリック');
    updateUI();
  };
  document.getElementById('btn-build-settlement').onclick = () => {
    pendingAction = {type:'settlement'};
    showOverlay('開拓地を建設する頂点をクリック');
    updateUI();
  };
  document.getElementById('btn-build-city').onclick = () => {
    pendingAction = {type:'city'};
    showOverlay('都市にする自分の開拓地をクリック');
    updateUI();
  };
  document.getElementById('btn-buy-dev').onclick = () => {
    if (typeof nnRecordHumanAction === 'function') nnRecordHumanAction();
    if (buyDevCard(state.players[0])) updateUI();
  };
  document.getElementById('btn-trade').onclick = showTradeModal;
  document.getElementById('btn-play-dev').onclick = () => showPlayDevModal();
  document.getElementById('btn-end-turn').onclick = () => {
    if (typeof nnRecordHumanAction === 'function') nnRecordHumanAction();
    endTurn();
  };
  document.getElementById('btn-cancel').onclick = () => {
    pendingAction = null; hoverTarget = null;
    document.getElementById('overlay-msg').classList.remove('show');
    updateUI();
  };
}

function showPlayDevModal() {
  const me = state.players[0];
  const playable = me.devCards
    .map((c,i) => ({c,i}))
    .filter(({c}) => c.type !== 'vp' && c.boughtTurn < state.turn);
  if (playable.length === 0) {
    showModal('発展カードを使う', '使えるカードがありません。', '<button onclick="hideModal()">閉じる</button>');
    return;
  }
  const btns = playable.map(({c,i}) => `<button data-i="${i}">${DEV_JP[c.type]}</button>`).join(' ');
  showModal('発展カードを使う', '使用するカードを選んでください:', btns + ' <button onclick="hideModal()">キャンセル</button>');
  document.querySelectorAll('#modal-buttons button[data-i]').forEach(b => {
    b.onclick = () => {
      hideModal();
      playDevCard(me, parseInt(b.dataset.i));
      updateUI();
    };
  });
}

// ============================================================
//  Init
// ============================================================
window.addEventListener('load', () => {
  canvas = document.getElementById('board');
  ctx = canvas.getContext('2d');
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('click', onCanvasClick);
  setupButtons();
  newGame();
  updateUI();
  setupStep();
});
