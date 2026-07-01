// ============================================================
//  Neural-Network + Lookahead Hybrid AI for Catan
//
//  References:
//   - Gendre & Kaneko (2020) "Playing Catan with Cross-dimensional Neural Network"
//     (arXiv:2008.07079) — RL agent outperformed jsettler.
//   - Settlers-RL (settlers-rl.github.io) — feature engineering & PPO self-play.
//   - Driss & Cazenave "Deep Catan" — Deep NN + MCTS surpasses MCTS alone.
//   - Cole Miller "CatAnalysis" — AlphaZero-style dual-headed NN + MCTS.
//
//  This implementation is a *pragmatic hybrid*: heuristic candidate
//  generation (method 1) + learned Value network (method 3, deep RL),
//  trained via in-browser self-play with Monte-Carlo win outcome targets.
// ============================================================

const NN_NUM_FEATURES = 82;
const NN_LR = 0.0003; // 安定化のため学習率を下げる（振動抑制）
const NN_TRAIN_EPSILON_START = 0.30; // exploration prob during training
const NN_TRAIN_EPSILON_END = 0.05;
const NN_REPLAY_CAP = 100000; // 破滅的忘却防止: 5ラウンド分の履歴を保持

let nnModel = null;
let nnReady = false;
let useNN = false;
let trainRunning = false;
let trainStop = false;
let trainStats = { games: 0, wins: [0,0,0,0], totalSamples: 0, lastLoss: null };
let _trainingSamples = null; // {playerId, features}[]
let _replayBuffer = [];
let _fastMode = false;
let _evaluatingNN = false;
let _epsilon = 0;
let evalMode = false; // 評価モード時はプレイヤー0のみNN使用
let mixedTrainMode = false; // ヒューリスティック混在モード (NN×1 + heuristic×3)

// 人間プレー模倣学習
let _humanLearnEnabled = false;
let _humanSamples = []; // {features, turn}[]

// MCTS 強化学習設定
let _mctsTrainMode = false;
let _mctsTrainRollouts = 3; // ロールアウト数 (1-20推奨)
let _mctsTrainTopK = 3;     // MCTS評価する上位K個の候補アクション
let _mctsLastTurnId = -1;   // 最後にMCTS実行したターン (同ターン内の2度目以降の呼び出しを防ぐ)
let _mctsCurrentWinRate = null; // 現在のターンのMCTS勝率
let _mctsEvalCount = 0;     // 1ゲームでのMCTS評価回数

// 各ターン毎にNNを使うかどうかを判定
function _nnEnabledForCurrentPlayer() {
  if (!nnReady) return false;
  // 評価モード/混在訓練モードでは player 0 のみNN
  if (evalMode || mixedTrainMode) return state.currentPlayer === 0;
  return useNN;
}

// Override setTimeout for fast mode (synchronous execution during training)
const _origSetTimeout = window.setTimeout;
// When non-null, callbacks are queued here instead of running synchronously
// (used by MCTS outer game loop to yield control to browser between turns)
let _mctsCallbackQueue = null;
let _insideMCTSRollout = false;
window.setTimeout = function(fn, ms) {
  if (_fastMode) {
    // Inside MCTS rollouts always run synchronously
    if (_insideMCTSRollout || _mctsCallbackQueue === null) {
      try { fn(); } catch(e) { console.error(e); }
      return 0;
    }
    // MCTS outer game: queue callback for async processing
    _mctsCallbackQueue.push(fn);
    return 0;
  }
  return _origSetTimeout.call(window, fn, ms);
};

// ============================================================
//  Network: Value head V(s) ∈ [0,1] = P(current player wins)
// ============================================================
function buildNNModel() {
  const m = tf.sequential();
  m.add(tf.layers.dense({ inputShape: [NN_NUM_FEATURES], units: 256, activation: 'relu' }));
  m.add(tf.layers.dropout({ rate: 0.1 }));
  m.add(tf.layers.dense({ units: 128, activation: 'relu' }));
  m.add(tf.layers.dense({ units: 64, activation: 'relu' }));
  m.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));
  m.compile({ optimizer: tf.train.adam(NN_LR), loss: 'meanSquaredError' });
  return m;
}

async function initNN() {
  await tf.setBackend('cpu'); // CPU is fine for tiny model, more reliable
  nnModel = buildNNModel();
  nnReady = true;
  // 保存済みの統計を復元
  try {
    const s = localStorage.getItem('catan-vnet-stats');
    if (s) {
      const obj = JSON.parse(s);
      trainStats.games = obj.games || 0;
      trainStats.wins = obj.wins || [0,0,0,0];
      trainStats.totalSamples = obj.totalSamples || 0;
      trainStats.lastLoss = obj.lastLoss || null;
    }
  } catch (e) {}
  // 保存済みの重みを読込
  try {
    const saved = await tf.loadLayersModel('localstorage://catan-vnet');
    nnModel.setWeights(saved.getWeights());
    saved.dispose();
    setStatus(`NN: 保存済みの重みを読込（累計${trainStats.games}ゲーム学習済み）`);
  } catch (e) {
    setStatus('NN: 新規初期化（未学習）');
  }
}

function setStatus(msg) {
  const el = document.getElementById('ai-status');
  if (el) el.textContent = msg;
}

// ============================================================
//  Feature Extraction (82 dims)
// ============================================================
function nnExtractFeatures(perspectivePid) {
  const f = [];
  const me = state.players[perspectivePid];
  // self resources
  f.push(me.resources.wood/10, me.resources.brick/10, me.resources.wheat/10, me.resources.sheep/10, me.resources.ore/10);
  // self status (10)
  f.push(computeVP(me)/10);
  f.push(me.settlements.length/5);
  f.push(me.cities.length/4);
  f.push(me.roads.length/15);
  f.push(me.devCards.length/5);
  f.push(me.knightsPlayed/5);
  f.push(me.hasLongestRoad ? 1 : 0);
  f.push(me.hasLargestArmy ? 1 : 0);
  f.push(me.longestRoadLen/10);
  // self production (5)
  const myProd = nnComputeProduction(me);
  for (const r of RES) f.push(myProd[r]/10);
  // self ports (6)
  const myPorts = nnGetPorts(me);
  f.push(myPorts.generic);
  for (const r of RES) f.push(myPorts[r]);
  // = 25 self

  // opponents (3 × 18 = 54)
  for (let off = 1; off < 4; off++) {
    const opId = (perspectivePid + off) % 4;
    const op = state.players[opId];
    // Hidden info: subtract opponent's VP dev cards (we don't see them)
    const opHiddenVP = op.devCards.filter(c => c.type === 'vp').length;
    f.push((computeVP(op) - opHiddenVP)/10); // visible VP
    f.push(RES.reduce((s,r)=>s+op.resources[r],0)/15);
    f.push(op.devCards.length/5);
    f.push(op.knightsPlayed/5);
    f.push(op.hasLongestRoad ? 1 : 0);
    f.push(op.hasLargestArmy ? 1 : 0);
    f.push(op.longestRoadLen/10);
    const opProd = nnComputeProduction(op);
    for (const r of RES) f.push(opProd[r]/10);
    const opPorts = nnGetPorts(op);
    f.push(opPorts.generic);
    for (const r of RES) f.push(opPorts[r]);
  }

  // global (3)
  f.push(Math.min(state.turn, 200)/200);
  f.push((state.dice[0]+state.dice[1])/12);
  let blocked = 0;
  for (const vid of me.settlements.concat(me.cities)) {
    for (const hid of state.board.vertices[vid].hexes) {
      if (state.board.hexes[hid].hasRobber) { blocked = 1; break; }
    }
    if (blocked) break;
  }
  f.push(blocked);

  return f;
}

function nnComputeProduction(p) {
  const prod = [0,0,0,0,0]; // wood,brick,wheat,sheep,ore
  const RES_IDX = {wood:0,brick:1,wheat:2,sheep:3,ore:4};
  const hexes = state.board.hexes;
  const vertices = state.board.vertices;
  const visit = (vid, mult) => {
    for (const hid of vertices[vid].hexes) {
      const h = hexes[hid];
      if (h.type === 'desert' || h.hasRobber) continue;
      prod[RES_IDX[TERRAIN_TO_RES[h.type]]] += (PROB_PIPS[h.number] || 0) * mult / 36;
    }
  };
  for (const vid of p.settlements) visit(vid, 1);
  for (const vid of p.cities) visit(vid, 2);
  return {wood:prod[0],brick:prod[1],wheat:prod[2],sheep:prod[3],ore:prod[4]};
}

function nnGetPorts(p) {
  const ports = {generic:0, wood:0, brick:0, wheat:0, sheep:0, ore:0};
  for (const vid of p.settlements.concat(p.cities)) {
    const v = state.board.vertices[vid];
    if (v.port) ports[v.port] = 1;
  }
  return ports;
}

// ============================================================
//  State snapshot / restore for action lookahead
// ============================================================
function nnSnapshot() {
  return {
    players: state.players.map(p => ({
      resources: {...p.resources},
      devCards: p.devCards.map(c => ({...c})),
      knightsPlayed: p.knightsPlayed,
      settlements: [...p.settlements],
      cities: [...p.cities],
      roads: [...p.roads],
      hasLongestRoad: p.hasLongestRoad,
      hasLargestArmy: p.hasLargestArmy,
      longestRoadLen: p.longestRoadLen,
      playedDevThisTurn: p.playedDevThisTurn
    })),
    edgeRoads: state.board.edges.map(e => e.road),
    vertexBuildings: state.board.vertices.map(v => v.building ? {...v.building} : null),
    hexRobbers: state.board.hexes.map(h => h.hasRobber),
    longestRoadOwner: state.longestRoadOwner,
    largestArmyOwner: state.largestArmyOwner
  };
}

function nnRestore(snap) {
  for (let i=0; i<state.players.length; i++) {
    const p = state.players[i];
    const ps = snap.players[i];
    p.resources = {...ps.resources};
    p.devCards = ps.devCards.map(c => ({...c}));
    p.knightsPlayed = ps.knightsPlayed;
    p.settlements = [...ps.settlements];
    p.cities = [...ps.cities];
    p.roads = [...ps.roads];
    p.hasLongestRoad = ps.hasLongestRoad;
    p.hasLargestArmy = ps.hasLargestArmy;
    p.longestRoadLen = ps.longestRoadLen;
    p.playedDevThisTurn = ps.playedDevThisTurn;
  }
  state.board.edges.forEach((e,i) => e.road = snap.edgeRoads[i]);
  state.board.vertices.forEach((v,i) => v.building = snap.vertexBuildings[i] ? {...snap.vertexBuildings[i]} : null);
  state.board.hexes.forEach((h,i) => h.hasRobber = snap.hexRobbers[i]);
  state.longestRoadOwner = snap.longestRoadOwner;
  state.largestArmyOwner = snap.largestArmyOwner;
}

