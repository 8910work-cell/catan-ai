// ============================================================
//  Strong Expert AI for Player 0 — 計測駆動版
//  ベースライン (4人ヒューリスティック) ≒ P0=30% (先手有利)
//  目標: 35-40%
//
//  各機能は STRONG_FEATURES でON/OFF可能。実測で効果が出たものだけ採用。
// ============================================================

var strongModeEnabled = true;

// 機能フラグ (デフォルトは「実測で勝率が上がるもの」のみ true)
var STRONG_FEATURES = {
  betterSetup:     true,
  leaderRobber:    true,
  smartDev:        true,
  goalTrade:       true,
  better2ndStart:  true,
  setupLookahead:  false, // 一旦OFF
  smartRoad:       false, // 一旦OFF
  aggressiveTrade: false, // 無限ループの原因のため永久OFF
  forceLA:         false, // 一旦OFF
  blockOpp:        false, // 一旦OFF
};

// ── 改良初期配置: ピップ数×2 + 多様性 (バランス重視) ─────────
function strongEvaluateVertex(vid, pid) {
  const v = state.board.vertices[vid];
  const p = state.players[pid];
  if (!v) return -Infinity;

  const resScore = {wood:0, brick:0, wheat:0, sheep:0, ore:0};
  let totalPips = 0;
  let hotCount = 0;

  for (const hid of v.hexes) {
    const hex = state.board.hexes[hid];
    if (hex.type === 'desert') continue;
    const r = TERRAIN_TO_RES[hex.type];
    const pips = PROB_PIPS[hex.number] || 0;
    resScore[r] += pips;
    totalPips += pips;
    if (hex.number === 6 || hex.number === 8) hotCount++;
  }

  // ベース: ピップ数 × 2 (元と同じ)
  let score = totalPips * 2;

  // 多様性ボーナス (元: 3, 改良: 4)
  const distinct = Object.values(resScore).filter(v => v > 0).length;
  score += distinct * 4;

  // 港 (条件付き)
  if (v.port === 'generic') score += 2;
  else if (v.port) {
    // 自分の既存生産がその資源を出しているなら大きな価値
    const existing = p.settlements.concat(p.cities).reduce((s, vv) => {
      const vert = state.board.vertices[vv];
      let pp = 0;
      for (const hid of vert.hexes) {
        const hex = state.board.hexes[hid];
        if (hex.type !== 'desert' && TERRAIN_TO_RES[hex.type] === v.port) pp += PROB_PIPS[hex.number] || 0;
      }
      return s + pp;
    }, 0);
    if (existing + resScore[v.port] >= 4) score += 5;
    else if (resScore[v.port] > 0) score += 3;
    else score += 1;
  }

  // 既存資源とのシナジー (2番目以降の配置で新規資源確保)
  if (STRONG_FEATURES.better2ndStart) {
    for (const r of ['wood','brick','wheat','sheep','ore']) {
      const cur = p.settlements.concat(p.cities).reduce((s, vv) => {
        const vert = state.board.vertices[vv];
        for (const hid of vert.hexes) {
          const hex = state.board.hexes[hid];
          if (hex.type !== 'desert' && TERRAIN_TO_RES[hex.type] === r) s += PROB_PIPS[hex.number] || 0;
        }
        return s;
      }, 0);
      // 全く持っていない資源 (特にwood/brickなど拡張資源) を取れたら大ボーナス
      if (cur === 0 && resScore[r] > 0) {
        // wood/brick は拡張に必須なので 5、ore/wheat は 4、sheep は 3
        const newResBonus = (r === 'wood' || r === 'brick') ? 5
                          : (r === 'wheat' || r === 'ore') ? 4 : 3;
        score += newResBonus;
      }
    }
  }

  // 6/8 ボーナス
  if (STRONG_FEATURES.betterSetup) score += hotCount * 2;

  return score;
}

