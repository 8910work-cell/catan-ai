// MCTS最強CPU + 勝率予測精度向上のヘッドレス検証
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeStubEl() {
  return {
    addEventListener: () => {}, removeEventListener: () => {},
    getContext: () => new Proxy({}, { get: (t, k) => {
      if (k === 'measureText') return () => ({width:0});
      if (k === 'createLinearGradient') return () => ({addColorStop:()=>{}});
      return typeof k === 'string' ? () => {} : undefined;
    }, set: () => true }),
    classList: {add:()=>{},remove:()=>{},contains:()=>false,toggle:()=>{}},
    style:{}, checked:false, disabled:false, value:'', textContent:'', innerHTML:'',
    width:820, height:780, children:[], childNodes:[],
    onclick:null, onchange:null,
    click:()=>{}, appendChild:()=>{}, removeChild:()=>{},
    insertAdjacentElement:()=>{},
    getBoundingClientRect:()=>({left:0,top:0,width:820,height:780,right:820,bottom:780}),
    querySelector:()=>null, querySelectorAll:()=>[],
    setAttribute:()=>{}, getAttribute:()=>'',
  };
}

function createContext() {
  const ctx = {
    document: {
      getElementById: () => makeStubEl(),
      createElement: () => makeStubEl(),
      body: makeStubEl(),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    setTimeout: (fn) => { try { fn(); } catch (e) { if (e && e.message === 'TEST_TIME_UP') throw e; console.error('setTimeout err:', e.message); } return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    console,
    Math, Date, Array, Object, JSON, Map, Set, Number, String, Boolean, Symbol, Promise, RegExp, Error, Proxy,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => Date.now() },
    localStorage: {getItem:()=>null, setItem:()=>{}, removeItem:()=>{}, clear:()=>{}},
    alert: () => {}, prompt: () => '', confirm: () => false,
  };
  ctx.window = ctx;
  ctx.global = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  vm.createContext(ctx);
  return ctx;
}

function load(ctx, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), ctx, {filename: file});
}

function loadAll(ctx) {
  for (const f of ['game.js', 'strong_ai.js', 'nn.js', 'analysis.js', 'mcts_cpu.js']) load(ctx, f);
}