// ============================================================
//  Action enumeration & application (for lookahead)
// ============================================================
function nnApplyAction(pid, action) {
  const p = state.players[pid];
  if (action.type === 'road') {
    payCost(p, COSTS.road);
    placeRoad(pid, action.eid);
  } else if (action.type === 'settlement') {
    payCost(p, COSTS.settlement);
    placeSettlement(pid, action.vid);
  } else if (action.type === 'city') {
    payCost(p, COSTS.city);
    placeCity(pid, action.vid);
  } else if (action.type === 'dev') {
    payCost(p, COSTS.dev);
    // シミュレーション用：発展カードを得たことを反映（NNが「購入=損」と誤学習しないように）
    p.devCards.push({type: 'knight', boughtTurn: state.turn, _sim: true});
  } else if (action.type === 'trade') {
    p.resources[action.give] -= getTradeRatio(p, action.give);
    p.resources[action.get]++;
  }
}

function nnEnumerateActions(pid) {
  const p = state.players[pid];
  const acts = [{type:'end_turn'}];

  // City (top 3 by heuristic)
  if (canAffordCity(p) && p.cities.length < PIECES_PER_PLAYER.city) {
    const cands = p.settlements.map(vid => ({vid, s: evaluateVertex(vid, pid)}));
    cands.sort((a,b)=>b.s-a.s);
    for (const c of cands.slice(0,3)) acts.push({type:'city', vid:c.vid});
  }
  // Settlement (top 5 by heuristic)
  if (canAffordSettlement(p) && p.settlements.length < PIECES_PER_PLAYER.settlement) {
    const cands = [];
    for (let i=0; i<state.board.vertices.length; i++) {
      if (isVertexBuildable(i, pid, false)) cands.push({vid:i, s:evaluateVertex(i, pid)});
    }
    cands.sort((a,b)=>b.s-a.s);
    for (const c of cands.slice(0,5)) acts.push({type:'settlement', vid:c.vid});
  }
  // Road (top 6 by heuristic)
  if (canAffordRoad(p) && p.roads.length < PIECES_PER_PLAYER.road) {
    const cands = [];
    for (let i=0; i<state.board.edges.length; i++) {
      if (!isEdgeBuildable(i, pid, null)) continue;
      const e = state.board.edges[i];
      let s = 0;
      for (const vid of [e.v1, e.v2]) {
        if (!state.board.vertices[vid].building) {
          let ok = true;
          for (const nv of state.board.vertices[vid].adjV) if (state.board.vertices[nv].building) { ok=false; break; }
          if (ok) s += evaluateVertex(vid, pid);
        }
      }
      cands.push({eid:i, s});
    }
    cands.sort((a,b)=>b.s-a.s);
    for (const c of cands.slice(0,6)) acts.push({type:'road', eid:c.eid});
  }
  // Buy dev
  if (canAffordDev(p) && state.devDeck.length > 0) acts.push({type:'dev'});
  // Maritime trade: 最も必要な資源上位3つへの交易のみ（20→最大15候補に削減）
  const tradeNeeds = {wood:0,brick:0,wheat:0,sheep:0,ore:0};
  for (const [,cost] of Object.entries(COSTS))
    for (const [r,n] of Object.entries(cost)) tradeNeeds[r] += Math.max(0, n - p.resources[r]);
  const wantedRes = RES.filter(r => tradeNeeds[r] > 0).sort((a,b) => tradeNeeds[b]-tradeNeeds[a]).slice(0,3);
  for (const give of RES) {
    const ratio = getTradeRatio(p, give);
    if (p.resources[give] < ratio) continue;
    for (const get of wantedRes) if (get !== give) acts.push({type:'trade', give, get});
  }
  return acts;
}

// ============================================================
//  NN-based main-turn AI
//
//  設計方針:
//   「建てるかどうか」= ヒューリスティック優先順位 (都市>開拓地>街道>発展>交易)
//   「どこに/何を建てるか」= NN の価値評価で選択
//  未学習NNでも少なくともヒューリスティック相当の強さを保証し、
//  学習が進むにつれてNN選択が改善することで勝率向上を狙う。
// ============================================================
//  MCTS-Guided NN Training (AlphaZero style)
// ============================================================
function aiMainTurnMCTS(pid) {
  // setTimeoutから引数なしで呼ばれた場合はcurrentPlayerを使用
  if (pid === undefined) pid = state.currentPlayer;
  if (state.phase !== 'main') return;
  if (checkWin()) return;

  // 全候補アクションを列挙
  const cands = nnEnumerateActions(pid).filter(a => a.type !== 'end_turn');
  if (cands.length === 0) {
    setTimeout(endTurn, _fastMode ? 0 : 300);
    return;
  }

  // NN で全候補をスコアリングし、上位K個をMCTS評価対象に絞る
  const snap = nnSnapshot();
  const feats = [];
  for (const a of cands) {
    nnApplyAction(pid, a);
    feats.push(nnExtractFeatures(pid));
    nnRestore(snap);
  }

  const nnScores = Array.from(tf.tidy(() =>
    nnModel.predict(tf.tensor2d(feats)).dataSync()
  ));

  const scoredCands = cands.map((a, i) => ({ action: a, nnScore: nnScores[i], idx: i }));
  scoredCands.sort((a, b) => b.nnScore - a.nnScore);
  const topK = scoredCands.slice(0, _mctsTrainTopK);

  // _analysisEval がない場合はNN最高スコアの行動を選ぶ
  if (typeof window._analysisEval === 'undefined') {
    nnApplyAction(pid, topK[0].action);
    const postFeats = nnExtractFeatures(pid);
    if (_trainingSamples) {
      _trainingSamples.push({ playerId: pid, features: postFeats, turn: state.turn });
    }
    if (checkWin()) return;
    setTimeout(() => aiMainTurnMCTS(pid), _fastMode ? 0 : 300);
    return;
  }

  // ─ MCTS評価: 毎アクション、上位K候補のロールアウト勝率を計測 ─
  const rolloutSnap = window._analysisEval.rolloutSnapshot();
  const seeds = window._analysisEval.generateSeeds(_mctsTrainRollouts);

  let bestAction = topK[0].action;
  let bestWinRate = -1;

  const savedFastMode = _fastMode;
  const savedUseNN = useNN;
  const savedRandom = Math.random;
  const savedSamples = _trainingSamples;

  try {
    _fastMode = true;
    _insideMCTSRollout = true;
    useNN = false;           // ロールアウト中はNNを使わない
    _trainingSamples = null; // ロールアウトのサンプルは収集しない

    for (const c of topK) {
      const result = window._analysisEval.evaluateAction(pid, c.action, _mctsTrainRollouts, rolloutSnap, seeds);
      c.mctsWinRate = result.winRate;
      if (result.winRate > bestWinRate) {
        bestWinRate = result.winRate;
        bestAction = c.action;
      }
    }
    _mctsEvalCount++;
  } finally {
    _insideMCTSRollout = false;
    _fastMode = savedFastMode;
    useNN = savedUseNN;
    Math.random = savedRandom;
    _trainingSamples = savedSamples;
    window._analysisEval.rolloutRestore(rolloutSnap);
  }

  // 最高MCTS勝率のアクションを適用し、そのMCTS勝率をラベルとして記録
  // 10ロールアウト以上なら推定精度が十分（std≈0.14）でラベルとして使える
  nnApplyAction(pid, bestAction);
  const postFeats = nnExtractFeatures(pid);

  if (_trainingSamples) {
    _trainingSamples.push({
      playerId: pid,
      features: postFeats,
      mctsLabel: bestWinRate,
      turn: state.turn
    });
  }

  if (checkWin()) return;
  // pidをクロージャで渡して次のアクションも同じプレイヤーで継続
  setTimeout(() => aiMainTurnMCTS(pid), _fastMode ? 0 : 300);
}

// NN スコアのみで続行（MCTS ラベル付き）
function _aiMainTurnNNWithMCTSLabel(pid) {
  if (state.phase !== 'main') return;
  const p = state.players[pid];
  if (!p) return;
  if (checkWin()) return;

  // dev card heuristics (省略: aiMainTurnNN と同じ)
  const knight = p.devCards.find(c => c.type === 'knight' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && knight && p.knightsPlayed >= 2 && !p.hasLargestArmy) {
    playDevCard(p, p.devCards.indexOf(knight));
    return;
  }
  // ... other dev cards ...

  // 島内交渉
  if (typeof aiPlayerTrade === 'function') {
    const tr = aiPlayerTrade(p);
    if (tr === 'pending') return;
    if (tr) { setTimeout(aiMainTurnMCTS, _fastMode ? 0 : 200); return; }
  }

  const cands = nnEnumerateActions(pid).filter(a => a.type !== 'end_turn');
  const snap = nnSnapshot();
  _evaluatingNN = true;
  const feats = [nnExtractFeatures(pid)];
  for (const a of cands) {
    nnApplyAction(pid, a);
    feats.push(nnExtractFeatures(pid));
    nnRestore(snap);
  }
  _evaluatingNN = false;

  const scores = Array.from(tf.tidy(() =>
    nnModel.predict(tf.tensor2d(feats)).dataSync()
  ));
  const endTurnVal = scores[0];

  const PRIORITY = ['city', 'settlement', 'road', 'dev', 'trade'];
  let chosenIdx = -1;
  const explore = trainRunning && !evalMode && Math.random() < _epsilon;

  for (const type of PRIORITY) {
    const group = cands
      .map((a, i) => ({a, i, s: scores[i + 1]}))
      .filter(x => x.a.type === type);
    if (group.length === 0) continue;

    if (type === 'trade') {
      const best = group.reduce((a, b) => a.s > b.s ? a : b);
      if (explore || best.s > endTurnVal) chosenIdx = best.i;
    } else {
      if (explore) {
        chosenIdx = group[Math.floor(Math.random() * group.length)].i;
      } else {
        chosenIdx = group.reduce((a, b) => a.s > b.s ? a : b).i;
      }
    }
    break;
  }

  // サンプル記録（MCTS ラベル付き）
  if (_trainingSamples) {
    const fi = chosenIdx < 0 ? 0 : chosenIdx + 1;
    _trainingSamples.push({
      playerId: pid,
      features: feats[fi],
      mctsLabel: _mctsCurrentWinRate,
      turn: state.turn
    });
  }

  if (chosenIdx < 0) {
    setTimeout(endTurn, _fastMode ? 0 : 300);
    return;
  }

  const chosen = cands[chosenIdx];
  if (chosen.type === 'dev') {
    buyDevCard(p);
  } else if (chosen.type === 'trade') {
    nnApplyAction(pid, chosen);
  } else {
    nnApplyAction(pid, chosen);
  }

  if (checkWin()) return;
  setTimeout(aiMainTurnMCTS, _fastMode ? 0 : 300);
}