// 頂点の "拡張ポテンシャル": この頂点から2街道以内に建設可能な良い頂点が何個あるか
function _expansionPotential(vid, pid) {
  const v = state.board.vertices[vid];
  let pot = 0;
  const seen = new Set([vid]);
  // 1-hop
  for (const eid of v.edges) {
    const e = state.board.edges[eid];
    const adj = e.v1 === vid ? e.v2 : e.v1;
    if (seen.has(adj)) continue; seen.add(adj);
    if (state.board.vertices[adj].building) continue;
    // 距離2制約: adj に隣接する建物があったらadjは使えない
    let blocked = false;
    for (const nv of state.board.vertices[adj].adjV) {
      if (nv !== vid && state.board.vertices[nv].building) { blocked = true; break; }
    }
    if (!blocked) {
      // 直接届くスポット
      pot += Math.max(0, strongEvaluateVertex(adj, pid)) * 0.4;
    }
    // 2-hop
    for (const eid2 of state.board.vertices[adj].edges) {
      const e2 = state.board.edges[eid2];
      const adj2 = e2.v1 === adj ? e2.v2 : e2.v1;
      if (seen.has(adj2)) continue; seen.add(adj2);
      if (state.board.vertices[adj2].building) continue;
      let blocked2 = false;
      for (const nv of state.board.vertices[adj2].adjV) {
        if (state.board.vertices[nv].building) { blocked2 = true; break; }
      }
      if (!blocked2) {
        pot += Math.max(0, strongEvaluateVertex(adj2, pid)) * 0.2;
      }
    }
  }
  return pot;
}

// 相手にとって魅力的な頂点をブロックする価値
function _blockingValue(vid) {
  const v = state.board.vertices[vid];
  if (v.building) return 0;
  // この頂点の純粋pip価値 (相手から見ても価値が高い場所はブロックする価値あり)
  let pips = 0, distinct = 0;
  const seen = {};
  for (const hid of v.hexes) {
    const hex = state.board.hexes[hid];
    if (hex.type === 'desert') continue;
    pips += PROB_PIPS[hex.number] || 0;
    seen[TERRAIN_TO_RES[hex.type]] = true;
  }
  distinct = Object.keys(seen).length;
  return pips * 1.5 + distinct * 2;
}

// ── 初期配置 ──────────────────────────────────────────────
function strongAiSetupTurn() {
  if (!STRONG_FEATURES.betterSetup) return _origAiSetupTurn();
  const pid = state.currentPlayer;
  const phase = state.phase; // 'setup1' or 'setup2'

  // 全候補をスコア付け
  const cands = [];
  for (let i = 0; i < state.board.vertices.length; i++) {
    if (!isVertexBuildable(i, pid, true)) continue;
    let s = strongEvaluateVertex(i, pid);
    // 拡張ポテンシャル (setup1 のみ重要; setup2 後は1回拡張すれば足りる)
    if (STRONG_FEATURES.setupLookahead) {
      s += _expansionPotential(i, pid) * (phase === 'setup1' ? 1.0 : 0.5);
    }
    // ブロック価値 (相手も欲しい場所か)
    if (STRONG_FEATURES.blockOpp) {
      s += _blockingValue(i) * 0.3;
    }
    cands.push({v: i, s});
  }
  cands.sort((a, b) => b.s - a.s);
  const bestV = cands.length > 0 ? cands[0].v : -1;

  if (bestV < 0) { state.setupIndex++; setTimeout(setupStep, 100); return; }
  setupPlaceSettlement(bestV);

  // 街道: 最良頂点から拡張方向
  const v = state.board.vertices[bestV];
  let bestE = -1, bestEScore = -Infinity;
  for (const eid of v.edges) {
    if (!isEdgeBuildable(eid, pid, bestV)) continue;
    const e = state.board.edges[eid];
    const otherV = e.v1 === bestV ? e.v2 : e.v1;
    // 隣接頂点に建てられるか確認
    let canBuildThere = !state.board.vertices[otherV].building;
    if (canBuildThere) {
      for (const nv of state.board.vertices[otherV].adjV) {
        if (state.board.vertices[nv].building) { canBuildThere = false; break; }
      }
    }
    const futureValue = canBuildThere ? strongEvaluateVertex(otherV, pid) : 0;
    if (futureValue > bestEScore) { bestEScore = futureValue; bestE = eid; }
  }
  if (bestE < 0) {
    for (const eid of v.edges) if (isEdgeBuildable(eid, pid, bestV)) { bestE = eid; break; }
  }
  setTimeout(() => setupPlaceRoad(bestE), 300);
}