function runFullGame(ctx) {
  vm.runInContext(`
    newGame();
    for (const p of state.players) p.isAI = true;
    setupStep();
    {
      let safety = 8000;
      while (state.phase !== 'gameover' && safety-- > 0) {
        if (state.phase === 'roll') aiRollDice();
        else if (state.phase === 'main') aiMainTurn();
        else if (state.phase === 'discard') processNextDiscard();
        else if (state.phase === 'moveRobber') aiMoveRobber();
        else break;
      }
    }
  `, ctx);
  return vm.runInContext('({winner: state.winner, turn: state.turn, phase: state.phase})', ctx);
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${info ? ' — ' + info : ''}`); }
}

// ── Test 1: 既存ヒューリスティック対局の回帰確認 ──
console.log('Test 1: 通常対局 (strong_ai 改修の回帰チェック)');
{
  const ctx = createContext();
  loadAll(ctx);
  const r = runFullGame(ctx);
  check('ゲームが正常終了', r.winner != null, `phase=${r.phase} turn=${r.turn}`);
}

// ── Test 2: _rolloutStrongAll で全員強力AI対局 ──
console.log('Test 2: _rolloutStrongAll=true で4人全員が強力AIの対局');
{
  const ctx = createContext();
  loadAll(ctx);
  vm.runInContext('window._rolloutStrongAll = true;', ctx);
  let ok = true, winner = null;
  for (let g = 0; g < 5; g++) {
    try { const r = runFullGame(ctx); if (r.winner == null) ok = false; winner = r.winner; }
    catch (e) { ok = false; console.error('  crash:', e.message); break; }
  }
  vm.runInContext('window._rolloutStrongAll = false;', ctx);
  check('5ゲームすべて正常終了', ok, `last winner=${winner}`);
}

// ── Test 3: evaluateCandidatesSH の出力形状と精度メタデータ ──
console.log('Test 3: evaluateCandidatesSH (逐次絞り込み評価)');
{
  const ctx = createContext();
  loadAll(ctx);
  const out = vm.runInContext(`
    newGame();
    for (const p of state.players) p.isAI = true;
    setupStep();
    // node環境ではsetTimeoutが同期なのでaiRollDiceは終局まで連鎖する。
    // 手動で main フェーズの状態を構成する。
    state.phase = 'main';
    state.currentPlayer = 0;
    state.dice = [3, 4];
    for (const r of RES) state.players[0].resources[r] = 2;
    const pid = state.currentPlayer;
    const snapTurn = state.turn;
    const cands = window._analysisEval.getCandidates(pid);
    const res = window._analysisEval.evaluateCandidatesSH(pid, cands, 8);
    ({
      phase: state.phase,
      turnUnchanged: state.turn === snapTurn,
      n: res.length,
      nCands: cands.length,
      sorted: res.every((r, i) => i === 0 || res[i-1].winRate >= r.winRate - 1e-9),
      hasRollouts: res.every(r => typeof r.rollouts === 'number' && r.rollouts >= 4),
      ratesValid: res.every(r => r.winRate >= 0 && r.winRate <= 1),
      topRollouts: res[0] ? res[0].rollouts : 0,
      fastModeRestored: _fastMode === false,
    })
  `, ctx);
  check('main フェーズで評価実行', out.phase === 'main');
  check('全候補が評価される', out.n === out.nCands, `${out.n}/${out.nCands}`);
  check('勝率降順にソート', out.sorted);
  check('rollouts メタデータあり', out.hasRollouts);
  check('勝率が [0,1]', out.ratesValid);
  check('上位候補は2倍精度 (16 rollouts)', out.topRollouts === 16, `top=${out.topRollouts}`);
  check('評価後に状態復元', out.turnUnchanged && out.fastModeRestored);
}

// ── Test 4: MCTS最強CPUでゲーム進行 (時間制限付き) ──
console.log('Test 4: MCTS最強CPU でのゲーム進行 (90秒タイムボックス)');
{
  const ctx = createContext();
  loadAll(ctx);
  const deadline = Date.now() + 90000;
  vm.runInContext(`window.__deadline = ${deadline};`, ctx);
  // setTimeout に時間制限を仕込む (時間切れで TEST_TIME_UP を投げて打ち切り)
  const origST = ctx.setTimeout;
  ctx.setTimeout = (fn) => {
    if (Date.now() > deadline) throw new Error('TEST_TIME_UP');
    return origST(fn);
  };
  let timedOut = false, crashed = null;
  try {
    vm.runInContext(`
      mctsCpuEnabled = true;
      mctsCpuRollouts = 4;
      newGame();
      for (const p of state.players) p.isAI = true;
      setupStep();
      {
        let safety = 4000;
        while (state.phase !== 'gameover' && safety-- > 0) {
          if (state.phase === 'roll') aiRollDice();
          else if (state.phase === 'main') aiMainTurn();
          else if (state.phase === 'discard') processNextDiscard();
          else if (state.phase === 'moveRobber') aiMoveRobber();
          else break;
        }
      }
    `, ctx);
  } catch (e) {
    if (e.message === 'TEST_TIME_UP') timedOut = true;
    else crashed = e.message + '\n' + (e.stack || '').split('\n').slice(0,5).join('\n');
  }
  const st = vm.runInContext(`({
    winner: state.winner, turn: state.turn, phase: state.phase,
    buildings: state.players.reduce((s,p)=>s+p.settlements.length+p.cities.length,0),
    roads: state.players.reduce((s,p)=>s+p.roads.length,0),
  })`, ctx);
  check('クラッシュなし', crashed === null, crashed || '');
  check('初期配置完了 (建物8個以上)', st.buildings >= 8, `buildings=${st.buildings}`);
  check('ゲーム進行 (終了 or 時間切れまで進行)', st.winner != null || (timedOut && st.turn >= 1),
        `winner=${st.winner} turn=${st.turn} phase=${st.phase} timedOut=${timedOut}`);
  console.log(`  (情報: winner=${st.winner}, turn=${st.turn}, buildings=${st.buildings}, roads=${st.roads}, timedOut=${timedOut})`);
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