// ============================================================
function aiMainTurnNN() {
  if (state.phase !== 'main') return;
  const pid = state.currentPlayer;
  const p = state.players[pid];
  if (checkWin()) return;

  // ── ヒューリスティック発展カードプレイ ──
  const knight = p.devCards.find(c => c.type === 'knight' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && knight && p.knightsPlayed >= 2 && !p.hasLargestArmy) {
    playDevCard(p, p.devCards.indexOf(knight));
    return;
  }
  const mono = p.devCards.find(c => c.type === 'monopoly' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && mono) {
    playDevCard(p, p.devCards.indexOf(mono));
    setTimeout(aiMainTurnNN, _fastMode ? 0 : 200);
    return;
  }
  const yop = p.devCards.find(c => c.type === 'year_of_plenty' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && yop && canAlmostBuild(p)) {
    playDevCard(p, p.devCards.indexOf(yop));
    setTimeout(aiMainTurnNN, _fastMode ? 0 : 200);
    return;
  }
  const rb = p.devCards.find(c => c.type === 'road_building' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && rb && p.roads.length < 13 && (computeVP(p) >= 7 || p.longestRoadLen >= 3)) {
    playDevCard(p, p.devCards.indexOf(rb));
    return;
  }

  // ── 島内交渉 (ヒューリスティック判断、NN 評価前に実行) ──
  // - AI同士: 即時成立 → リソース変化を NN 評価に反映できる
  // - P0 (人間): モーダル提示 → 応答後に AI ターン再開
  if (typeof aiPlayerTrade === 'function') {
    const tr = aiPlayerTrade(p);
    if (tr === 'pending') return; // 人間応答待ち
    if (tr) { setTimeout(aiMainTurnNN, _fastMode ? 0 : 200); return; }
  }

  // ── 全候補を1回のpredict呼び出しで評価（高速化の核心） ──
  // scores[0]=現在状態(=end_turn基準値), scores[i+1]=cands[i]適用後
  const cands = nnEnumerateActions(pid).filter(a => a.type !== 'end_turn');

  // 特徴量を一括抽出
  const snap = nnSnapshot();
  _evaluatingNN = true;
  const feats = [nnExtractFeatures(pid)]; // [0] end_turn
  for (const a of cands) {
    nnApplyAction(pid, a);
    feats.push(nnExtractFeatures(pid));
    nnRestore(snap);
  }
  _evaluatingNN = false;

  // predict 1回のみ（tf.tidy でテンソル自動解放）
  const scores = Array.from(tf.tidy(() =>
    nnModel.predict(tf.tensor2d(feats)).dataSync()
  ));
  const endTurnVal = scores[0];

  // ε-greedy インデックス選択（優先順位: 都市>開拓地>街道>発展>交易>end_turn）
  const PRIORITY = ['city', 'settlement', 'road', 'dev', 'trade'];
  let chosenIdx = -1; // -1 = end_turn

  const explore = trainRunning && !evalMode && Math.random() < _epsilon;

  for (const type of PRIORITY) {
    const group = cands
      .map((a, i) => ({a, i, s: scores[i + 1]}))
      .filter(x => x.a.type === type);
    if (group.length === 0) continue;

    if (type === 'trade') {
      // 交易は end_turn より明確に良い場合のみ実行
      const best = group.reduce((a, b) => a.s > b.s ? a : b);
      if (explore || best.s > endTurnVal) chosenIdx = best.i;
    } else {
      if (explore) {
        chosenIdx = group[Math.floor(Math.random() * group.length)].i;
      } else {
        chosenIdx = group.reduce((a, b) => a.s > b.s ? a : b).i;
      }
    }
    break;
  }

  // 学習サンプル記録
  if (_trainingSamples) {
    const fi = chosenIdx < 0 ? 0 : chosenIdx + 1;
    _trainingSamples.push({ playerId: pid, features: feats[fi], turn: state.turn });
  }

  if (chosenIdx < 0) {
    setTimeout(endTurn, _fastMode ? 0 : 300);
    return;
  }

  const chosen = cands[chosenIdx];
  const lbl = {city:'都市', settlement:'開拓地', road:'街道', dev:'発展カード', trade:'交易'}[chosen.type];
  if (chosen.type === 'dev') {
    buyDevCard(p);
    if (!_fastMode) logMsg(`${p.name}(NN)が${lbl}購入 V=${scores[chosenIdx+1].toFixed(3)}`);
  } else if (chosen.type === 'trade') {
    nnApplyAction(pid, chosen);
    if (!_fastMode) logMsg(`${p.name}(NN)が${RES_JP[chosen.give]}→${RES_JP[chosen.get]}${lbl} V=${scores[chosenIdx+1].toFixed(3)}`);
  } else {
    nnApplyAction(pid, chosen);
    if (!_fastMode) logMsg(`${p.name}(NN)が${lbl}建設 V=${scores[chosenIdx+1].toFixed(3)}`);
  }
  if (checkWin()) return;
  setTimeout(aiMainTurnNN, _fastMode ? 0 : 300);
}

// (game.js's aiMainTurn calls aiMainTurnNN() directly when useNN && nnReady)

// ============================================================
//  NN-driven Initial Setup Placement
//  - 全候補頂点で dry-run 配置 → 状態特徴を抽出 → NN で勝率推定
//  - 最高スコアの頂点に建設 (探索時は ε-greedy)
//  - 街道も同様に dry-run + NN 評価
// ============================================================
function aiSetupTurnNN() {
  const pid = state.currentPlayer;
  const phase = state.phase; // setup1 / setup2

  // 候補頂点
  const candV = [];
  for (let i = 0; i < state.board.vertices.length; i++) {
    if (isVertexBuildable(i, pid, true)) candV.push(i);
  }
  if (candV.length === 0) { state.setupIndex++; setTimeout(setupStep, 100); return; }

  // 各候補で dry-run 配置 → 特徴抽出
  const snap = nnSnapshot();
  _evaluatingNN = true;
  const feats = [];
  for (const vid of candV) {
    placeSettlement(pid, vid);
    if (phase === 'setup2') {
      const v = state.board.vertices[vid];
      for (const hid of v.hexes) {
        const hex = state.board.hexes[hid];
        if (hex.type !== 'desert') state.players[pid].resources[TERRAIN_TO_RES[hex.type]]++;
      }
    }
    feats.push(nnExtractFeatures(pid));
    nnRestore(snap);
  }
  _evaluatingNN = false;

  // NN 評価 (1 回の predict)
  const scores = Array.from(tf.tidy(() =>
    nnModel.predict(tf.tensor2d(feats)).dataSync()
  ));

  // ε-greedy: 学習中は時々探索
  const explore = trainRunning && !evalMode && Math.random() < _epsilon;
  let bestIdx;
  if (explore) {
    bestIdx = Math.floor(Math.random() * candV.length);
  } else {
    bestIdx = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i;
  }

  const bestV = candV[bestIdx];
  if (_trainingSamples) {
    _trainingSamples.push({ playerId: pid, features: feats[bestIdx], turn: 0 });
  }

  setupPlaceSettlement(bestV);

  // 街道配置 (隣接エッジを NN 評価)
  setTimeout(() => {
    const v = state.board.vertices[bestV];
    const candE = [];
    for (const eid of v.edges) {
      if (isEdgeBuildable(eid, pid, bestV)) candE.push(eid);
    }
    if (candE.length === 0) {
      state.setupIndex++;
      setTimeout(setupStep, 100);
      return;
    }
    if (candE.length === 1) {
      setupPlaceRoad(candE[0]);
      return;
    }

    const snap2 = nnSnapshot();
    _evaluatingNN = true;
    const efeats = [];
    for (const eid of candE) {
      placeRoad(pid, eid);
      efeats.push(nnExtractFeatures(pid));
      nnRestore(snap2);
    }
    _evaluatingNN = false;
    const escores = Array.from(tf.tidy(() =>
      nnModel.predict(tf.tensor2d(efeats)).dataSync()
    ));
    const eExplore = trainRunning && !evalMode && Math.random() < _epsilon;
    let bestEIdx;
    if (eExplore) {
      bestEIdx = Math.floor(Math.random() * candE.length);
    } else {
      bestEIdx = 0;
      for (let i = 1; i < escores.length; i++) if (escores[i] > escores[bestEIdx]) bestEIdx = i;
    }
    if (_trainingSamples) {
      _trainingSamples.push({ playerId: pid, features: efeats[bestEIdx], turn: 0 });
    }
    setupPlaceRoad(candE[bestEIdx]);
  }, _fastMode ? 0 : 100);
}

// ============================================================
//  NN-driven Robber Placement
//  - 自分のタイル以外の全候補で dry-run → 特徴抽出 → 勝率推定
//  - 最善タイルに移動 (人質も VP高い相手を優先 — 既存ロジック)
// ============================================================
function aiMoveRobberNN() {
  const pid = state.currentPlayer;
  const currentRobberHid = state.board.hexes.findIndex(h => h.hasRobber);

  const candH = [];
  for (let h = 0; h < state.board.hexes.length; h++) {
    if (state.board.hexes[h].hasRobber) continue;
    // 自分のタイルは除外
    let touchesUs = false;
    for (const vid of state.board.hexes[h].vertices) {
      const v = state.board.vertices[vid];
      if (v.building && v.building.player === pid) { touchesUs = true; break; }
    }
    if (touchesUs) continue;
    candH.push(h);
  }
  if (candH.length === 0) {
    // フォールバック: 砂漠を含む適当なタイル
    for (const hex of state.board.hexes) if (!hex.hasRobber) { candH.push(hex.id); break; }
  }
  if (candH.length === 0) {
    if (typeof finishRobber === 'function') finishRobber();
    return;
  }

  // dry-run: robber を一時的に移動 → 特徴抽出 → 戻す
  _evaluatingNN = true;
  const feats = [];
  if (currentRobberHid >= 0) state.board.hexes[currentRobberHid].hasRobber = false;
  for (const hid of candH) {
    state.board.hexes[hid].hasRobber = true;
    feats.push(nnExtractFeatures(pid));
    state.board.hexes[hid].hasRobber = false;
  }
  if (currentRobberHid >= 0) state.board.hexes[currentRobberHid].hasRobber = true;
  _evaluatingNN = false;

  const scores = Array.from(tf.tidy(() =>
    nnModel.predict(tf.tensor2d(feats)).dataSync()
  ));
  const explore = trainRunning && !evalMode && Math.random() < _epsilon;
  let bestIdx;
  if (explore) {
    bestIdx = Math.floor(Math.random() * candH.length);
  } else {
    bestIdx = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i;
  }
  if (_trainingSamples) {
    _trainingSamples.push({ playerId: pid, features: feats[bestIdx], turn: state.turn });
  }
  moveRobberTo(candH[bestIdx]);
}

// ============================================================
//  Self-play training
// ============================================================
function playSelfPlayGame(collectSamples = true) {
  _fastMode = true;
  _trainingSamples = collectSamples ? [] : null;

  // モード別: 評価/混在訓練 = player 0のみNN、通常訓練 = 全員NN
  const useNNBackup = useNN;
  if (!evalMode && !mixedTrainMode) useNN = true;

  newGame();
  for (const p of state.players) p.isAI = true;

  // Run setup (synchronous via setupStep chain)
  setupStep();

  // Run main game until end or timeout
  let safety = 2000;
  while (state.phase !== 'gameover' && safety-- > 0) {
    if (state.phase === 'roll') aiRollDice();
    else if (state.phase === 'main') aiMainTurn();
    else if (state.phase === 'discard') processNextDiscard();
    else if (state.phase === 'moveRobber') aiMoveRobber();
    else if (state.phase === 'steal') break; // handled inline
    else break;
  }

  _fastMode = false;
  useNN = useNNBackup;
  const winner = state.winner;
  const samples = _trainingSamples;
  _trainingSamples = null;

  // Restore human player flag
  if (state.players[0]) state.players[0].isAI = false;

  const finalVPs = state.players.map(p => computeVP(p));
  const winnerVP = winner != null ? finalVPs[winner] : Math.max(...finalVPs);

  // MCTS 訓練モード: MCTS 推定勝率を直接ラベルとして使用 (AlphaZero style)
  // 混在訓練 (mixedTrainMode): 相対VPラベル = 自分VP ÷ 勝者VP
  //   負けゲームでも「8VP/10VP=0.8」という勾配が出る
  // 純粋自己対戦: 勝者=1.0, 他=0.0 (25%陽性でバランス良好)
  return {
    winner,
    samples: samples ? samples.map(s => {
      let label;
      if (s.mctsLabel !== undefined) {
        // MCTS で計算された勝率を使用
        label = s.mctsLabel;
      } else if (mixedTrainMode) {
        label = Math.min(1.0, finalVPs[s.playerId] / Math.max(winnerVP, 1));
      } else {
        label = (s.playerId === winner ? 1.0 : 0.0);
      }
      return { features: s.features, label };
    }) : []
  };
}