// ── 強盗: リーダー (最高VP) のベストタイル限定 ──────────────
function strongAiMoveRobber() {
  if (!STRONG_FEATURES.leaderRobber) return _origAiMoveRobber();
  const pid = state.currentPlayer;

  // リーダー特定
  let leaderId = -1, leaderVP = -1;
  for (const op of state.players) {
    if (op.id === pid) continue;
    const v = computeVP(op);
    if (v > leaderVP) { leaderVP = v; leaderId = op.id; }
  }
  if (leaderId < 0) leaderId = (pid + 1) % 4;

  let best = -1, bestScore = -Infinity;
  for (const hex of state.board.hexes) {
    if (hex.hasRobber || hex.type === 'desert') continue;
    let touchesUs = false, leaderHits = 0, otherHits = 0;
    let leaderRes = 0;
    for (const vid of hex.vertices) {
      const v = state.board.vertices[vid];
      if (!v.building) continue;
      if (v.building.player === pid) { touchesUs = true; break; }
      const cards = ['wood','brick','wheat','sheep','ore'].reduce(
        (s, r) => s + state.players[v.building.player].resources[r], 0);
      const hits = (v.building.type === 'city' ? 2 : 1);
      if (v.building.player === leaderId) { leaderHits += hits; leaderRes = Math.max(leaderRes, cards); }
      else { otherHits += hits; }
    }
    if (touchesUs) continue;
    if (leaderHits === 0 && otherHits === 0) continue;

    const pips = PROB_PIPS[hex.number] || 0;
    // リーダーに当てるのは otherより4倍重要、+ pip と所持資源量を考慮
    let score = leaderHits * pips * 4 + otherHits * pips * 0.6 + (leaderHits > 0 ? leaderRes * 0.5 : 0);

    if (score > bestScore) { bestScore = score; best = hex.id; }
  }

  if (best < 0) {
    // フォールバック: リーダー以外の相手を狙う
    for (const hex of state.board.hexes) {
      if (hex.hasRobber || hex.type === 'desert') continue;
      let touchesUs = false, opps = 0;
      for (const vid of hex.vertices) {
        const v = state.board.vertices[vid];
        if (!v.building) continue;
        if (v.building.player === pid) { touchesUs = true; break; }
        opps++;
      }
      if (!touchesUs && opps > 0) { best = hex.id; break; }
    }
  }
  if (best < 0) {
    for (const hex of state.board.hexes) if (!hex.hasRobber) { best = hex.id; break; }
  }
  moveRobberTo(best);
}

// ── スマート街道: 2ステップ先のスポット価値で選ぶ ─────────
function strongBestRoadSpot(p) {
  if (!STRONG_FEATURES.smartRoad) return aiBestRoadSpot(p);
  const pid = p.id;
  let best = null, bestScore = -Infinity;

  for (let i = 0; i < state.board.edges.length; i++) {
    if (!isEdgeBuildable(i, pid, null)) continue;
    const e = state.board.edges[i];
    let s = 0;

    // 1-hop: この街道を建てた直後に建てられる開拓地
    for (const vid of [e.v1, e.v2]) {
      if (state.board.vertices[vid].building) continue;
      let canBuild = true;
      for (const nv of state.board.vertices[vid].adjV) {
        if (state.board.vertices[nv].building) { canBuild = false; break; }
      }
      if (canBuild) {
        s += strongEvaluateVertex(vid, pid) * 1.0;
      } else {
        // 2-hop: 街道+1でさらに先まで届く
        for (const eid2 of state.board.vertices[vid].edges) {
          if (eid2 === i) continue;
          const e2 = state.board.edges[eid2];
          if (e2.road != null) continue;
          const otherV = e2.v1 === vid ? e2.v2 : e2.v1;
          if (state.board.vertices[otherV].building) continue;
          let canBuild2 = true;
          for (const nv of state.board.vertices[otherV].adjV) {
            if (state.board.vertices[nv].building) { canBuild2 = false; break; }
          }
          if (canBuild2) {
            s += strongEvaluateVertex(otherV, pid) * 0.5;
          }
        }
      }
    }

    // 最長道路ボーナス
    const baselineLen = p.longestRoadLen;
    placeRoadDryRun(pid, i);
    const newLen = computeLongestRoad(pid);
    unplaceRoadDryRun(i);
    if (newLen > baselineLen) {
      const gain = newLen - baselineLen;
      s += gain * 4;
      if (newLen >= 5 && !p.hasLongestRoad) s += 12; // LR取得時はさらにボーナス
    }

    if (s > bestScore) { bestScore = s; best = i; }
  }
  return best;
}

