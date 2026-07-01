// Node.js ヘッドレステスト: game.js を非ブラウザで実行して勝率を測定
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function makeStubEl() {
  return {
    addEventListener: () => {}, removeEventListener: () => {},
    getContext: () => ({
      fillStyle:'', strokeStyle:'', lineWidth:1, font:'', textAlign:'', textBaseline:'',
      globalAlpha:1, lineCap:'', shadowColor:'', shadowBlur:0,
      fillRect:()=>{}, strokeRect:()=>{}, clearRect:()=>{},
      beginPath:()=>{}, closePath:()=>{}, moveTo:()=>{}, lineTo:()=>{},
      arc:()=>{}, fill:()=>{}, stroke:()=>{}, fillText:()=>{}, strokeText:()=>{},
      save:()=>{}, restore:()=>{}, translate:()=>{}, rotate:()=>{}, scale:()=>{},
      drawImage:()=>{}, measureText:()=>({width:0}), setLineDash:()=>{},
      createLinearGradient:()=>({addColorStop:()=>{}}),
    }),
    classList:{add:()=>{},remove:()=>{},contains:()=>false,toggle:()=>{}},
    style:{}, checked:false, disabled:false, value:'', textContent:'', innerHTML:'',
    width:820, height:780, children:[], childNodes:[],
    onclick:null, onchange:null,
    click:()=>{}, appendChild:()=>{}, removeChild:()=>{},
    getBoundingClientRect:()=>({left:0,top:0,width:820,height:780,right:820,bottom:780}),
    querySelector:()=>null, querySelectorAll:()=>[],
    setAttribute:()=>{}, getAttribute:()=>'',
    focus:()=>{}, blur:()=>{},
  };
}

function createContext(seed) {
  const ctx = {
    document:{
      getElementById:()=>makeStubEl(),
      createElement:()=>makeStubEl(),
      body:makeStubEl(),
      addEventListener:()=>{},
    },
    setTimeout:(fn)=>{ try{fn();}catch(e){console.error('setTimeout err:',e.message);} return 0; },
    clearTimeout:()=>{}, setInterval:()=>0, clearInterval:()=>{},
    console,
    Math, Date, Array, Object, JSON, Map, Set, Number, String, Boolean, Symbol, Promise, RegExp, Error,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    localStorage:{getItem:()=>null, setItem:()=>{}, removeItem:()=>{}, clear:()=>{}},
    alert:()=>{}, prompt:()=>'',
  };
  ctx.window = ctx;
  ctx.global = ctx;
  ctx.addEventListener = () => {};
  ctx.removeEventListener = () => {};
  // nn.js 非ロード時のフォールバック (strong_ai.js が参照する)
  ctx._fastMode = false;
  ctx._trainingSamples = null;
  ctx.nnExtractFeatures = undefined;
  vm.createContext(ctx);
  return ctx;
}

function topLetToVar(code) {
  // 行頭 (空白後) の let/const を var に変換 (簡易: 関数内のは触らない、行頭限定)
  return code.replace(/^([ \t]*)(let|const)\s+/gm, '$1var ');
}

function loadGame(ctx, useStrong) {
  let gameCode = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
  gameCode = topLetToVar(gameCode);
  vm.runInContext(gameCode, ctx);
  if (useStrong) {
    let strongCode = fs.readFileSync(path.join(__dirname, 'strong_ai.js'), 'utf8');
    strongCode = topLetToVar(strongCode);
    vm.runInContext(strongCode, ctx);
  }
}

function runGames(N, useStrong) {
  const ctx = createContext();
  loadGame(ctx, useStrong);
  const wins = [0,0,0,0];
  let crashes = 0;
  for (let g = 0; g < N; g++) {
    try {
      vm.runInContext(`
        (function(){
          newGame();
          for (const p of state.players) p.isAI = true;
          setupStep();
          let safety = 8000;
          while (state.phase !== 'gameover' && safety-- > 0) {
            if (state.phase === 'roll') aiRollDice();
            else if (state.phase === 'main') aiMainTurn();
            else if (state.phase === 'discard') processNextDiscard();
            else if (state.phase === 'moveRobber') aiMoveRobber();
            else break;
          }
        })();
      `, ctx);
      if (ctx.state && ctx.state.winner != null) {
        wins[ctx.state.winner]++;
      } else if (g < 3) {
        console.log(`Game ${g+1}: stuck at phase=${ctx.state && ctx.state.phase}, turn=${ctx.state && ctx.state.turn}, VPs=${ctx.state && ctx.state.players.map(p=>ctx.computeVP(p)).join(',')}`);
      }
    } catch (e) {
      crashes++;
      if (crashes <= 3) console.error(`Game ${g+1} crash:`, e.message);
    }
    if ((g+1) % 50 === 0) {
      const total = wins.reduce((a,b)=>a+b,0) || 1;
      console.log(`  [${g+1}/${N}] P0:${wins[0]} P1:${wins[1]} P2:${wins[2]} P3:${wins[3]} crash:${crashes}`);
    }
  }
  return {wins, crashes, total: N};
}

const NUM_GAMES = parseInt(process.argv[2]) || 200;
const useStrong = process.argv[3] === 'strong';

console.log(`=== Catan Headless Benchmark ===`);
console.log(`Games: ${NUM_GAMES}, Mode: ${useStrong ? 'Strong AI for P0' : 'Heuristic all'}`);
console.log();
const t0 = Date.now();
const r = runGames(NUM_GAMES, useStrong);
const dt = (Date.now() - t0) / 1000;
console.log();
console.log(`=== Results (${dt.toFixed(1)}s, ${(NUM_GAMES/dt).toFixed(1)} games/s) ===`);
for (let i = 0; i < 4; i++) {
  const pct = (r.wins[i] / r.total * 100).toFixed(1);
  console.log(`  P${i}: ${r.wins[i].toString().padStart(3)} / ${r.total}  ${pct}%${i===0 && useStrong ? '  ← Strong AI' : ''}`);
}
if (r.crashes) console.log(`  Crashes: ${r.crashes}`);