// ============================================================
//  Evaluation: NN player(0) vs Heuristic players(1-3) for N games
// ============================================================
async function startEvaluation(numGames) {
  if (trainRunning || !nnReady) return;
  trainRunning = true;
  trainStop = false;
  evalMode = true;
  document.getElementById('btn-train').disabled = true;
  document.getElementById('btn-eval').disabled = true;
  document.getElementById('btn-train-stop').disabled = false;
  document.getElementById('btn-save-weights').disabled = true;
  document.getElementById('btn-load-weights').disabled = true;
  document.getElementById('btn-reset-weights').disabled = true;
  setStatus(strongModeEnabled ? '評価中: 強力AI(P0) vs ヒューリスティック(P1-3)' : '評価中: NN(P0) vs ヒューリスティック(P1-3)');

  const wins = [0, 0, 0, 0];
  const t0 = Date.now();
  let played = 0;

  try {
    for (let g = 0; g < numGames && !trainStop; g++) {
      let result;
      try {
        result = playSelfPlayGame(false); // sample収集なし
      } catch (e) {
        console.error('eval error', e);
        _fastMode = false;
        continue;
      }
      if (result.winner != null) {
        wins[result.winner]++;
        played++;
      }
      const elapsed = (Date.now()-t0)/1000;
      const rate = (g+1)/elapsed;
      const nnRate = played > 0 ? (wins[0]/played*100).toFixed(1) : '-';
      const el = document.getElementById('train-progress');
      if (el) el.textContent = `評価 ${g+1}/${numGames} (${rate.toFixed(1)}/秒) | NN勝率(P0): ${nnRate}% | wins: ${wins.join('/')}`;
      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }

    const nnRate = played > 0 ? (wins[0]/played*100).toFixed(1) : 0;
    const finalMsg = `評価結果: ${played}ゲーム / NN勝率 ${nnRate}% / 内訳 NN:${wins[0]} H1:${wins[1]} H2:${wins[2]} H3:${wins[3]} (期待値25%が平均)`;
    setStatus(finalMsg);
    if (!trainStop) {
      showModal('評価結果', `<div style="line-height:1.6">
        <div>合計 <b>${played}</b> ゲーム</div>
        <div><b>NN AI (Player 0) の勝率: ${nnRate}%</b></div>
        <div style="margin-top:8px">プレイヤー別勝利数:</div>
        <ul>
          <li>NN AI: ${wins[0]} 勝</li>
          <li>ヒューリスティック1: ${wins[1]} 勝</li>
          <li>ヒューリスティック2: ${wins[2]} 勝</li>
          <li>ヒューリスティック3: ${wins[3]} 勝</li>
        </ul>
        <div style="margin-top:8px;color:#8fa">ランダム同等なら25%、25%超なら学習が効いている証拠</div>
      </div>`, '<button onclick="hideModal()">閉じる</button>');
    }
  } catch (e) {
    console.error('eval error', e);
    setStatus('評価エラー: ' + e.message);
  } finally {
    evalMode = false;
    trainRunning = false;
    _fastMode = false;
    _evaluatingNN = false;
    document.getElementById('btn-train').disabled = false;
    document.getElementById('btn-eval').disabled = false;
    document.getElementById('btn-train-stop').disabled = true;
    document.getElementById('btn-save-weights').disabled = false;
    document.getElementById('btn-load-weights').disabled = false;
    document.getElementById('btn-reset-weights').disabled = false;
  }

  if (typeof hideModal === 'function') {
    // 評価結果モーダルは残す。学習中の勝利モーダルだけ閉じたい場合の保険はなし
  }
  newGame();
  updateUI();
  setupStep();
}

async function trainStep() {
  if (_replayBuffer.length < 32) return;
  const buf = _replayBuffer;
  const N = Math.min(buf.length, 1024);

  // 勝者サンプル(label=1.0)を別プールに分離して3倍過剰サンプリング（O(buffer)で高速）
  const winners = [];
  const others  = [];
  for (let i = 0; i < buf.length; i++) {
    (buf[i].label >= 1.0 ? winners : others).push(i);
  }
  const idx = [];
  const winSlots = Math.min(Math.floor(N * 0.4), winners.length * 3); // 勝者枠40%上限
  for (let k = 0; k < winSlots && winners.length > 0; k++)
    idx.push(winners[Math.floor(Math.random() * winners.length)]);
  while (idx.length < N)
    idx.push(others.length > 0
      ? others[Math.floor(Math.random() * others.length)]
      : Math.floor(Math.random() * buf.length));

  const xs = tf.tensor2d(idx.map(i => buf[i].features));
  const ys = tf.tensor2d(idx.map(i => [buf[i].label]));
  const h = await nnModel.fit(xs, ys, { epochs: 2, batchSize: 256, verbose: 0 }); // バッファ増大に合わせてbatchSize拡大、epoch削減
  xs.dispose(); ys.dispose();
  trainStats.lastLoss = h.history.loss[h.history.loss.length - 1];
}

async function startTraining(numGames) {
  if (trainRunning || !nnReady) return;
  trainRunning = true;
  trainStop = false;
  document.getElementById('btn-train').disabled = true;
  document.getElementById('btn-train-stop').disabled = false;
  document.getElementById('btn-save-weights').disabled = true;
  document.getElementById('btn-load-weights').disabled = true;
  document.getElementById('btn-reset-weights').disabled = true;
  const trainLabel = mixedTrainMode ? '🔀 混在学習 (NN×1+H×3)' : '🤖 自己対戦学習';
  setStatus(mixedTrainMode ? '学習中（混在: NN×1+H×3）' : '学習中（自己対戦）');
  showTrainBanner(trainLabel, numGames);

  const startGames = trainStats.games;
  const t0 = Date.now();

  try {
    for (let g = 0; g < numGames && !trainStop; g++) {
      _epsilon = NN_TRAIN_EPSILON_START + (NN_TRAIN_EPSILON_END - NN_TRAIN_EPSILON_START)
               * Math.min(1, trainStats.games / 500);
      let result;
      try {
        result = playSelfPlayGame();
      } catch (e) {
        console.error('self-play error', e);
        _fastMode = false; // force reset in case of error mid-game
        _evaluatingNN = false;
        continue;
      }
      if (result.winner != null) {
        trainStats.games++;
        trainStats.wins[result.winner]++;
      }
      trainStats.totalSamples += result.samples.length;
      _replayBuffer.push(...result.samples);
      if (_replayBuffer.length > NN_REPLAY_CAP) {
        _replayBuffer.splice(0, _replayBuffer.length - NN_REPLAY_CAP);
      }

      // Train every game
      await trainStep();

      // 20ゲームごとに自動保存（途中停止/クラッシュでも消えない）
      if ((g+1) % 20 === 0) {
        const ok = await autoSaveSilent();
        if (!ok) console.warn('periodic auto-save failed at game', g+1);
      }

      updateTrainProgress(g+1, numGames, startGames, t0);
      const winPct = trainStats.games > 0
        ? trainStats.wins.map((w,i) => `P${i}:${(w/trainStats.games*100).toFixed(0)}%`).join(' ')
        : '-';
      updateTrainBanner(g+1, numGames, t0, null,
        `loss=${trainStats.lastLoss?.toFixed(4)??'-'} | ${winPct}`);
      // Yield to browser every game so save/stop buttons can fire
      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }

    // Final train pass
    try { await trainStep(); } catch (e) { console.error('final train error', e); }
  } catch (e) {
    console.error('training error', e);
    setStatus('学習エラー: ' + e.message);
  }

  hideTrainBanner();

  // 最終自動保存（必ず実行: try/catch関係なく）
  const saveOK = await autoSaveSilent();
  if (saveOK) {
    setStatus(`学習完了+自動保存: 累計${trainStats.games}ゲーム, loss=${trainStats.lastLoss?.toFixed(4)}`);
  } else {
    setStatus(`学習完了(保存失敗・手動「保存」を試して): 累計${trainStats.games}ゲーム`);
  }

  trainRunning = false;
  _fastMode = false;
  _evaluatingNN = false;
  document.getElementById('btn-train').disabled = false;
  document.getElementById('btn-train-stop').disabled = true;
  document.getElementById('btn-save-weights').disabled = false;
  document.getElementById('btn-load-weights').disabled = false;
  document.getElementById('btn-reset-weights').disabled = false;

  // 念のためモーダルを閉じる（学習中の勝利モーダルが残っている場合の保険）
  if (typeof hideModal === 'function') hideModal();
  // Start a fresh visible game
  newGame();
  updateUI();
  setupStep();
}

// ============================================================
//  MCTS 用非同期ゲームループ（コールバックキュー方式でフリーズ防止）
// ============================================================
async function playSelfPlayGameMCTSAsync() {
  _trainingSamples = [];
  const useNNBackup = useNN;
  const mixedBackup = mixedTrainMode;
  const evalBackup = evalMode;

  // MCTS学習では全プレイヤーがMCTSを使う
  // mixedTrainMode=true のままだと P0 しか NN を使わず、P0 が序盤に資源なしで
  // 毎回即ターン終了 → MCTS 0 回問題が発生するため強制オーバーライド
  useNN = true;
  mixedTrainMode = false;
  evalMode = false;

  // キューモード有効化: コールバックを同期実行せずキューに積む
  _mctsCallbackQueue = [];
  _fastMode = true;

  newGame();
  for (const p of state.players) p.isAI = true;

  // セットアップは高速なので同期実行
  setupStep();
  while (_mctsCallbackQueue.length > 0) {
    const cb = _mctsCallbackQueue.shift();
    try { cb(); } catch(e) { console.error(e); }
  }

  // 最初のターンをキックオフ
  if (state.phase !== 'gameover') {
    if (state.phase === 'roll') aiRollDice();
    else if (state.phase === 'discard') processNextDiscard();
    else if (state.phase === 'moveRobber') aiMoveRobber();
  }

  // MCTS 評価を含むコールバックは同期実行後にブラウザへ制御を返す
  // ただし毎回 await すると遅くなるため N コールバックごとに1回 yield
  const YIELD_EVERY = 5;
  const EST_CBS_PER_GAME = 600;
  let safety = 20000;
  let cbCount = 0;
  const gameStartMs = Date.now();
  const GAME_TIMEOUT_MS = 3 * 60 * 1000; // 3分でゲームを強制終了（フリーズ防止）
  while (safety-- > 0) {
    if (state.phase === 'gameover') break;

    // フリーズ防止: 3分以上かかったらゲームを強制終了
    if (Date.now() - gameStartMs > GAME_TIMEOUT_MS) {
      console.warn('MCTSゲームタイムアウト: 強制終了');
      break;
    }

    if (_mctsCallbackQueue.length === 0) {
      if (state.phase === 'roll') aiRollDice();
      else if (state.phase === 'discard') processNextDiscard();
      else if (state.phase === 'moveRobber') aiMoveRobber();
      else break;
    }

    if (_mctsCallbackQueue.length === 0) break;

    const cb = _mctsCallbackQueue.shift();
    try { cb(); } catch(e) { console.error(e); }
    cbCount++;

    // ターンバー更新＋定期 yield（MCTSコールバックは重いので毎回ではなく N 回に 1 回）
    if (cbCount % YIELD_EVERY === 0) {
      updateTrainBannerTurn(Math.round(cbCount / EST_CBS_PER_GAME * 100));
      const evalLbl = document.getElementById('mcts-eval-label');
      if (evalLbl) evalLbl.textContent = `MCTS評価: ${_mctsEvalCount}回`;
      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }
  }

  // クリーンアップ
  _fastMode = false;
  _mctsCallbackQueue = null;
  useNN = useNNBackup;
  mixedTrainMode = mixedBackup;
  evalMode = evalBackup;
  if (state.players[0]) state.players[0].isAI = false;

  const winner = state.winner;
  const samples = _trainingSamples;
  _trainingSamples = null;

  return {
    winner,
    samples: (samples || []).map(s => ({
      features: s.features,
      // 10ロールアウトのMCTS勝率ラベルを使用（精度十分）。
      // MCTSは行動選択のみに使用。ラベルは実際の勝敗（0/1）を使う。
      // AlphaZero方式: MCTS→良い行動を探索、勝敗→明確なラベル信号
      label: (s.playerId === winner ? 1.0 : 0.0)
    }))
  };

}