// ── 積極的交易: 4+ 余剰資源を建設用に変換 ───────────────────
function strongAggressiveTrade(p) {
  if (!STRONG_FEATURES.aggressiveTrade) return false;
  // 何を建てたいか優先順位
  const targets = [
    {name:'city', cost: COSTS.city,
     ok: () => p.cities.length < PIECES_PER_PLAYER.city && p.settlements.length > 0},
    {name:'settlement', cost: COSTS.settlement,
     ok: () => p.settlements.length < PIECES_PER_PLAYER.settlement
              && aiBestSettlementSpot(p) != null},
    {name:'road', cost: COSTS.road,
     ok: () => p.roads.length < PIECES_PER_PLAYER.road
              && p.longestRoadLen >= 3
              && !p.hasLongestRoad},
  ];
  for (const t of targets) {
    if (!t.ok()) continue;
    const snap = JSON.parse(JSON.stringify(p.resources));
    if (strongTradeFor(p, t.cost)) {
      // 交易成功 → 真に建設可能か確認
      const canBuild = ['wood','brick','wheat','sheep','ore'].every(
        r => p.resources[r] >= (t.cost[r] || 0));
      if (canBuild) return true;
    }
    p.resources = snap;
  }
  return false;
}

// ── 目標逆算メインターン ───────────────────────────────────
// 戦略: 都市 > 開拓地(良い場所がある時) > 街道 > 発展カード(条件付き)
//      で、不足資源があれば maritime trade で補ってから建設
function strongTradeFor(p, costObj, ignore) {
  // costObj に対して不足を maritime trade で埋める。成功なら true。
  const missing = {};
  let totalMissing = 0;
  for (const [r, n] of Object.entries(costObj)) {
    const need = n - p.resources[r];
    if (need > 0) { missing[r] = need; totalMissing += need; }
  }
  if (totalMissing === 0) return true; // 既に足りる
  // 余剰がある資源を見つけて trade
  for (let iter = 0; iter < totalMissing && totalMissing > 0; iter++) {
    let traded = false;
    for (const give of ['sheep', 'ore', 'wheat', 'wood', 'brick']) {
      if (missing[give]) continue; // 必要資源は出さない
      if (ignore && ignore.has(give)) continue;
      const ratio = getTradeRatio(p, give);
      // give を ratio 枚出して 1 枚得る。出した後も他の需要を満たせるか?
      // 単純化: give が ratio + (今後のコスト) 枚以上あれば trade
      const needForCost = costObj[give] || 0;
      if (p.resources[give] < ratio + needForCost) continue;
      // 不足の中で最も多く必要なものを取得
      let want = null, wantNeed = 0;
      for (const [r, n] of Object.entries(missing)) {
        if (n > wantNeed) { wantNeed = n; want = r; }
      }
      if (!want) break;
      maritimeTrade(p, give, want);
      missing[want]--;
      if (missing[want] <= 0) { delete missing[want]; }
      totalMissing--;
      traded = true;
      break;
    }
    if (!traded) return false; // これ以上trade不可能
  }
  return totalMissing === 0;
}

