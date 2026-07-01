// ベンチマーク: P0 = MCTS最強CPU vs P1-3 = ヒューリスティック
// 使い方: node --stack-size=8000 bench_mcts.js [ゲーム数] [ロールアウト数]
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
    click:()=>{}, appendChild:()=>{}, removeChild:()=>{}, insertAdjacentElement:()=>{},
    getBoundingClientRect:()=>({left:0,top:0,width:820,height:780,right:820,bottom:780}),
    querySelector:()=>null, querySelectorAll:()=>[],
    setAttribute:()=>{}, getAttribute:()=>'',
  };
}

const ctx = {
  document: { getElementById: () => makeStubEl(), createElement: () => makeStubEl(), body: makeStubEl(), addEventListener: () => {}, removeEventListener: () => {} },
  setTimeout: (fn) => { try { fn(); } catch (e) { console.error('st err:', e.message); } return 0; },
  clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  console, Math, Date, Array, Object, JSON, Map, Set, Number, String, Boolean, Symbol, Promise, RegExp, Error, Proxy,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
  performance: { now: () => Date.now() },
  localStorage: {getItem:()=>null, setItem:()=>{}, removeItem:()=>{}, clear:()=>{}},
  alert: () => {}, prompt: () => '', confirm: () => false,
};
ctx.window = ctx; ctx.global = ctx;
ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
vm.createContext(ctx);
for (const f of ['game.js', 'strong_ai.js', 'nn.js', 'analysis.js', 'mcts_cpu.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, {filename: f});
}

const N = parseInt(process.argv[2]) || 10;
const R = parseInt(process.argv[3]) || 6;

// P0 のターンのみ MCTS CPU を有効化するラッパ
vm.runInContext(`
  mctsCpuRollouts = ${R};
  {
    const _m = aiMainTurn, _s = aiSetupTurn, _r = aiMoveRobber;
    const p0Turn = () => state.currentPlayer === 0 &&
      !(typeof _insideMCTSRollout !== 'undefined' && _insideMCTSRollout) &&
      !(typeof _fastMode !== 'undefined' && _fastMode);
    aiMainTurn = function() { mctsCpuEnabled = p0Turn(); return _m(); };
    aiSetupTurn = function() { mctsCpuEnabled = p0Turn(); return _s(); };
    aiMoveRobber = function() { mctsCpuEnabled = p0Turn(); return _r(); };
  }
  // P0 が MCTS なので strong AI の P0 優遇は無効化 (対戦相手は素のヒューリスティック)
  strongModeEnabled = false;
`, ctx);

console.log(`=== MCTS CPU (P0, ${R} rollouts) vs ヒューリスティック (P1-3) — ${N}ゲーム ===`);
const wins = [0, 0, 0, 0];
let done = 0;
const t0 = Date.now();
for (let g = 0; g < N; g++) {
  try {
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
    const w = vm.runInContext('state.winner', ctx);
    if (w != null) { wins[w]++; done++; }
    const dt = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  game ${g+1}/${N}: winner=P${w} | 累計 P0:${wins[0]} P1:${wins[1]} P2:${wins[2]} P3:${wins[3]} (${dt}s)`);
  } catch (e) {
    console.error(`  game ${g+1} crash:`, e.message);
  }
}
console.log(`\nP0 (MCTS) 勝率: ${done ? (wins[0]/done*100).toFixed(1) : '-'}% (${wins[0]}/${done})  [ヒューリスティック期待値: 25%]`);