// ============================================================
//  MCTS-Enhanced Training (AlphaZero style)
// ============================================================
async function startMCTSTraining(numGames, rollouts = 3) {
  if (trainRunning || !nnReady) return;
  if (typeof window._analysisEval === 'undefined') {
    alert('analysis.js が読み込まれていません');
    return;
  }

  trainRunning = true;
  trainStop = false;
  _mctsTrainMode = true;
  _mctsTrainRollouts = Math.max(1, Math.min(20, rollouts));

  document.getElementById('btn-train').disabled = true;
  document.getElementById('btn-train-stop').disabled = false;
  document.getElementById('btn-save-weights').disabled = true;
  document.getElementById('btn-load-weights').disabled = true;
  document.getElementById('btn-reset-weights').disabled = true;
  setStatus(`MCTS学習中（${_mctsTrainRollouts}ロールアウト）`);

  // 進捗バナーを表示・初期化
  showTrainBanner(`🤖 MCTS学習 (${_mctsTrainRollouts}ロールアウト)`, numGames);

  const startGames = trainStats.games;
  const t0 = Date.now();

  try {
    for (let g = 0; g < numGames && !trainStop; g++) {
      _epsilon = NN_TRAIN_EPSILON_START + (NN_TRAIN_EPSILON_END - NN_TRAIN_EPSILON_START)
               * Math.min(1, trainStats.games / 500);
      _mctsLastTurnId = -1;
      _mctsCurrentWinRate = null;
      _mctsEvalCount = 0;

      updateTrainBanner(g, numGames, t0, `ゲーム ${g+1}/${numGames} 進行中...`, null);

      let result;
      try {
        result = await playSelfPlayGameMCTSAsync(); // 非同期版でフリーズ防止
      } catch (e) {
        console.error('MCTS training error', e);
        _fastMode = false;
        _evaluatingNN = false;
        _mctsTrainMode = false;
        continue;
      }

      if (result.winner != null) {
        trainStats.games++;
        trainStats.wins[result.winner]++;
      }
      trainStats.totalSamples += result.samples.length;
      _replayBuffer.push(...result.samples);
      if (_replayBuffer.length > NN_REPLAY_CAP) {
        _replayBuffer.splice(0, _replayBuffer.length - NN_REPLAY_CAP);
      }

      const mctsLabels = result.samples.filter(s => s.label > 0 && s.label < 1).length;
      console.log(`MCTS game ${g+1}: ${_mctsEvalCount}回MCTS評価, ${result.samples.length}サンプル, うちMCTSラベル${mctsLabels}個`);

      await trainStep();

      if ((g + 1) % 5 === 0) {
        const ok = await autoSaveSilent();
        if (!ok) console.warn('MCTS auto-save failed at game', g+1);
      }

      updateTrainProgress(g+1, numGames, startGames, t0);
      const detailStr = `MCTSラベル${mctsLabels}/${result.samples.length} | MCTS評価${_mctsEvalCount}回 | loss=${trainStats.lastLoss?.toFixed(4)??'-'}`;
      updateTrainBanner(g+1, numGames, t0, null, detailStr);

      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }

    try { await trainStep(); } catch (e) { console.error('final MCTS train error', e); }
  } catch (e) {
    console.error('MCTS training error', e);
    setStatus('MCTS学習エラー: ' + e.message);
  }

  hideTrainBanner();

  const saveOK = await autoSaveSilent();
  if (saveOK) {
    setStatus(`MCTS学習完了: 累計${trainStats.games}ゲーム, loss=${trainStats.lastLoss?.toFixed(4)}`);
  } else {
    setStatus(`MCTS学習完了(保存失敗): 累計${trainStats.games}ゲーム`);
  }

  trainRunning = false;
  _fastMode = false;
  _evaluatingNN = false;
  _mctsTrainMode = false;
  _mctsLastTurnId = -1;
  _mctsCurrentWinRate = null;

  document.getElementById('btn-train').disabled = false;
  document.getElementById('btn-train-stop').disabled = true;
  document.getElementById('btn-save-weights').disabled = false;
  document.getElementById('btn-load-weights').disabled = false;
  document.getElementById('btn-reset-weights').disabled = false;

  if (typeof hideModal === 'function') hideModal();
  newGame();
  updateUI();
  setupStep();
}

// ──── 学習進捗バナー ────
function showTrainBanner(title, total) {
  const el = document.getElementById('train-banner');
  if (!el) return;
  el.classList.remove('hidden');
  const lbl = document.getElementById('train-banner-label');
  const bar = document.getElementById('train-banner-bar');
  const game = document.getElementById('train-banner-game');
  const eta = document.getElementById('train-banner-eta');
  const detail = document.getElementById('train-banner-detail');
  const tbar = document.getElementById('train-banner-turn-bar');
  if (lbl) lbl.textContent = title;
  if (bar) bar.style.width = '0%';
  if (game) game.textContent = `0/${total}ゲーム`;
  if (eta) eta.textContent = '残り: 計算中...';
  if (detail) detail.textContent = '';
  if (tbar) tbar.style.width = '0%';
}
function updateTrainBanner(g, total, t0, gameLabel, detail) {
  const pct = total > 0 ? Math.round(g / total * 100) : 0;
  const elapsed = (Date.now() - t0) / 1000;
  const etaSec = g > 0 && g < total ? Math.round(elapsed / g * (total - g)) : 0;
  const etaStr = g >= total ? '完了' : etaSec > 0 ? `残り 約${etaSec < 60 ? etaSec + '秒' : Math.ceil(etaSec/60) + '分'}` : '計算中...';
  const bar = document.getElementById('train-banner-bar');
  const game = document.getElementById('train-banner-game');
  const eta = document.getElementById('train-banner-eta');
  const det = document.getElementById('train-banner-detail');
  if (bar) bar.style.width = pct + '%';
  if (game) game.textContent = gameLabel || `${g}/${total}ゲーム`;
  if (eta) eta.textContent = etaStr;
  if (det && detail !== null) det.textContent = detail;
}
function updateTrainBannerTurn(pct) {
  const tbar = document.getElementById('train-banner-turn-bar');
  if (tbar) tbar.style.width = Math.min(99, pct) + '%';
}
function hideTrainBanner() {
  const el = document.getElementById('train-banner');
  if (el) el.classList.add('hidden');
}

function updateTrainProgress(g, total, startGames, t0) {
  const elapsed = (Date.now() - t0) / 1000;
  const rate = g / elapsed;
  const sessionGames = trainStats.games - startGames;
  const winRate = trainStats.games > 0
    ? trainStats.wins.map((w,i)=>`P${i}:${(w/trainStats.games*100).toFixed(0)}%`).join(' ')
    : '-';
  const el = document.getElementById('train-progress');
  if (el) el.textContent =
    `${g}/${total}局 (${rate.toFixed(1)}/秒, 今回+${sessionGames}, 累計${trainStats.games}) loss=${trainStats.lastLoss?.toFixed(4) ?? '-'} | ${winRate}`;
}

// ============================================================
//  Save / Load / Reset weights
// ============================================================
async function _doSave() {
  await nnModel.save('localstorage://catan-vnet');
  localStorage.setItem('catan-vnet-stats', JSON.stringify({
    games: trainStats.games,
    wins: trainStats.wins,
    totalSamples: trainStats.totalSamples,
    lastLoss: trainStats.lastLoss,
    savedAt: new Date().toISOString()
  }));
}
async function autoSaveSilent() {
  if (!nnReady || !nnModel) return false;
  try { await _doSave(); return true; } catch (e) { console.error('save error', e); return false; }
}
async function saveWeights() {
  if (!nnReady) return;
  try {
    await _doSave();
    setStatus(`重み保存OK (累計${trainStats.games}ゲーム)`);
  } catch (e) { setStatus('保存失敗: ' + e.message); }
}
async function loadWeights() {
  if (!nnReady) return;
  try {
    const saved = await tf.loadLayersModel('localstorage://catan-vnet');
    nnModel.setWeights(saved.getWeights());
    saved.dispose();
    const s = localStorage.getItem('catan-vnet-stats');
    if (s) {
      const obj = JSON.parse(s);
      trainStats.games = obj.games || 0;
      trainStats.wins = obj.wins || [0,0,0,0];
      trainStats.totalSamples = obj.totalSamples || 0;
      trainStats.lastLoss = obj.lastLoss || null;
    }
    setStatus(`重み読込OK (累計${trainStats.games}ゲーム)`);
  } catch (e) { setStatus('読込失敗: ' + e.message); }
}
// ============================================================
//  ローカルファイル保存（ブラウザのダウンロード/アップロード）
// ============================================================
function _downloadBlob(filename, blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    // 少し待ってからクリーンアップ（ブラウザがダウンロードを認識する時間を確保）
    _origSetTimeout.call(window, () => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      resolve();
    }, 300);
  });
}

async function exportToFile() {
  if (!nnReady) return;
  setStatus('ファイル出力中...');
  try {
    // モデルの重みを ArrayBuffer として取得
    await nnModel.save(tf.io.withSaveHandler(async artifacts => {
      // model.json をダウンロード
      const modelJson = {
        modelTopology: artifacts.modelTopology,
        weightsManifest: [{
          paths: ['catan-vnet.weights.bin'],
          weights: artifacts.weightSpecs
        }],
        format: artifacts.format,
        generatedBy: artifacts.generatedBy,
        convertedBy: artifacts.convertedBy
      };
      await _downloadBlob('catan-vnet.json',
        new Blob([JSON.stringify(modelJson)], {type: 'application/json'}));

      // weights.bin をダウンロード
      await _downloadBlob('catan-vnet.weights.bin',
        new Blob([artifacts.weightData], {type: 'application/octet-stream'}));

      // stats.json をダウンロード
      await _downloadBlob('catan-vnet-stats.json',
        new Blob([JSON.stringify({
          games: trainStats.games,
          wins: trainStats.wins,
          totalSamples: trainStats.totalSamples,
          lastLoss: trainStats.lastLoss,
          savedAt: new Date().toISOString()
        }, null, 2)], {type: 'application/json'}));

      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
    }));

    setStatus('ファイル出力OK: catan-vnet.json + catan-vnet.weights.bin + catan-vnet-stats.json (3ファイル)');
  } catch (e) {
    setStatus('ファイル出力失敗: ' + e.message);
    console.error(e);
  }
}