function strongAiMainTurnGoal() {
  if (state.phase !== 'main') return;
  if (state.players[state.currentPlayer].isAI === false) return;
  if (checkWin()) return;

  if (typeof _trainingSamples !== 'undefined' && _trainingSamples !== null &&
      typeof nnExtractFeatures === 'function') {
    _trainingSamples.push({
      playerId: state.currentPlayer,
      features: nnExtractFeatures(state.currentPlayer),
      turn: state.turn
    });
  }

  const p = state.players[state.currentPlayer];

  // ── 発展カードプレイ (より積極的な騎士運用) ──
  const knight = p.devCards.find(c => c.type === 'knight' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && knight) {
    // 強盗で自分が封鎖されている → 解除
    const ourHexes = new Set();
    for (const vid of p.settlements.concat(p.cities)) {
      for (const hid of state.board.vertices[vid].hexes) ourHexes.add(hid);
    }
    const blocked = [...ourHexes].some(hid => state.board.hexes[hid].hasRobber);
    // LA 狙い: 既に2騎士でLAを取れる or 競合に勝てる
    const nearLA = p.knightsPlayed >= 2 && !p.hasLargestArmy;
    // forceLA: 早めにLAを取りに行く (2騎士以上で他の誰もLA未取得なら)
    const forceLA = STRONG_FEATURES.forceLA && p.knightsPlayed >= 2 &&
                    !state.players.some(o => o.hasLargestArmy);
    if (blocked || nearLA || forceLA) {
      playDevCard(p, p.devCards.indexOf(knight));
      return;
    }
  }
  const mono = p.devCards.find(c => c.type === 'monopoly' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && mono) {
    playDevCard(p, p.devCards.indexOf(mono));
    setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 200);
    return;
  }
  const yop = p.devCards.find(c => c.type === 'year_of_plenty' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && yop && canAlmostBuild(p)) {
    playDevCard(p, p.devCards.indexOf(yop));
    setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 200);
    return;
  }
  const rb = p.devCards.find(c => c.type === 'road_building' && c.boughtTurn < state.turn);
  if (!p.playedDevThisTurn && rb && p.roads.length < 13 &&
      (computeVP(p) >= 7 || p.longestRoadLen >= 3)) {
    playDevCard(p, p.devCards.indexOf(rb));
    return;
  }

  // ── 目標 1: 都市 (即時 or 交易で実現可能) ──
  if (p.cities.length < PIECES_PER_PLAYER.city && p.settlements.length > 0) {
    if (canAffordCity(p)) {
      const vid = aiBestCitySpot(p);
      if (vid != null) {
        payCost(p, COSTS.city); placeCity(p.id, vid);
        if (!_fastMode) logMsg(`${p.name} が都市を建設 [Goal]`);
        setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
      }
    } else if (STRONG_FEATURES.goalTrade) {
      // 交易で都市建設可能か試す (dry-run用にスナップショット)
      const snap = JSON.parse(JSON.stringify(p.resources));
      if (strongTradeFor(p, COSTS.city)) {
        // 交易成功 → 1回再帰で建設へ
        setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
      }
      p.resources = snap; // 失敗時は復元
    }
  }

  // ── 目標 2: 開拓地 ──
  if (p.settlements.length < PIECES_PER_PLAYER.settlement) {
    const targetSpot = aiBestSettlementSpot(p);
    if (targetSpot != null) {
      if (canAffordSettlement(p)) {
        payCost(p, COSTS.settlement); placeSettlement(p.id, targetSpot);
        if (!_fastMode) logMsg(`${p.name} が開拓地を建設 [Goal]`);
        setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
      } else if (STRONG_FEATURES.goalTrade) {
        const snap = JSON.parse(JSON.stringify(p.resources));
        if (strongTradeFor(p, COSTS.settlement)) {
          setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
        }
        p.resources = snap;
      }
    }
  }

  // ── 目標 3: 街道 (スマート街道版) ──
  if (canAffordRoad(p) && p.roads.length < PIECES_PER_PLAYER.road) {
    const eid = STRONG_FEATURES.smartRoad ? strongBestRoadSpot(p) : aiBestRoadSpot(p);
    if (eid != null) {
      payCost(p, COSTS.road); placeRoad(p.id, eid);
      if (!_fastMode) logMsg(`${p.name} が街道を建設 [Goal]`);
      setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
    }
  }

  // ── 目標 3.5: 積極交易で道路 (LR狙い) ──
  if (STRONG_FEATURES.aggressiveTrade && strongAggressiveTrade(p)) {
    setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
  }

  // ── 目標 4: 発展カード (賢い条件) ──
  if (canAffordDev(p) && state.devDeck.length > 0) {
    const shouldBuy = STRONG_FEATURES.smartDev ? (
      // 賢い条件: 都市/開拓地が建てられない (場所も資源も) かつ VP < 9
      computeVP(p) < 9 &&
      !(canAffordCity(p) && p.settlements.length > 0 && aiBestCitySpot(p) != null) &&
      !(canAffordSettlement(p) && p.settlements.length < PIECES_PER_PLAYER.settlement && aiBestSettlementSpot(p) != null)
    ) : (Math.random() < 0.7);
    if (shouldBuy) {
      buyDevCard(p);
      setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return;
    }
  }

  // ── 目標 5a: 島内交渉 (相手AIと取引 — レート 1:1) ──
  if (typeof aiPlayerTrade === 'function') {
    const tr = aiPlayerTrade(p);
    if (tr === 'pending') return; // 人間応答待ち
    if (tr) { setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400); return; }
  }
  // ── 目標 5b: 海上交易 (4:1 or 港) ──
  if (aiMaritimeTrade(p)) {
    setTimeout(strongAiMainTurnGoal, _fastMode ? 0 : 400);
    return;
  }

  setTimeout(() => endTurn(), _fastMode ? 0 : 500);
}

