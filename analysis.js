// ============================================================
//  Strategy Analysis: 勝率 + 最善手予測
//  - MCTS 風ロールアウト: 各候補手について終局までN回プレイ → 勝率集計
//  - 「数百手先まで読む」= 1ロールアウト = ゲーム終局までの50-150ターン分
//  - heuristic policy + ランダムなサイコロで全プレイヤーをシミュレート
// ============================================================

(function initAnalysis() {
  let analyzing = false;
  let autoAnalyze = false;
  let lastAnalysisKey = null;
  let _lastResults = null; // 直近の分析結果 (チェックボックス切替時に再描画する)
  let _lastDepth = 1;
  let executingSequence = false; // 二重実行防止フラグ

  // ── 最善手ハイライト (盤面上の対象を光らせる) ──
  let _hintTarget = null; // {type: 'vertex'|'edge'|'hex', id: number}
  let _hintAnimId = null;

  // ステップ番号ごとの色 (1=シアン, 2=ライトブルー, 3=薄紫)
  const STEP_COLORS = ['#0ff', '#7df', '#bbf', '#fcb'];

  function drawSingleHint(t) {
    if (typeof ctx === 'undefined' || !ctx) return;
    const c = ctx;
    const stepIdx = Math.max(0, (t.step || 1) - 1);
    const col = STEP_COLORS[stepIdx] || '#0ff';
    const tt = Date.now() / 280;
    const pulse = 0.55 + 0.45 * Math.sin(tt + stepIdx * 0.6);
    c.save();
    c.shadowColor = col;
    c.shadowBlur = 18 + 14 * pulse;

    if (t.type === 'vertex') {
      const v = state.board.vertices[t.id];
      if (!v) { c.restore(); return; }
      c.fillStyle = `rgba(0,255,255,${0.25 + 0.25 * pulse})`;
      c.beginPath();
      c.arc(v.x, v.y, 18 + 4 * pulse, 0, Math.PI*2);
      c.fill();
      c.shadowBlur = 0;
      c.strokeStyle = col;
      c.lineWidth = 3;
      c.beginPath();
      c.arc(v.x, v.y, 14, 0, Math.PI*2);
      c.stroke();
      // ステップ番号バッジ
      if (t.step != null) {
        c.fillStyle = '#000';
        c.beginPath();
        c.arc(v.x, v.y, 9, 0, Math.PI*2);
        c.fill();
        c.fillStyle = col;
        c.font = 'bold 13px sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(t.step), v.x, v.y);
      }
    } else if (t.type === 'edge') {
      const e = state.board.edges[t.id];
      if (!e) { c.restore(); return; }
      const v1 = state.board.vertices[e.v1];
      const v2 = state.board.vertices[e.v2];
      c.strokeStyle = col;
      c.lineWidth = 10 + 2 * pulse;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(v1.x, v1.y);
      c.lineTo(v2.x, v2.y);
      c.stroke();
      c.shadowBlur = 0;
      c.strokeStyle = '#fff';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(v1.x, v1.y);
      c.lineTo(v2.x, v2.y);
      c.stroke();
      // 中点にステップ番号
      if (t.step != null) {
        const mx = (v1.x + v2.x) / 2;
        const my = (v1.y + v2.y) / 2;
        c.shadowBlur = 0;
        c.fillStyle = '#000';
        c.beginPath();
        c.arc(mx, my, 10, 0, Math.PI*2);
        c.fill();
        c.fillStyle = col;
        c.font = 'bold 13px sans-serif';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(t.step), mx, my);
      }
    } else if (t.type === 'hex') {
      const h = state.board.hexes[t.id];
      if (!h) { c.restore(); return; }
      c.strokeStyle = col;
      c.lineWidth = 4 + 2 * pulse;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const p = hexCornerPx(h.x, h.y, i);
        if (i === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y);
      }
      c.closePath();
      c.stroke();
    }
    c.restore();
  }

  function drawHintHighlight() {
    if (!_hintTarget) return;
    const targets = Array.isArray(_hintTarget) ? _hintTarget : [_hintTarget];
    // ステップ番号が大きい順に描いて、1手目を最後に描いて最前面に
    const sorted = targets.slice().sort((a, b) => (b.step || 0) - (a.step || 0));
    for (const t of sorted) drawSingleHint(t);
  }
  window.drawHintHighlight = drawHintHighlight;

  function setHintTarget(target) {
    _hintTarget = target;
    if (_hintTarget) {
      // 脈動アニメーション開始
      if (_hintAnimId == null) {
        const tick = () => {
          if (!_hintTarget) { _hintAnimId = null; return; }
          if (typeof render === 'function') render();
          _hintAnimId = requestAnimationFrame(tick);
        };
        _hintAnimId = requestAnimationFrame(tick);
      }
    } else {
      if (_hintAnimId != null) { cancelAnimationFrame(_hintAnimId); _hintAnimId = null; }
      if (typeof render === 'function') render();
    }
  }

  // 行のアクションからハイライトターゲットを決定
  function targetFromAction(a) {
    if (!a) return null;
    if (a.type === 'city' || a.type === 'settlement' || a.type === 'setup_settlement') {
      return { type: 'vertex', id: a.vid };
    }
    if (a.type === 'road' || a.type === 'setup_road') {
      return { type: 'edge', id: a.eid };
    }
    if (a.type === 'robber') {
      return { type: 'hex', id: a.hid };
    }
    return null;
  }

  // ── フル状態スナップショット (nnSnapshot に加えてフェーズ等も保存) ──
  function rolloutSnapshot() {
    return {
      nnSnap: nnSnapshot(),
      phase: state.phase,
      currentPlayer: state.currentPlayer,
      turn: state.turn,
      dice: [...state.dice],
      devDeck: [...state.devDeck],
      pendingDiscards: state.pendingDiscards.map(d => ({...d})),
      roadBuildingRoads: state.roadBuildingRoads || 0,
      preRobberPhase: state.preRobberPhase || null,
      winner: state.winner,
      isAI: state.players.map(p => p.isAI),
      // 初期配置フェーズ用
      setupIndex: state.setupIndex,
      setupSettlement: state.setupSettlement,
      // クリック待ち状態 (重要: setupStep が pendingAction=null してしまうので必ず復元)
      pendingAction: (typeof pendingAction !== 'undefined' && pendingAction)
        ? JSON.parse(JSON.stringify(pendingAction))
        : null,
    };
  }
  function rolloutRestore(snap) {
    nnRestore(snap.nnSnap);
    state.phase = snap.phase;
    state.currentPlayer = snap.currentPlayer;
    state.turn = snap.turn;
    state.dice = [...snap.dice];
    state.devDeck = [...snap.devDeck];
    state.pendingDiscards = snap.pendingDiscards.map(d => ({...d}));
    state.roadBuildingRoads = snap.roadBuildingRoads;
    state.preRobberPhase = snap.preRobberPhase;
    state.winner = snap.winner;
    snap.isAI.forEach((v, i) => state.players[i].isAI = v);
    state.setupIndex = snap.setupIndex;
    state.setupSettlement = snap.setupSettlement;
    // pendingAction を復元 (ブラウザ環境のみ)
    if (typeof pendingAction !== 'undefined') {
      try { pendingAction = snap.pendingAction ? {...snap.pendingAction} : null; } catch (e) {}
    }
  }

  // ── 共通乱数法 (CRN) 用の決定論的 RNG ──
  // すべての候補が同じ乱数系列を使うため、勝率の差はアクション選択のみに帰属する
  function makeRng(seed) {
    let s = (seed | 0) || 1;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return ((s >>> 0) / 0x100000000);
    };
  }

  // ── 1 ロールアウト: 現在状態から終局まで早送り ──
  function runRollout() {
    let safety = 4000;
    while (state.phase !== 'gameover' && safety-- > 0) {
      if (state.phase === 'roll') aiRollDice();
      else if (state.phase === 'main') aiMainTurn();
      else if (state.phase === 'discard') processNextDiscard();
      else if (state.phase === 'moveRobber') aiMoveRobber();
      else if (state.phase === 'setup1' || state.phase === 'setup2') {
        if (typeof aiSetupTurn === 'function') aiSetupTurn();
        else break;
      }
      else break;
    }
    return state.winner;
  }

  // ── 勝者の帰属 ──
  // 正常終了なら winner。タイムアウト (safety切れ) のゲームを「全員負け」と
  // 数えると勝率が一律に過小評価されるため、最高VPのプレイヤーを勝者とみなす。
  function attributedWinner() {
    if (state.winner != null) return state.winner;
    let best = null, bestVP = -1, tie = false;
    for (const p of state.players) {
      const v = computeVP(p);
      if (v > bestVP) { bestVP = v; best = p.id; tie = false; }
      else if (v === bestVP) tie = true;
    }
    return tie ? null : best;
  }

  // ── アクションラベル ──
  function describeAction(a) {
    const rj = (typeof RES_JP === 'object') ? RES_JP : {};
    const targetName = (id) => {
      if (typeof state === 'undefined' || !state.players[id]) return `P${id}`;
      return state.players[id].name;
    };
    switch (a.type) {
      case 'end_turn': return '何もせずターン終了';
      case 'city': return `🏰 都市 (頂点 #${a.vid})`;
      case 'settlement': return `🏠 開拓地 (頂点 #${a.vid})`;
      case 'road': return `🛣️ 街道 (辺 #${a.eid})`;
      case 'dev': return '📜 発展カード購入';
      case 'trade': return `⚓ 海上交易 ${rj[a.give]||a.give}→${rj[a.get]||a.get}`;
      case 'player_trade': return `🤝 ${targetName(a.target)}と交渉 ${rj[a.give]||a.give}→${rj[a.get]||a.get}`;
      case 'setup_settlement': return `🏠 初期開拓地 (頂点 #${a.vid})`;
      case 'setup_road': return `🛣️ 初期街道 (辺 #${a.eid})`;
      case 'play_dev': {
        const dj = (typeof DEV_JP === 'object') ? DEV_JP : {};
        const icons = { knight:'⚔️', road_building:'🛣️🛣️', year_of_plenty:'🌾', monopoly:'💰' };
        return `${icons[a.cardType]||'📜'} ${dj[a.cardType]||a.cardType}カードを使う`;
      }
      case 'robber': {
        const h = state.board.hexes[a.hid];
        if (!h) return `🏴‍☠️ 盗賊移動`;
        const tj = { forest:'木', hill:'土', field:'麦', pasture:'羊', mountain:'鉄', desert:'砂漠' };
        return `🏴‍☠️ 盗賊を ${tj[h.type]||h.type}(${h.number||'-'}) へ`;
      }
      default: return a.type;
    }
  }

  // ── 島内交渉候補の列挙 ──
  // 自分の不足資源 1個と引き換えに、余剰資源 1個を相手に渡す 1対1取引のみ生成
  // 相手が受諾するか aiAcceptsTrade で事前判定し、受諾者がいる組み合わせのみ残す
  function getPlayerTradeCandidates(pid) {
    if (typeof aiAcceptsTrade !== 'function') return [];
    const p = state.players[pid];
    const needs = (typeof aiResourceNeeds === 'function') ? aiResourceNeeds(p) : {};
    const RES_LIST = ['wood','brick','wheat','sheep','ore'];

    // 不足上位 (get)
    const wantedRes = RES_LIST.filter(r => (needs[r] || 0) > 0)
                              .sort((a,b) => (needs[b]||0) - (needs[a]||0))
                              .slice(0, 3);
    // 余剰 (give): 2枚以上持っていて、欲しい資源には含まれない
    const surplusRes = RES_LIST.filter(r => p.resources[r] >= 2 && !wantedRes.includes(r));

    const cands = [];
    for (const give of surplusRes) {
      for (const get of wantedRes) {
        if (give === get) continue;
        // 1対1の取引
        const giveObj = { wood:0,brick:0,wheat:0,sheep:0,ore:0 };
        const getObj = { wood:0,brick:0,wheat:0,sheep:0,ore:0 };
        giveObj[give] = 1;
        getObj[get] = 1;
        // 受諾する相手を探す
        for (let opp = 0; opp < state.players.length; opp++) {
          if (opp === pid) continue;
          const ai = state.players[opp];
          if (ai.resources[get] < 1) continue; // 相手がその資源を持っていない
          if (!aiAcceptsTrade(ai, giveObj, getObj)) continue;
          cands.push({ type: 'player_trade', give, get, target: opp });
          break; // 1人受諾すれば十分
        }
      }
    }
    return cands;
  }

  // 島内交渉を実行 (直接資源を移動)
  function applyPlayerTrade(pid, action) {
    const me = state.players[pid];
    const target = state.players[action.target];
    if (me.resources[action.give] < 1 || target.resources[action.get] < 1) return false;
    me.resources[action.give]--;
    target.resources[action.give]++;
    target.resources[action.get]--;
    me.resources[action.get]++;
    return true;
  }

  // ── 初期配置候補列挙 ──
  // 開拓地は54頂点全部試すと重いので、ヒューリスティックで上位12個に絞る
  function getSetupCandidates(pid) {
    const cands = [];
    const hasSettToPlace = (state.setupSettlement == null);
    if (hasSettToPlace) {
      const scored = [];
      for (let i = 0; i < state.board.vertices.length; i++) {
        if (!isVertexBuildable(i, pid, true)) continue;
        const s = (typeof evaluateVertex === 'function') ? evaluateVertex(i, pid) : 0;
        scored.push({ vid: i, s });
      }
      scored.sort((a, b) => b.s - a.s);
      for (const c of scored.slice(0, 12)) {
        cands.push({ type: 'setup_settlement', vid: c.vid });
      }
    } else {
      const v = state.board.vertices[state.setupSettlement];
      for (const eid of v.edges) {
        if (isEdgeBuildable(eid, pid, state.setupSettlement)) {
          cands.push({ type: 'setup_road', eid });
        }
      }
    }
    return cands;
  }

  // 初期配置アクションを適用
  function applySetupAction(pid, action) {
    if (action.type === 'setup_settlement') {
      setupPlaceSettlement(action.vid);
      // 続けて、ヒューリスティックで最良の街道を選んで配置
      const v = state.board.vertices[action.vid];
      let bestE = -1, bestScore = -Infinity;
      for (const eid of v.edges) {
        if (!isEdgeBuildable(eid, pid, action.vid)) continue;
        const e = state.board.edges[eid];
        const otherV = e.v1 === action.vid ? e.v2 : e.v1;
        const score = (typeof evaluateVertex === 'function')
          ? evaluateVertex(otherV, pid) : 0;
        if (score > bestScore) { bestScore = score; bestE = eid; }
      }
      if (bestE < 0) {
        for (const eid of v.edges) if (isEdgeBuildable(eid, pid, action.vid)) { bestE = eid; break; }
      }
      if (bestE >= 0) setupPlaceRoad(bestE);
    } else if (action.type === 'setup_road') {
      setupPlaceRoad(action.eid);
    }
  }

  // ── 発展カードの「使用」候補列挙 ──
  function getDevPlayCandidates(pid) {
    const p = state.players[pid];
    if (p.playedDevThisTurn) return [];
    const types = new Set();
    for (const c of p.devCards) {
      if (c.type === 'vp') continue;
      if (c.boughtTurn === state.turn) continue; // 同ターン購入カードは使えない
      types.add(c.type);
    }
    return Array.from(types).map(t => ({ type: 'play_dev', cardType: t }));
  }

  // ── 盗賊配置候補 (moveRobber フェーズ用) ──
  function getRobberCandidates(pid) {
    const cands = [];
    for (let h = 0; h < state.board.hexes.length; h++) {
      const hex = state.board.hexes[h];
      if (hex.hasRobber) continue;
      // 砂漠は除外しない (戦略的に砂漠に置く価値あり)
      let touchesUs = false;
      for (const vid of hex.vertices) {
        const v = state.board.vertices[vid];
        if (v.building && v.building.player === pid) { touchesUs = true; break; }
      }
      if (touchesUs) continue;
      cands.push({ type: 'robber', hid: h });
    }
    return cands;
  }

  // ── 候補手列挙 (nn.js のロジック再利用) + 島内交渉 + 発展カード使用 ──
  function getCandidates(pid) {
    if (typeof nnEnumerateActions !== 'function') return [{type:'end_turn'}];
    const base = nnEnumerateActions(pid);
    const playerTrades = getPlayerTradeCandidates(pid);
    const devPlays = getDevPlayCandidates(pid);
    return base.concat(playerTrades).concat(devPlays);
  }

  // 任意のアクションを盤面に適用 (player_trade / play_dev / robber も含む)
  function applyAnyAction(pid, action) {
    if (action.type === 'end_turn') return true;
    if (action.type === 'player_trade') return applyPlayerTrade(pid, action);
    if (action.type === 'play_dev') {
      const p = state.players[pid];
      for (let i = 0; i < p.devCards.length; i++) {
        const c = p.devCards[i];
        if (c.type === action.cardType && c.boughtTurn < state.turn) {
          playDevCard(p, i);
          return true;
        }
      }
      return false;
    }
    if (action.type === 'robber') {
      if (typeof moveRobberTo === 'function') moveRobberTo(action.hid);
      return true;
    }
    nnApplyAction(pid, action);
    return true;
  }

  // ── 1 候補アクションを評価 ──
  // 返り値: {winRate, immediateRate, avgTurnsToWin}
  // immediateRate = このターン (まだ自分の手番) で勝てた割合
  // avgTurnsToWin = 勝った場合のターン経過数の平均 (低いほど早く勝つ)
  // ロールアウト中の共通フラグ管理:
  // - _rolloutStrongAll: 4人全員が強力AIポリシーで打つ (現実的な対局想定 → 精度向上)
  // - _insideMCTSRollout: NN/MCTS CPU の再帰呼び出しを防止
  function withRolloutFlags(fn) {
    const savedStrongAll = window._rolloutStrongAll;
    const savedInside = (typeof _insideMCTSRollout !== 'undefined') ? _insideMCTSRollout : false;
    window._rolloutStrongAll = true;
    if (typeof _insideMCTSRollout !== 'undefined') _insideMCTSRollout = true;
    try {
      return fn();
    } finally {
      window._rolloutStrongAll = savedStrongAll;
      if (typeof _insideMCTSRollout !== 'undefined') _insideMCTSRollout = savedInside;
    }
  }

  function evaluateAction(pid, action, rolloutsPerAction, snap, seeds) {
    return withRolloutFlags(() => {
    let wins = 0, immediate = 0, turnsSum = 0;
    const startTurnVal = snap.turn;
    for (let i = 0; i < rolloutsPerAction; i++) {
      if (seeds) Math.random = makeRng(seeds[i]);
      rolloutRestore(snap);
      for (const p of state.players) p.isAI = true;
      try {
        if (state.phase === 'setup1' || state.phase === 'setup2') {
          applySetupAction(pid, action);
        } else if (state.phase === 'moveRobber') {
          applyAnyAction(pid, action); // robber 移動 → finishRobber で main へ
        } else if (action.type === 'end_turn') {
          if (typeof endTurn === 'function') endTurn();
        } else {
          applyAnyAction(pid, action);
        }
      } catch (e) { break; }
      runRollout();
      if (attributedWinner() === pid) {
        wins++;
        const elapsed = Math.max(0, state.turn - startTurnVal);
        turnsSum += elapsed;
        if (elapsed === 0) immediate++;
      }
    }
    return {
      winRate: wins / rolloutsPerAction,
      immediateRate: immediate / rolloutsPerAction,
      avgTurnsToWin: wins > 0 ? turnsSum / wins : null
    };
    });
  }

  function evaluateSequence(pid, actions, rolloutsPerAction, snap, seeds) {
    return withRolloutFlags(() => {
    let wins = 0, immediate = 0, turnsSum = 0;
    const startTurnVal = snap.turn;
    for (let i = 0; i < rolloutsPerAction; i++) {
      if (seeds) Math.random = makeRng(seeds[i]);
      rolloutRestore(snap);
      for (const p of state.players) p.isAI = true;
      try {
        let endNow = false;
        for (const a of actions) {
          if (a.type === 'end_turn') { endNow = true; break; }
          applyAnyAction(pid, a);
        }
        if (endNow && typeof endTurn === 'function') endTurn();
      } catch (e) { break; }
      runRollout();
      if (attributedWinner() === pid) {
        wins++;
        const elapsed = Math.max(0, state.turn - startTurnVal);
        turnsSum += elapsed;
        if (elapsed === 0) immediate++;
      }
    }
    return {
      winRate: wins / rolloutsPerAction,
      immediateRate: immediate / rolloutsPerAction,
      avgTurnsToWin: wins > 0 ? turnsSum / wins : null
    };
    });
  }

  // ── 逐次絞り込み (Sequential Halving) 評価 ──
  // 全候補を少数ロールアウトでスクリーニング → 上位候補のみ2倍精度で再評価。
  // 同じ計算量でも有望手まわりの勝率推定精度が大きく上がる。
  function evaluateCandidatesSH(pid, actions, rolloutsPerAction) {
    if (!actions || actions.length === 0) return [];
    const rootSnap = rolloutSnapshot();
    const wasFast = _fastMode;
    const wasNN = (typeof useNN !== 'undefined') ? useNN : false;
    const origRandom = Math.random;
    if (typeof useNN !== 'undefined') useNN = false;
    _fastMode = true;

    const R = Math.max(4, rolloutsPerAction | 0);
    const baseSeed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    const allSeeds = [];
    for (let i = 0; i < R * 2; i++) {
      allSeeds.push(((baseSeed + (i + 17) * 2654435761) >>> 0) || 1);
    }
    const mkResult = (action, ev, n) => ({
      sequence: [action],
      label: describeAction(action),
      winRate: ev.winRate,
      immediateRate: ev.immediateRate,
      avgTurnsToWin: ev.avgTurnsToWin,
      rollouts: n
    });

    try {
      const results = [];
      if (actions.length <= 4) {
        // 候補が少なければ全件フル精度 (2R)
        for (const a of actions) {
          results.push(mkResult(a, evaluateAction(pid, a, R * 2, rootSnap, allSeeds), R * 2));
        }
        results.sort(compareResults);
        return results;
      }
      // ステージ1: 全候補を R/4 でスクリーニング (共通乱数で比較)
      const r1 = Math.max(4, Math.round(R / 4));
      const seeds1 = allSeeds.slice(0, r1);
      const screened = actions.map(a => ({ action: a, ev: evaluateAction(pid, a, r1, rootSnap, seeds1) }));
      screened.sort((x, y) => compareResults(x.ev, y.ev));
      // ステージ2: 上位6候補 (+end_turn は基準値として必ず含める) を 2R で精密評価
      const finalSet = new Set(screened.slice(0, 6));
      const endRow = screened.find(s => s.action.type === 'end_turn');
      if (endRow) finalSet.add(endRow);
      for (const s of screened) {
        if (finalSet.has(s)) {
          results.push(mkResult(s.action, evaluateAction(pid, s.action, R * 2, rootSnap, allSeeds), R * 2));
        } else {
          results.push(mkResult(s.action, s.ev, r1));
        }
      }
      results.sort(compareResults);
      return results;
    } finally {
      rolloutRestore(rootSnap);
      _fastMode = wasFast;
      if (typeof useNN !== 'undefined') useNN = wasNN;
      Math.random = origRandom;
    }
  }

  // タイブレイク順比較: winRate → immediateRate → -avgTurnsToWin
  function compareResults(a, b) {
    if (Math.abs(a.winRate - b.winRate) > 0.001) return b.winRate - a.winRate;
    if (Math.abs(a.immediateRate - b.immediateRate) > 0.001) return b.immediateRate - a.immediateRate;
    const at = a.avgTurnsToWin == null ? 999 : a.avgTurnsToWin;
    const bt = b.avgTurnsToWin == null ? 999 : b.avgTurnsToWin;
    return at - bt;
  }

  // ── MCTS 分析 (P0 = 人間プレイヤー視点) ──
  // depth=1: 単一アクションの勝率比較 (従来通り)
  // depth=2: 上位5アクション × 続きの上位3アクション = 15 シーケンス
  // depth=3: 上位4 × 上位3 × 上位2 = 24 シーケンス
  function analyze(rolloutsPerAction, depth) {
    depth = depth || 1;
    const setupPhase = state.phase === 'setup1' || state.phase === 'setup2';
    const robberPhase = state.phase === 'moveRobber';
    if (state.phase !== 'main' && !setupPhase && !robberPhase) return null;
    const pid = state.currentPlayer;
    const rootSnap = rolloutSnapshot();
    const wasFast = _fastMode;
    const wasNN = (typeof useNN !== 'undefined') ? useNN : false;

    if (typeof useNN !== 'undefined') useNN = false;
    _fastMode = true;

    const actions = setupPhase ? getSetupCandidates(pid)
                  : robberPhase ? getRobberCandidates(pid)
                  : getCandidates(pid);

    // 共通乱数法のシード列
    // - 1分析内では全候補で同じ系列 (分散削減のため)
    // - 別の分析時には別の系列 (毎回違う結果が出るように、Date.now を混ぜる)
    const baseSeed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
    const seeds = [];
    for (let i = 0; i < rolloutsPerAction; i++) {
      seeds.push(((baseSeed + (i + 17) * 2654435761) >>> 0) || 1);
    }
    const origRandom = Math.random;

    try {
      // ─ depth 1 ─ (setup/robber フェーズも常に1手読み)
      // 逐次絞り込み: 有望手は指定値の2倍のロールアウトで精密評価される
      if (depth === 1 || setupPhase || robberPhase) {
        return evaluateCandidatesSH(pid, actions, rolloutsPerAction);
      }

      // ─ depth 2 or 3 ─ (シーケンス探索、main フェーズのみ)
      // 1手目に end_turn は除外
      const firstActions = actions.filter(a => a.type !== 'end_turn');
      // スクリーニング用の少ロールアウト & シード
      const screenRolls = Math.max(5, Math.floor(rolloutsPerAction / 4));
      const screenSeeds = seeds.slice(0, screenRolls);
      const firstScored = [];
      for (const a of firstActions) {
        const ev = evaluateAction(pid, a, screenRolls, rootSnap, screenSeeds);
        // スクリーニング用のソートスコア (タイブレイク込み)
        firstScored.push({ action: a, ev, score: ev.winRate * 1000 + ev.immediateRate * 10 - (ev.avgTurnsToWin || 99) * 0.01 });
      }
      firstScored.sort((x, y) => y.score - x.score);
      const topFirst = firstScored.slice(0, depth === 2 ? 5 : 4);

      const results = [];
      for (const fs of topFirst) {
        // 1手目を適用して、その後の候補を列挙
        rolloutRestore(rootSnap);
        for (const p of state.players) p.isAI = true;
        try {
          if (fs.action.type !== 'end_turn') applyAnyAction(pid, fs.action);
        } catch (e) { rolloutRestore(rootSnap); continue; }
        const afterFirst = rolloutSnapshot();
        const secondCands = getCandidates(pid);

        // 2手目をスクリーニング
        const secondScored = [];
        for (const sa of secondCands) {
          if (sa.type === 'end_turn') continue;
          const ev = evaluateAction(pid, sa, screenRolls, afterFirst, screenSeeds);
          secondScored.push({ action: sa, score: ev.winRate * 1000 + ev.immediateRate * 10 - (ev.avgTurnsToWin || 99) * 0.01 });
        }
        secondScored.sort((x, y) => y.score - x.score);
        const topSecond = secondScored.slice(0, depth === 2 ? 3 : 3);

        if (depth === 2) {
          for (const ss of topSecond) {
            const ev = evaluateSequence(pid, [fs.action, ss.action], rolloutsPerAction, rootSnap, seeds);
            results.push({
              sequence: [fs.action, ss.action],
              label: `${describeAction(fs.action)} → ${describeAction(ss.action)}`,
              winRate: ev.winRate,
              immediateRate: ev.immediateRate,
              avgTurnsToWin: ev.avgTurnsToWin,
              rollouts: rolloutsPerAction
            });
          }
        } else {
          for (const ss of topSecond) {
            rolloutRestore(afterFirst);
            try { applyAnyAction(pid, ss.action); } catch (e) { continue; }
            const afterSecond = rolloutSnapshot();
            const thirdCands = getCandidates(pid);
            const thirdScored = [];
            for (const ta of thirdCands) {
              if (ta.type === 'end_turn') continue;
              const ev = evaluateAction(pid, ta, screenRolls, afterSecond, screenSeeds);
              thirdScored.push({ action: ta, score: ev.winRate * 1000 + ev.immediateRate * 10 - (ev.avgTurnsToWin || 99) * 0.01 });
            }
            thirdScored.sort((x, y) => y.score - x.score);
            const topThird = thirdScored.slice(0, 2);
            for (const ts of topThird) {
              const ev = evaluateSequence(pid, [fs.action, ss.action, ts.action], rolloutsPerAction, rootSnap, seeds);
              results.push({
                sequence: [fs.action, ss.action, ts.action],
                label: `${describeAction(fs.action)} → ${describeAction(ss.action)} → ${describeAction(ts.action)}`,
                winRate: ev.winRate,
                immediateRate: ev.immediateRate,
                avgTurnsToWin: ev.avgTurnsToWin,
                rollouts: rolloutsPerAction
              });
            }
          }
        }
      }
      results.sort(compareResults);
      return results;

    } finally {
      rolloutRestore(rootSnap);
      _fastMode = wasFast;
      if (typeof useNN !== 'undefined') useNN = wasNN;
      Math.random = origRandom;
    }
  }

  // ── UI パネル ──
  function ensurePanel() {
    if (document.getElementById('hints-panel')) return;
    const status = document.getElementById('status-panel');
    if (!status) return;
    const wrap = document.createElement('details');
    wrap.id = 'hints-panel';
    wrap.open = false; // デフォルト閉じる (重いので)
    wrap.innerHTML = `
      <summary>🎯 勝率・最善手予測 (MCTS)</summary>
      <div class="hints-content">
        <div id="hint-winrate">勝率: --</div>
        <div id="hint-actions" class="hint-actions">「最善手を分析」を押してください</div>
        <div class="hint-controls">
          <button id="btn-analyze" class="hint-btn">最善手を分析</button>
          <label class="hint-label-row">
            ロールアウト数:
            <select id="sel-rollouts">
              <option value="30">30 (高速・約3秒)</option>
              <option value="100" selected>100 (推奨・精密・約10秒)</option>
              <option value="300">300 (超精密・約30秒)</option>
              <option value="1000">1000 (最高精度・約100秒)</option>
            </select>
          </label>
          <label class="hint-label-row">
            読み深さ:
            <select id="sel-depth">
              <option value="1" selected>1手 (高速)</option>
              <option value="2">2手 (連続行動)</option>
              <option value="3">3手 (深い読み・遅い)</option>
            </select>
          </label>
          <label class="hint-auto">
            <input type="checkbox" id="chk-auto-analyze"> 自分のターンで自動分析
          </label>
          <label class="hint-auto">
            <input type="checkbox" id="chk-show-turns"> 📊 平均勝利ターン数を常時表示
          </label>
        </div>
      </div>
    `;
    status.insertAdjacentElement('afterend', wrap);

    document.getElementById('btn-analyze').addEventListener('click', () => runAnalysisUI());
    document.getElementById('chk-auto-analyze').addEventListener('change', e => {
      autoAnalyze = e.target.checked;
      if (autoAnalyze) runAnalysisUI();
    });
    // メトリクス常時表示トグル → 既存の結果を即座に再描画
    const chkTurns = document.getElementById('chk-show-turns');
    if (chkTurns) {
      chkTurns.addEventListener('change', () => {
        const actionsEl = document.getElementById('hint-actions');
        if (_lastResults && actionsEl) {
          renderResultsList(actionsEl, _lastResults, _lastDepth);
        }
      });
    }
  }

  function runAnalysisUI() {
    if (analyzing) return;
    if (typeof nnSnapshot !== 'function' || typeof nnRestore !== 'function') {
      const el = document.getElementById('hint-actions');
      if (el) el.textContent = '⚠️ NN モジュール未ロード';
      return;
    }
    const isSetup = state.phase === 'setup1' || state.phase === 'setup2';
    const isRobber = state.phase === 'moveRobber';
    const phaseOK = (state.phase === 'main' || isSetup || isRobber)
                    && state.currentPlayer === 0
                    && !state.players[0].isAI;
    if (!phaseOK) {
      document.getElementById('hint-actions').textContent =
        '(分析できるのは初期配置/メイン/盗賊配置のあなたの番のみ)';
      return;
    }
    analyzing = true;
    const btn = document.getElementById('btn-analyze');
    const actionsEl = document.getElementById('hint-actions');
    const wrEl = document.getElementById('hint-winrate');
    const sel = document.getElementById('sel-rollouts');
    const numRollouts = parseInt(sel?.value) || 30;

    if (btn) btn.disabled = true;
    const depthSelInit = document.getElementById('sel-depth');
    const depthForDisplay = parseInt(depthSelInit?.value) || 1;
    if (actionsEl) actionsEl.innerHTML =
      `<span class="thinking">考え中... ${depthForDisplay}手読み (${numRollouts} ロールアウト × 候補手数)</span>`;

    const depthSel = document.getElementById('sel-depth');
    const depth = parseInt(depthSel?.value) || 1;

    // 描画を更新してから重い計算を実行
    requestAnimationFrame(() => setTimeout(() => {
      const t0 = performance.now();
      try {
        const results = analyze(numRollouts, depth);
        const dt = ((performance.now() - t0) / 1000).toFixed(1);
        if (!results || results.length === 0) {
          if (actionsEl) actionsEl.textContent = '分析できませんでした';
          return;
        }
        const best = results[0];
        if (wrEl) {
          const pct = (best.winRate * 100).toFixed(1);
          let color = '#ffea7a';
          if (best.winRate >= 0.5) color = '#7ee87e';
          else if (best.winRate < 0.2) color = '#f88';
          wrEl.innerHTML = `最善手の推定勝率: <b style="color:${color}">${pct}%</b> <span class="hint-meta">(${dt}秒, ${depth}手読み)</span>`;
        }
        _lastResults = results;
        _lastDepth = depth;
        renderResultsList(actionsEl, results, depth);
      } catch (e) {
        console.error('analyze error', e);
        if (actionsEl) actionsEl.textContent = '⚠️ エラー: ' + e.message;
      } finally {
        analyzing = false;
        if (btn) btn.disabled = false;
      }
    }, 30));
  }

  // 結果リストを描画 (チェックボックス切替時にも再利用)
  function renderResultsList(actionsEl, results, depth) {
    if (!actionsEl || !results) return;
    const top = results.slice(0, depth === 1 ? 7 : 8);
    const showTurnsAlways = document.getElementById('chk-show-turns')?.checked;
    const allSameWinRate = top.every(x => Math.abs(x.winRate - top[0].winRate) < 0.001);

    actionsEl.innerHTML = top.map((r, i) => {
      const metaParts = [];
      if (r.immediateRate > 0 && (r.winRate >= 0.99 || showTurnsAlways)) {
        metaParts.push(`⚡ 今ターン勝ち ${(r.immediateRate * 100).toFixed(0)}%`);
      }
      if (r.avgTurnsToWin != null &&
          (showTurnsAlways || (allSameWinRate && r.winRate >= 0.5))) {
        metaParts.push(`平均 ${r.avgTurnsToWin.toFixed(1)} ターンで勝利`);
      }
      if (showTurnsAlways && r.avgTurnsToWin == null && r.winRate < 0.01) {
        metaParts.push('勝てず');
      }
      const meta = metaParts.length
        ? `<span class="hint-meta-sub">${metaParts.join(' / ')}</span>`
        : '';
      // 95%信頼区間 (±)。ロールアウト数が多いほど狭くなる
      let ciStr = '';
      if (r.rollouts) {
        const pc = Math.min(0.98, Math.max(0.02, r.winRate));
        const ci = 1.96 * Math.sqrt(pc * (1 - pc) / r.rollouts) * 100;
        ciStr = `<span class="hint-meta">±${ci.toFixed(1)}</span>`;
      }
      return `
        <div class="hint-row ${i===0?'best':''}" data-row-idx="${i}">
          <span class="hint-rank">${i+1}.</span>
          <span class="hint-act">${r.label}${meta}</span>
          <span class="hint-rate">${(r.winRate * 100).toFixed(1)}%${ciStr}</span>
        </div>
      `;
    }).join('');

    // 各行にホバーハイライト + クリックで実行
    actionsEl.querySelectorAll('.hint-row').forEach(row => {
      const idx = parseInt(row.dataset.rowIdx);
      const r = top[idx];
      const sequence = r.sequence || [r.action];
      const targets = sequence
        .map((a, step) => {
          const tgt = targetFromAction(a);
          return tgt ? { ...tgt, step: step + 1 } : null;
        })
        .filter(Boolean);
      if (targets.length > 0) {
        row.addEventListener('mouseenter', () => setHintTarget(targets));
        row.addEventListener('mouseleave', () => setHintTarget(null));
      }
      // 全行クリック可能 (盤面対象なし=dev/trade/end_turnも実行できる)
      row.classList.add('hoverable', 'clickable');
      row.addEventListener('click', () => {
        setHintTarget(null);
        confirmAndExecute(sequence, r.winRate);
      });
    });
  }

  // 確認ダイアログを出してシーケンス実行
  function confirmAndExecute(sequence, winRate) {
    if (executingSequence) return; // 既に実行中なら二重実行を防止
    if (typeof showModal !== 'function' || typeof hideModal !== 'function') {
      executeSequence(sequence);
      return;
    }
    const msg = sequence.map(a => describeAction(a)).join(' → ');
    const wrText = winRate != null ? `<div style="margin-top:8px;font-size:12px;color:#aac">推定勝率: ${(winRate * 100).toFixed(1)}%</div>` : '';
    showModal('行動を実行しますか?',
      `<div style="font-size:13px;color:#ffea7a;line-height:1.6">${msg}</div>${wrText}`,
      `<button id="confirm-yes" style="background:linear-gradient(135deg,#4a8a4a,#3a7a3a);border-color:#6aaa6a">はい (Y)</button>
       <button id="confirm-no">いいえ (N)</button>`
    );
    const onYes = () => {
      if (executingSequence) return; // ボタンが二重押されないよう確認
      executingSequence = true;
      cleanup();
      hideModal();
      executeSequence(sequence);
      executingSequence = false;
    };
    const onNo = () => { cleanup(); hideModal(); };
    const onKey = (e) => {
      if (e.key === 'y' || e.key === 'Y' || e.key === 'Enter') { e.preventDefault(); onYes(); }
      else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); onNo(); }
    };
    const cleanup = () => document.removeEventListener('keydown', onKey, true);
    document.getElementById('confirm-yes').onclick = onYes;
    document.getElementById('confirm-no').onclick = onNo;
    document.addEventListener('keydown', onKey, true);
  }

  // シーケンスを実際のゲームに適用
  function executeSequence(sequence) {
    const pid = state.currentPlayer;
    for (const action of sequence) {
      const ok = executeRealAction(pid, action);
      if (!ok) {
        if (typeof logMsg === 'function') {
          logMsg(`実行できませんでした: ${describeAction(action)}`, 'important');
        }
        break;
      }
    }
    if (typeof updateUI === 'function') updateUI();
  }

  // 1 アクションを実ゲームに適用 (失敗時 false)
  function executeRealAction(pid, action) {
    const p = state.players[pid];
    switch (action.type) {
      case 'end_turn':
        if (state.phase !== 'main' || pid !== state.currentPlayer) return false;
        endTurn();
        return true;

      case 'city': {
        if (!canAffordCity(p) || p.cities.length >= PIECES_PER_PLAYER.city) return false;
        if (!p.settlements.includes(action.vid)) return false;
        payCost(p, COSTS.city);
        placeCity(pid, action.vid);
        if (typeof logMsg === 'function') logMsg(`${p.name}が都市を建設 [ヒント]`);
        return true;
      }

      case 'settlement': {
        if (!canAffordSettlement(p) || p.settlements.length >= PIECES_PER_PLAYER.settlement) return false;
        if (!isVertexBuildable(action.vid, pid, false)) return false;
        payCost(p, COSTS.settlement);
        placeSettlement(pid, action.vid);
        if (typeof logMsg === 'function') logMsg(`${p.name}が開拓地を建設 [ヒント]`);
        return true;
      }

      case 'road': {
        if (!canAffordRoad(p) || p.roads.length >= PIECES_PER_PLAYER.road) return false;
        if (!isEdgeBuildable(action.eid, pid, null)) return false;
        payCost(p, COSTS.road);
        placeRoad(pid, action.eid);
        if (typeof logMsg === 'function') logMsg(`${p.name}が街道を建設 [ヒント]`);
        return true;
      }

      case 'dev':
        return buyDevCard(p);

      case 'trade': {
        if (typeof maritimeTrade !== 'function') return false;
        return maritimeTrade(p, action.give, action.get);
      }

      case 'player_trade': {
        if (typeof proposeTrade !== 'function') return false;
        const giveObj = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
        const getObj  = { wood:0, brick:0, wheat:0, sheep:0, ore:0 };
        giveObj[action.give] = 1;
        getObj[action.get]   = 1;
        // 受諾しなかった場合は proposeTrade 内でログ出る
        proposeTrade(p, [action.target], giveObj, getObj);
        return true;
      }

      case 'setup_settlement': {
        if (state.phase !== 'setup1' && state.phase !== 'setup2') return false;
        return setupPlaceSettlement(action.vid);
      }

      case 'setup_road': {
        if (state.phase !== 'setup1' && state.phase !== 'setup2') return false;
        if (state.setupSettlement == null) return false;
        return setupPlaceRoad(action.eid);
      }

      case 'play_dev': {
        if (p.playedDevThisTurn) return false;
        for (let i = 0; i < p.devCards.length; i++) {
          const c = p.devCards[i];
          if (c.type === action.cardType && c.boughtTurn < state.turn) {
            return playDevCard(p, i);
          }
        }
        return false;
      }

      case 'robber': {
        if (state.phase !== 'moveRobber') return false;
        if (typeof moveRobberTo !== 'function') return false;
        moveRobberTo(action.hid);
        return true;
      }

      default:
        return false;
    }
  }

  window.runAnalysisUI = runAnalysisUI;

  // ── MCTS API 露出（AlphaZero 学習用 + 最強CPU用） ──
  window._analysisEval = {
    rolloutSnapshot,
    rolloutRestore,
    evaluateAction,
    evaluateCandidatesSH,
    getCandidates,
    getSetupCandidates,
    getRobberCandidates,
    describeAction,
    executeRealAction,
    generateSeeds: (n) => {
      const baseSeed = (Date.now() ^ Math.floor(Math.random() * 0xFFFFFFFF)) >>> 0;
      return Array.from({length: n}, (_, i) => ((baseSeed + (i + 17) * 2654435761) >>> 0) || 1);
    }
  };

  // ── 初期化 ──
  window.addEventListener('load', () => {
    ensurePanel();

    // 自分のターン開始時に自動分析 (auto モード時)
    const origUpdateUI = window.updateUI;
    if (typeof origUpdateUI === 'function') {
      window.updateUI = function(...args) {
        const r = origUpdateUI.apply(this, args);
        if (!autoAnalyze) return r;
        if (!state) return r;
        const isSetup = state.phase === 'setup1' || state.phase === 'setup2';
        const isRobber = state.phase === 'moveRobber';
        if (state.phase !== 'main' && !isSetup && !isRobber) return r;
        if (state.currentPlayer !== 0) return r;
        if (state.players[0].isAI) return r;
        // 初期配置時は setupSettlement の有無でキーを分ける (settlement と road を別々に分析)
        const key = `${state.turn}-${state.currentPlayer}-${state.phase}-${state.setupSettlement ?? 'none'}-${state.setupIndex ?? 0}`;
        if (lastAnalysisKey !== key && !analyzing) {
          lastAnalysisKey = key;
          runAnalysisUI();
        }
        return r;
      };
    }
  });
})();