function importFromFile() {
  if (!nnReady) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.json,.bin';
  input.onchange = async (e) => {
    const files = [...e.target.files];
    if (files.length === 0) return;

    // ファイル名を表示してデバッグしやすくする
    const names = files.map(f => f.name).join(', ');

    // 検出: .json かつ stats でないもの → model.json
    const modelJson = files.find(f =>
      f.name.toLowerCase().endsWith('.json') && !f.name.toLowerCase().includes('stats'));
    // 検出: .bin ならどれでも → weights.bin
    const weightsBin = files.find(f => f.name.toLowerCase().endsWith('.bin'));
    // 検出: stats を含む .json → stats.json
    const statsFile = files.find(f =>
      f.name.toLowerCase().includes('stats') && f.name.toLowerCase().endsWith('.json'));

    if (!modelJson || !weightsBin) {
      const missing = [];
      if (!modelJson) missing.push('model.json (catan-vnet.json)');
      if (!weightsBin) missing.push('weights.bin (catan-vnet.weights.bin)');
      setStatus(`読込失敗: 不足ファイル → ${missing.join(', ')} | 選択されたファイル: ${names}`);
      return;
    }

    setStatus(`読込中... (${names})`);
    try {
      const newModel = await tf.loadLayersModel(tf.io.browserFiles([modelJson, weightsBin]));
      nnModel.setWeights(newModel.getWeights());
      newModel.dispose();
      if (statsFile) {
        const text = await statsFile.text();
        const obj = JSON.parse(text);
        trainStats.games = obj.games || 0;
        trainStats.wins = obj.wins || [0,0,0,0];
        trainStats.totalSamples = obj.totalSamples || 0;
        trainStats.lastLoss = obj.lastLoss || null;
      }
      await autoSaveSilent();
      setStatus(`読込OK: ${modelJson.name} + ${weightsBin.name}${statsFile ? ' + stats' : ' (統計なし)'} / 累計${trainStats.games}ゲーム`);
    } catch (err) {
      setStatus(`読込失敗: ${err.message} | ファイル: ${names}`);
    }
  };
  input.click();
}

async function resetWeights() {
  if (!nnReady) return;
  nnModel.dispose();
  nnModel = buildNNModel();
  _replayBuffer = [];
  trainStats = { games: 0, wins: [0,0,0,0], totalSamples: 0, lastLoss: null };
  try {
    localStorage.removeItem('catan-vnet-stats');
    // tf.js localStorage の重みも削除
    try { await tf.io.removeModel('localstorage://catan-vnet'); } catch (e) {}
    // 新規モデルを保存（次回ロード時は空の重みが入る）
    await _doSave();
  } catch (e) {}
  setStatus('重み初期化完了（保存済み）');
}

// ============================================================
//  人間プレー模倣学習
// ============================================================

// 人間が行動するたびに呼び出す（game.js から参照）
function nnRecordHumanAction() {
  if (!nnReady || !_humanLearnEnabled || trainRunning) return;
  if (state.currentPlayer !== 0 || state.phase !== 'main') return;
  _humanSamples.push({ features: nnExtractFeatures(0), turn: state.turn });
}

// ゲーム開始時にサンプルをリセット（game.js の newGame から呼ぶ）
function nnOnNewGame() {
  _humanSamples = [];
  _updateHumanLearnStatus();
}

// ゲーム終了時にサンプルをバッファへ追加（game.js の checkWin から呼ぶ）
function nnOnGameEnd(humanWon) {
  if (!_humanLearnEnabled || _humanSamples.length === 0) return;
  const finalVP = computeVP(state.players[0]);
  // 勝利=1.0, 敗北=自分VP÷勝者VP の相対ラベル
  const winnerVP = state.winner != null ? computeVP(state.players[state.winner]) : finalVP;
  const label = humanWon ? 1.0 : Math.min(0.9, finalVP / Math.max(winnerVP, 1));
  const newSamples = _humanSamples.map(s => ({ features: s.features, label }));
  _replayBuffer.push(...newSamples);
  if (_replayBuffer.length > NN_REPLAY_CAP)
    _replayBuffer.splice(0, _replayBuffer.length - NN_REPLAY_CAP);
  trainStats.totalSamples += newSamples.length;
  _humanSamples = [];
  const result = humanWon ? '勝利🎉' : `敗北(VP:${finalVP})`;
  setStatus(`人間プレー学習: ${newSamples.length}サンプル追加(${result}) | バッファ${_replayBuffer.length}件 → 「学習」ボタンで反映`);
  _updateHumanLearnStatus();
}

function _updateHumanLearnStatus() {
  const el = document.getElementById('human-learn-status');
  if (el) el.textContent = _humanLearnEnabled
    ? `記録中... ${_humanSamples.length}手 / バッファ${_replayBuffer.length}件`
    : '';
}

// ============================================================
//  ヒューリスティック事前学習
//  ヒューリスティックAI同士の対戦データからNNを初期化する。
//  ランダム初期化より大幅に良いスタート地点を作れる。
// ============================================================
// ============================================================
//  強力AI蒸留事前学習
//  strongModeEnabled=true の P0 の対戦データを NN に教え込む。
//  弱いヒューリスティックからスタートするより大幅に良い起点が得られる。
// ============================================================
async function preTrainFromStrongAI(numGames, trainEpochs, _calledFromAutoTrain = false) {
  if (trainRunning || !nnReady) return;
  trainRunning = true;
  trainStop = false;

  if (!_calledFromAutoTrain) {
    ['btn-train','btn-eval','btn-auto-train','btn-pretrain','btn-reset-weights',
     'btn-save-weights','btn-load-weights'].forEach(id => {
      try { document.getElementById(id).disabled = true; } catch(_){}
    });
    try { document.getElementById('btn-train-stop').disabled = false; } catch(_){}
  }

  showTrainBanner(`💪 強力AI蒸留 (${numGames}G × ${trainEpochs}ep)`, numGames);

  // 重みをリセット（クリーンスタート）
  nnModel.dispose();
  nnModel = buildNNModel();
  trainStats = { games: 0, wins: [0,0,0,0], totalSamples: 0, lastLoss: null };
  _replayBuffer = [];

  setStatus('強力AI蒸留: P0(強力AI)の対戦データ収集中...');

  const savedUseNN = useNN;
  const savedMixed = mixedTrainMode;
  // strongModeEnabled は外部変数なので参照だけ（変更しない。P0は常にstrong）
  useNN = false;
  mixedTrainMode = false;

  const preBuf = [];
  const t0 = Date.now();

  for (let g = 0; g < numGames && !trainStop; g++) {
    _fastMode = true;
    _trainingSamples = [];

    newGame();
    for (const p of state.players) p.isAI = true;
    setupStep();

    let safety = 3000;
    while (state.phase !== 'gameover' && safety-- > 0) {
      if      (state.phase === 'roll')       aiRollDice();
      else if (state.phase === 'main')       aiMainTurn();
      else if (state.phase === 'discard')    processNextDiscard();
      else if (state.phase === 'moveRobber') aiMoveRobber();
      else break;
    }

    _fastMode = false;
    if (state.players[0]) state.players[0].isAI = false;

    const winner = state.winner;
    const finalVPs = state.players.map(p => computeVP(p));
    const winnerVP = winner != null ? finalVPs[winner] : Math.max(...finalVPs);

    // 4人全員のサンプルを収集（P1-3も含めることでラベルが[0.5-1.0]に広がり学習信号が強くなる）
    // P0が強力AIなのでP0の勝率が高い→正例比率が増えるという利点は維持
    for (const s of _trainingSamples) {
      preBuf.push({
        features: s.features,
        label: s.playerId === winner ? 1.0
             : Math.min(0.95, finalVPs[s.playerId] / Math.max(winnerVP, 1))
      });
    }

    if ((g + 1) % 10 === 0) {
      updateTrainBanner(g + 1, numGames, t0, null,
        `サンプル${preBuf.length}件 | P0勝利率${((preBuf.filter(s=>s.label>=1.0).length/Math.max(preBuf.length,1))*100).toFixed(0)}%`);
      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }
  }

  _trainingSamples = null;
  useNN = savedUseNN;
  mixedTrainMode = savedMixed;

  if (trainStop) {
    setStatus('強力AI蒸留: 停止されました');
  } else {
    setStatus(`強力AI蒸留: NN学習中 (${preBuf.length}サンプル × ${trainEpochs}エポック)...`);
    _replayBuffer = preBuf.slice(-NN_REPLAY_CAP);

    for (let ep = 0; ep < trainEpochs && !trainStop; ep++) {
      await trainStep();
      if ((ep + 1) % 3 === 0) {
        updateTrainBanner(numGames, numGames, t0,
          `蒸留NN学習 ${ep+1}/${trainEpochs}ep`,
          `loss=${trainStats.lastLoss?.toFixed(4) ?? '-'}`);
        await new Promise(r => _origSetTimeout.call(window, r, 0));
      }
    }

    await autoSaveSilent();
    setStatus(`強力AI蒸留完了！ ${preBuf.length}サンプル / loss=${trainStats.lastLoss?.toFixed(4)}`);
  }

  hideTrainBanner();
  trainRunning = false;
  _fastMode = false;
  if (!_calledFromAutoTrain) {
    ['btn-train','btn-eval','btn-auto-train','btn-pretrain','btn-reset-weights',
     'btn-save-weights','btn-load-weights'].forEach(id => {
      try { document.getElementById(id).disabled = false; } catch(_){}
    });
    try { document.getElementById('btn-train-stop').disabled = true; } catch(_){}
    newGame(); updateUI(); setupStep();
  }
}