// ── オーバーライド設定 (元関数を保持) ──────────────────────
var _origAiSetupTurn, _origAiMainTurn, _origAiMoveRobber, _origAiPlaceFreeRoads;
(function installStrongAi() {
  _origAiSetupTurn = aiSetupTurn;
  _origAiMainTurn = aiMainTurn;
  _origAiMoveRobber = aiMoveRobber;
  _origAiPlaceFreeRoads = aiPlaceFreeRoads;

  // Node の vm context では window === global context そのもの
  // (window.aiMainTurn を上書きしてもOKだが、シンプルにグローバル変数を再代入)
  // _rolloutStrongAll: MCTSロールアウト中は4人全員が強力AIで打つ
  // (全員が現実的に強く打つ前提のロールアウト → 勝率予測の精度が上がる)
  const _strongFor = (pid) =>
    window._rolloutStrongAll === true || (strongModeEnabled && pid === 0);

  aiSetupTurn = function() {
    // NNが有効な場合はNN処理に委譲（評価・学習モード共通）
    if (typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer())
      return _origAiSetupTurn();
    if (_strongFor(state.currentPlayer) && STRONG_FEATURES.betterSetup)
      return strongAiSetupTurn();
    return _origAiSetupTurn();
  };

  aiMainTurn = function() {
    // NNが有効な場合はNN処理に委譲（NN使用中は強力AIをスキップ）
    if (typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer())
      return _origAiMainTurn();
    if (_strongFor(state.currentPlayer) &&
        (STRONG_FEATURES.smartDev || STRONG_FEATURES.goalTrade))
      return strongAiMainTurnGoal();
    return _origAiMainTurn();
  };

  aiMoveRobber = function() {
    // NNが有効な場合はNN処理に委譲
    if (typeof _nnEnabledForCurrentPlayer === 'function' && _nnEnabledForCurrentPlayer())
      return _origAiMoveRobber();
    if (_strongFor(state.currentPlayer) && STRONG_FEATURES.leaderRobber)
      return strongAiMoveRobber();
    return _origAiMoveRobber();
  };

  aiPlaceFreeRoads = function() { return _origAiPlaceFreeRoads(); };

  // ブラウザでは globalThis === window なので、上の再代入で window.aiMainTurn 等も
  // 更新される (function宣言された名前は window のプロパティと一致)。
})();