async function preTrainFromHeuristic(numGames, trainEpochs, _calledFromAutoTrain = false) {
  if (trainRunning || !nnReady) return;
  trainRunning = true;
  trainStop = false;

  // UIロック（autoTrainFull から呼ばれた場合はボタン解放しない）
  if (!_calledFromAutoTrain) {
    ['btn-train','btn-eval','btn-auto-train','btn-reset-weights',
     'btn-save-weights','btn-load-weights'].forEach(id =>
      document.getElementById(id).disabled = true);
    document.getElementById('btn-train-stop').disabled = false;
  }

  showTrainBanner(`📚 ヒューリスティック事前学習 (${numGames}G)`, numGames);

  // ※ モデルリセットは行わない: 既存の重みに追加学習する
  // （以前はリセットしていたがこれが勝率崩壊の原因だった）

  setStatus('事前学習: ヒューリスティックデータ収集中...');

  const savedUseNN = useNN;
  const savedMixed = mixedTrainMode;
  useNN = false;       // 全員ヒューリスティック
  mixedTrainMode = false;

  const preBuf = []; // 事前学習専用バッファ（容量制限なし）
  const t0 = Date.now();

  for (let g = 0; g < numGames && !trainStop; g++) {
    // ヒューリスティック自己対戦でサンプル収集
    _fastMode = true;
    _trainingSamples = [];

    newGame();
    for (const p of state.players) p.isAI = true;
    setupStep();

    let safety = 3000;
    while (state.phase !== 'gameover' && safety-- > 0) {
      if      (state.phase === 'roll')      aiRollDice();
      else if (state.phase === 'main')      aiMainTurn();
      else if (state.phase === 'discard')   processNextDiscard();
      else if (state.phase === 'moveRobber') aiMoveRobber();
      else break;
    }

    _fastMode = false;
    if (state.players[0]) state.players[0].isAI = false;

    const winner = state.winner;
    const finalVPs = state.players.map(p => computeVP(p));
    const winnerVP = winner != null ? finalVPs[winner] : Math.max(...finalVPs);

    // ラベル: バイナリ（勝者=1.0、他=0.0）で自己対戦と統一
    for (const s of _trainingSamples) {
      preBuf.push({
        features: s.features,
        label: s.playerId === winner ? 1.0 : 0.0
      });
    }

    if ((g + 1) % 10 === 0) {
      updateTrainBanner(g + 1, numGames, t0, null, `サンプル${preBuf.length}件収集中`);
      await new Promise(r => _origSetTimeout.call(window, r, 0));
    }
  }

  _trainingSamples = null;
  useNN = savedUseNN;
  mixedTrainMode = savedMixed;

  if (trainStop) {
    setStatus('事前学習: 停止されました');
  } else {
    // 大量エポックでヒューリスティック知識を蒸留
    setStatus(`事前学習: NN学習中 (${preBuf.length}サンプル × ${trainEpochs}エポック)...`);

    // preBuf を replay buffer として使用
    _replayBuffer = preBuf.slice(-NN_REPLAY_CAP); // 最大容量に収める

    for (let ep = 0; ep < trainEpochs && !trainStop; ep++) {
      await trainStep();
      if ((ep + 1) % 2 === 0) {
        updateTrainBanner(numGames, numGames, t0,
          `事前学習 NN蒸留 ${ep+1}/${trainEpochs}ep`,
          `loss=${trainStats.lastLoss?.toFixed(4) ?? '-'}`);
        await new Promise(r => _origSetTimeout.call(window, r, 0));
      }
    }

    await autoSaveSilent();
    setStatus(`事前学習完了！ ${preBuf.length}サンプル / loss=${trainStats.lastLoss?.toFixed(4)} → 自動学習で強化してください`);
  }

  hideTrainBanner();
  trainRunning = false;
  _fastMode = false;
  if (!_calledFromAutoTrain) {
    ['btn-train','btn-eval','btn-auto-train','btn-reset-weights',
     'btn-save-weights','btn-load-weights'].forEach(id =>
      document.getElementById(id).disabled = false);
    document.getElementById('btn-train-stop').disabled = true;
    newGame(); updateUI(); setupStep();
  }
}

// ============================================================
//  Auto-training loop: 学習→評価を繰り返し、勝率 targetRate を超えたら停止
// ============================================================
let _autoStop = false;

async function autoTrainUntil(targetRate = 0.25, batchSize = 200, evalGames = 100) {
  if (trainRunning || !nnReady) return;
  _autoStop = false;

  // 自動学習は純粋自己対戦（全員NN）で行う
  // 混在モードだとNN player0がほぼ毎回最下位→ラベルが0ばかり→loss低くてもNN無意味
  const savedMixed = mixedTrainMode;
  mixedTrainMode = false;

  document.getElementById('btn-auto-train').disabled = true;
  document.getElementById('btn-auto-stop').disabled = false;
  document.getElementById('btn-train').disabled = true;
  document.getElementById('btn-eval').disabled = true;
  document.getElementById('btn-reset-weights').disabled = true;

  // 現在の勝率を先に測定してPhaseを決定（再開時に無駄な自己対戦をしない）
  setStatus('現在の勝率を測定中...');
  const initialRate = await runEvalSilent(Math.min(evalGames, 50));
  const PHASE2_THRESHOLD = 0.15;
  let phase = initialRate >= PHASE2_THRESHOLD ? 2 : 1;
  let round = 0;
  setStatus(`自動学習 Phase1開始（全員NN自己対戦）: 目標 ${(targetRate*100).toFixed(0)}%`);

  try {
    while (!_autoStop) {
      round++;
      const el = document.getElementById('train-progress');

      // フェーズ切替判定
      if (phase === 1) {
        if (el) el.textContent = `[P1 R${round}] ${batchSize}ゲーム自己対戦学習... (累計${trainStats.games}G)`;
        mixedTrainMode = false;
      } else {
        if (el) el.textContent = `[P2 R${round}] ${batchSize}ゲーム混在訓練... (累計${trainStats.games}G)`;
        mixedTrainMode = true;
      }

      await startTraining(batchSize);
      if (_autoStop) break;

      if (el) el.textContent = `[P${phase} R${round}] ${evalGames}ゲーム評価中...`;
      const rate = await runEvalSilent(evalGames);

      const lossStr = trainStats.lastLoss != null ? trainStats.lastLoss.toFixed(4) : '-';
      if (el) el.textContent =
        `[P${phase} R${round}] 勝率 ${(rate*100).toFixed(1)}% / 目標${(targetRate*100).toFixed(0)}% / loss=${lossStr} / 累計${trainStats.games}G`;
      setStatus(`自動P${phase}R${round}: 勝率${(rate*100).toFixed(1)}% loss=${lossStr} 累計${trainStats.games}G`);

      await autoSaveSilent();

      // Phase1 → Phase2 移行
      if (phase === 1 && rate >= PHASE2_THRESHOLD) {
        phase = 2;
        setStatus(`Phase2へ移行（対ヒューリスティック混在訓練）: 勝率${(rate*100).toFixed(1)}%`);
      }

      if (rate >= targetRate) {
        showModal('自動学習 完了!',
          `<div style="line-height:1.8">
            <div>目標達成!</div>
            <div>NN勝率: <b>${(rate*100).toFixed(1)}%</b>（目標: ${(targetRate*100).toFixed(0)}%）</div>
            <div>Phase${phase} / ラウンド${round} / 累計学習: ${trainStats.games}ゲーム</div>
            <div style="margin-top:8px;font-size:11px;color:#8fa">重みを自動保存しました</div>
          </div>`,
          '<button onclick="hideModal()">閉じる</button>');
        break;
      }

      await new Promise(r => _origSetTimeout.call(window, r, 100));
    }
  } catch(e) {
    console.error('autoTrain error', e);
    setStatus('自動学習エラー: ' + e.message);
  }

  mixedTrainMode = savedMixed;
  _autoStop = false;
  document.getElementById('btn-auto-train').disabled = false;
  document.getElementById('btn-auto-stop').disabled = true;
  document.getElementById('btn-train').disabled = false;
  document.getElementById('btn-eval').disabled = false;
  document.getElementById('btn-reset-weights').disabled = false;

  newGame(); updateUI(); setupStep();
}

// ============================================================
//  最速50%達成 自動学習 (全フェーズ自動制御)
// ============================================================
async function autoTrainFull(targetRate = 0.50) {
  if (trainRunning || !nnReady) return;
  _autoStop = false;

  const ALL_BTNS = ['btn-train','btn-eval','btn-auto-train','btn-pretrain','btn-pretrain-strong',
                    'btn-train-full','btn-reset-weights','btn-save-weights','btn-load-weights'];

  // サブ関数がボタンを再解放した後、再ロックするヘルパー
  const lockBtns = () => {
    ALL_BTNS.forEach(id => { try { document.getElementById(id).disabled = true; } catch(_){} });
    try { document.getElementById('btn-auto-stop').disabled = false; } catch(_){}
    try { document.getElementById('btn-train-stop').disabled = false; } catch(_){}
  };

  lockBtns();

  const savedMixed = mixedTrainMode;
  const t0 = Date.now();

  const log = (phase, msg) => {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const timeStr = elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed/60)}分${elapsed%60}秒`;
    const full = `[${phase}] ${msg} (経過${timeStr} / 累計${trainStats.games}G)`;
    setStatus(full);
    const el = document.getElementById('train-progress');
    if (el) el.textContent = full;
    console.log(full);
  };

  try {
    // ── 初期評価 ──
    log('初期化', '現在の勝率を測定中...');
    let rate = await runEvalSilent(40);
    lockBtns();
    log('初期化', `現在の勝率 ${(rate*100).toFixed(1)}% → 目標 ${(targetRate*100).toFixed(0)}%`);
    if (rate >= targetRate) { log('完了', '既に目標達成済みです！'); return; }

    // ── Phase 0: ヒューリスティック事前学習（勝率20%未満かつ重みロード済みでない場合のみ）──
    // preTrainFromStrongAI はモデルをリセットして事前行動特徴量で学習するため不適。
    // preTrainFromHeuristic は全プレイヤーから広いラベル範囲でサンプルを収集し、
    // 後続の自己対戦（事後行動特徴量）へのブリッジとして機能する。
    // Phase 0: ヒューリスティック事前学習（初回のみ: 重みファイルなしかつ勝率10%未満）
    if (rate < 0.10 && !_autoStop && !window._skipPhase0) {
      log('Phase0', `ヒューリスティック事前学習開始 (200G × 30ep)... 現在${(rate*100).toFixed(1)}%`);
      await preTrainFromHeuristic(200, 30, true);
      lockBtns();
      if (_autoStop) throw new Error('停止');
      rate = await runEvalSilent(50);
      lockBtns();
      log('Phase0完了', `事前学習後勝率 ${(rate*100).toFixed(1)}%`);
    }

    // ── Phase 1: MCTS学習（毎アクション最高勝率の選択を繰り返す）──
    // AlphaZero方式: 各アクション時にMCTSロールアウトで最良手を選び、
    // そのMCTS勝率をラベルとしてNNを学習。これにより「勝ちやすい局面」を正確に学習できる。
    let round = 0;
    if (typeof window._analysisEval !== 'undefined') {
      while (rate < targetRate && !_autoStop && round < 40) {
        round++;
        // 10ロールアウト: 推定精度が高くラベルとして使える（std≈0.14）
        // ゲーム数は少なくして1ラウンドあたりの時間を抑える
        const mctsGames = rate < 0.15 ? 4 : (rate < 0.30 ? 3 : 2);
        const rollouts = 10;
        log(`Phase1 R${round}`, `MCTS学習（${mctsGames}G×${rollouts}rollout）... 現在${(rate*100).toFixed(1)}%`);
        await startMCTSTraining(mctsGames, rollouts);
        lockBtns();
        if (_autoStop) break;
        // MCTS後に純粋自己対戦で多様性を追加
        // 自己対戦で多様性を追加（300局で安定した学習）
        log(`Phase1 R${round}`, `MCTS後→自己対戦...`);
        mixedTrainMode = false;
        await startTraining(300);
        lockBtns();
        mixedTrainMode = savedMixed;
        if (_autoStop) break;
        // 混在学習は常にNNの崩壊を引き起こすため無効化
        // （勝率が低いとき: 負けサンプルばかり → 崩壊）
        // （勝率が高いとき: 強化直後に混在で上書き → 崩壊）
        log(`Phase1 R${round}`, `混在学習スキップ（無効化済み）`);
        rate = await runEvalSilent(60);
        lockBtns();
        await autoSaveSilent();
        log(`Phase1 R${round}`, `勝率 ${(rate*100).toFixed(1)}%`);
        if (rate >= targetRate) break;
      }
    } else {
      // _analysisEval がない場合は純粋自己対戦にフォールバック
      while (rate < targetRate && !_autoStop && round < 40) {
        round++;
        log(`Phase1 R${round}`, `自己対戦（MCTSなし）... 現在${(rate*100).toFixed(1)}%`);
        mixedTrainMode = false;
        await startTraining(300);
        lockBtns();
        mixedTrainMode = savedMixed;
        if (_autoStop) break;
        mixedTrainMode = true;
        await startTraining(200);
        lockBtns();
        mixedTrainMode = savedMixed;
        if (_autoStop) break;
        rate = await runEvalSilent(60);
        lockBtns();
        await autoSaveSilent();
        log(`Phase1 R${round}`, `勝率 ${(rate*100).toFixed(1)}%`);
        if (rate >= targetRate) break;
      }
    }

    // ── 完了 ──
    if (rate >= targetRate && !_autoStop) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      const timeStr = elapsed < 60 ? `${elapsed}秒` : `${Math.floor(elapsed/60)}分${elapsed%60}秒`;
      showModal('🎉 目標達成！',
        `<div style="line-height:2; font-size:14px">
          <div>NN勝率: <b style="color:#8fa;font-size:18px">${(rate*100).toFixed(1)}%</b>（目標: ${(targetRate*100).toFixed(0)}%）</div>
          <div>総学習時間: <b>${timeStr}</b></div>
          <div>累計学習ゲーム数: <b>${trainStats.games}ゲーム</b></div>
          <div style="margin-top:8px;font-size:11px;color:#8fa">重みを自動保存しました</div>
        </div>`,
        '<button onclick="hideModal()">閉じる</button>');
    }

  } catch(e) {
    if (e.message !== '停止') {
      console.error('autoTrainFull error', e);
      setStatus('自動学習エラー: ' + e.message);
    }
  } finally {
    mixedTrainMode = savedMixed;
    _fastMode = false;
    trainRunning = false;
    _autoStop = false;
    _mctsTrainMode = false;
    ALL_BTNS.forEach(id => { try { document.getElementById(id).disabled = false; } catch(_){} });
    document.getElementById('btn-auto-stop').disabled = true;
    document.getElementById('btn-train-stop').disabled = true;
    window._autoTrainFullDone = true; // Playwright完了検知用フラグ
    newGame(); updateUI(); setupStep();
  }
}

// 評価をサイレントに実行し、NN勝率(P0)を返す
async function runEvalSilent(numGames) {
  evalMode = true;
  trainRunning = true;
  trainStop = false;
  const wins = [0, 0, 0, 0];
  let played = 0;
  try {
    for (let g = 0; g < numGames && !_autoStop; g++) {
      let result;
      try { result = playSelfPlayGame(false); } catch(e) { _fastMode = false; continue; }
      if (result.winner != null) { wins[result.winner]++; played++; }
      if ((g+1) % 10 === 0) {
        const curRate = played > 0 ? (wins[0]/played*100).toFixed(1) : '-';
        setStatus(`評価中... ${g+1}/${numGames}G | 現在勝率 ${curRate}%`);
        await new Promise(r => _origSetTimeout.call(window, r, 0));
      }
    }
  } finally {
    evalMode = false;
    trainRunning = false;
    _fastMode = false;
    _evaluatingNN = false;
  }
  return played > 0 ? wins[0] / played : 0;
}

// ============================================================
//  UI setup
// ============================================================
window.addEventListener('load', () => {
  // ボタンハンドラはモデル初期化の前に登録（クリックがロストしないように）
  document.getElementById('chk-human-learn').addEventListener('change', e => {
    _humanLearnEnabled = e.target.checked;
    if (_humanLearnEnabled) {
      _humanSamples = [];
      setStatus('自分のプレーを学習モード ON — 建設・購入・ターン終了を記録します');
    } else {
      setStatus('自分のプレーを学習モード OFF');
      _humanSamples = [];
      _updateHumanLearnStatus();
    }
  });
  document.getElementById('chk-use-nn').addEventListener('change', e => {
    if (!nnReady) { e.target.checked = false; setStatus('NN準備中です。少し待ってください'); return; }
    useNN = e.target.checked;
    setStatus(useNN ? `NN AI 有効 (累計${trainStats.games}ゲーム学習)` : 'NN AI 無効 (ヒューリスティック)');
  });
  const strongChk = document.getElementById('chk-strong-mode');
  if (strongChk) {
    strongModeEnabled = strongChk.checked;
    strongChk.addEventListener('change', e => {
      strongModeEnabled = e.target.checked;
      setStatus(strongModeEnabled
        ? '強力AI (P0) 有効: エキスパート戦略でP0が他3人を圧倒します'
        : '強力AI 無効: P0は通常ヒューリスティック/NN');
    });
  }
  document.getElementById('btn-train').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    const n = parseInt(prompt('学習ゲーム数 (推奨: 100〜500)', '100')) || 0;
    if (n <= 0) return;
    mixedTrainMode = document.getElementById('chk-mixed-train').checked;
    await startTraining(n);
    mixedTrainMode = false;
  };
  document.getElementById('btn-eval').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    const n = parseInt(prompt('評価ゲーム数 (推奨: 50〜200)', '50')) || 0;
    if (n <= 0) return;
    await startEvaluation(n);
  };
  document.getElementById('btn-train-stop').onclick = () => { trainStop = true; setStatus('停止要求中...'); };
  document.getElementById('btn-save-weights').onclick = () => {
    if (trainRunning) { setStatus('学習中は保存できません（停止してから）'); return; }
    saveWeights();
  };
  document.getElementById('btn-load-weights').onclick = () => {
    if (trainRunning) { setStatus('学習中は読込できません'); return; }
    loadWeights();
  };
  document.getElementById('btn-export-file').onclick = () => {
    if (trainRunning) { setStatus('学習中は出力できません'); return; }
    exportToFile();
  };
  document.getElementById('btn-import-file').onclick = () => {
    if (trainRunning) { setStatus('学習中は入力できません'); return; }
    importFromFile();
  };
  document.getElementById('btn-reset-weights').onclick = () => {
    if (trainRunning) { setStatus('学習中は初期化できません'); return; }
    if (confirm('NN重みを完全リセット？')) resetWeights();
  };
  document.getElementById('btn-pretrain').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    if (trainRunning) { setStatus('既に学習中です'); return; }
    if (!confirm(
      'ヒューリスティック事前学習を開始します。\n' +
      '現在の重みはリセットされます。\n\n' +
      '処理時間の目安:\n' +
      '・300ゲーム収集 + 50エポック学習 ≒ 3〜5分\n\n' +
      '続けますか？')) return;
    const numG = parseInt(prompt('収集ゲーム数 (推奨: 300〜500)', '300')) || 300;
    const numE = parseInt(prompt('学習エポック数 (推奨: 30〜50)', '50')) || 50;
    await preTrainFromHeuristic(numG, numE);
  };
  document.getElementById('btn-pretrain-strong').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    if (trainRunning) { setStatus('既に学習中です'); return; }
    if (!confirm(
      '強力AI蒸留事前学習を開始します。\n' +
      '強力AI(P0)の対戦データをNNに学習させます。\n' +
      '現在の重みはリセットされます。\n\n' +
      '処理時間の目安:\n' +
      '・200ゲーム収集 + 30エポック学習 ≒ 2〜4分\n\n' +
      '続けますか？')) return;
    const numG = parseInt(prompt('収集ゲーム数 (推奨: 200〜500)', '200')) || 200;
    const numE = parseInt(prompt('学習エポック数 (推奨: 20〜50)', '30')) || 30;
    await preTrainFromStrongAI(numG, numE);
  };
  document.getElementById('btn-auto-train').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    if (trainRunning) { setStatus('既に学習中です'); return; }
    const target = parseFloat(prompt('目標勝率 (例: 0.25 = 25%)', '0.25'));
    if (isNaN(target) || target <= 0) return;
    const batch = parseInt(prompt('1ラウンドの学習ゲーム数', '200')) || 200;
    const evalN = parseInt(prompt('評価ゲーム数', '100')) || 100;
    mixedTrainMode = document.getElementById('chk-mixed-train').checked;
    await autoTrainUntil(target, batch, evalN);
    mixedTrainMode = false;
  };
  document.getElementById('btn-auto-stop').onclick = () => {
    _autoStop = true;
    trainStop = true;
    setStatus('自動学習 停止要求中...');
  };

  document.getElementById('btn-train-full').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    if (trainRunning) { setStatus('既に学習中です（停止してから）'); return; }
    const target = parseFloat(prompt('目標勝率 (例: 0.50 = 50%)', '0.50') || '0.50');
    if (isNaN(target) || target <= 0 || target > 1) return;
    await autoTrainFull(target);
  };

  // MCTS 強化学習ボタン
  document.getElementById('btn-mcts-train').onclick = async () => {
    if (!nnReady) { setStatus('NN準備中です'); return; }
    if (trainRunning) { setStatus('既に学習中です'); return; }
    if (typeof window._analysisEval === 'undefined') {
      setStatus('analysis.js が読み込まれていません'); return;
    }

    const gamesInput = document.getElementById('mcts-games');
    const rolloutsInput = document.getElementById('mcts-rollouts');
    const games = Math.max(1, Math.min(100, parseInt(gamesInput.value) || 5));
    const rollouts = Math.max(1, Math.min(20, parseInt(rolloutsInput.value) || 3));

    gamesInput.value = games;
    rolloutsInput.value = rollouts;

    const estimatedSec = games * 120 / (rollouts === 1 ? 1 : 1); // Rough estimate
    const minStr = Math.ceil(estimatedSec / 60);
    if (!confirm(
      `MCTS強化学習を開始します。\n` +
      `設定: ${games}ゲーム × ${rollouts}ロールアウト\n` +
      `推定時間: 約${minStr}分\n\n` +
      `続けますか？`)) return;

    mixedTrainMode = document.getElementById('chk-mixed-train').checked;
    await startMCTSTraining(games, rollouts);
    mixedTrainMode = false;
  };

  // MCTS 設定変更時に推定時間を更新
  ['mcts-games', 'mcts-rollouts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        const games = Math.max(1, parseInt(document.getElementById('mcts-games').value) || 5);
        const rollouts = Math.max(1, parseInt(document.getElementById('mcts-rollouts').value) || 3);
        // 粗い見積もり: 1ゲーム ≈ 50-100秒 / rollout（実際は vary）
        const perGame = 60 + rollouts * 30;
        const totalSec = games * perGame;
        const minStr = Math.ceil(totalSec / 60);
        const infoEl = document.getElementById('mcts-info');
        if (infoEl) infoEl.textContent = `推定時間: 約${minStr}分`;
      });
    }
  });

  // モデル初期化は非同期で（ハンドラは既に登録済み）
  initNN().catch(e => setStatus('NN初期化失敗: ' + e.message));
});
