// ============================================================
//  最強CPU (MCTS): 全フェーズで勝率予測の最善手を打ち続けるCPU
//
//  - 初期配置 / メインターン / 盗賊配置のすべての判断を、
//    analysis.js のモンテカルロロールアウト評価 (共通乱数 + 逐次絞り込み)
//    で行い、推定勝率が最大の手を常に選択する。
//  - 「🎯 勝率・最善手予測」パネルと同じ評価エンジンを使うため、
//    パネルの精度向上 (VP帰属 / 全員強力AIロールアウト) の恩恵も受ける。
//  - ロールアウト中 (_insideMCTSRollout) や学習中 (trainRunning) は
//    無効化され、従来の強力AI/ヒューリスティックにフォールバックする。
// ============================================================

var mctsCpuEnabled = false;
var mctsCpuRollouts = 20; // 候補1つあたりの基準ロールアウト数 (有望手は2倍で精密評価)

(function installMctsCpu() {
  const prevSetup = aiSetupTurn;
  const prevMain = aiMainTurn;
  const prevRobber = aiMoveRobber;

  function active() {
    if (!mctsCpuEnabled) return false;
    if (typeof window._analysisEval === 'undefined') return false;
    if (typeof _insideMCTSRollout !== 'undefined' && _insideMCTSRollout) return false;
    if (typeof trainRunning !== 'undefined' && trainRunning) return false;
    if (typeof _fastMode !== 'undefined' && _fastMode) return false;
    if (window._rolloutStrongAll === true) return false;
    if (!state || !state.players[state.currentPlayer]) return false;
    return state.players[state.currentPlayer].isAI === true;
  }

  function think() {
    const el = document.getElementById('overlay-msg');
    if (el) {
      el.textContent = `🧠 ${state.players[state.currentPlayer].name} 思考中 (MCTS×${mctsCpuRollouts})...`;
      el.classList.add('show');
    }
  }
  function doneThinking() {
    const el = document.getElementById('overlay-msg');
    if (el) el.classList.remove('show');
  }

  // ── メインターン: 勝率最大の手を1手ずつ実行 ──
  function mctsCpuMainTurn() {
    if (state.phase !== 'main') return;
    if (checkWin()) return;
    const pid = state.currentPlayer;
    const A = window._analysisEval;
    think();
    // 描画してから重い計算へ
    setTimeout(() => {
      let results = null;
      try {
        // 人間が応諾判断できない自動成立取引は除外 (公平性のため)
        const cands = A.getCandidates(pid).filter(a =>
          !(a.type === 'player_trade' && state.players[a.target] && !state.players[a.target].isAI));
        results = A.evaluateCandidatesSH(pid, cands, mctsCpuRollouts);
      } catch (e) { console.error('MCTS CPU main error', e); }
      doneThinking();
      if (!results || results.length === 0) { setTimeout(endTurn, 200); return; }

      const best = results[0];
      const action = best.sequence[0];
      if (action.type === 'end_turn') { setTimeout(endTurn, 200); return; }

      logMsg(`${state.players[pid].name} [MCTS 勝率${(best.winRate * 100).toFixed(0)}%]: ${A.describeAction(action)}`);
      let ok = false;
      try { ok = A.executeRealAction(pid, action); } catch (e) { console.error(e); }
      if (!ok) { setTimeout(endTurn, 200); return; }
      if (checkWin()) return;

      // 騎士 → moveRobber、街道建設カード → aiPlaceFreeRoads が
      // それぞれ自前で aiMainTurn を再スケジュールするので二重起動を避ける
      const selfReschedules = action.type === 'play_dev' &&
        (action.cardType === 'knight' || action.cardType === 'road_building');
      if (!selfReschedules && state.phase === 'main' && state.currentPlayer === pid) {
        setTimeout(mctsCpuMainTurn, 250);
      }
    }, 30);
  }

  // ── 初期配置: 開拓地 → 街道 の2段階をどちらもMCTS評価 ──
  function mctsCpuSetupTurn() {
    const pid = state.currentPlayer;
    const A = window._analysisEval;
    think();
    setTimeout(() => {
      let results = null;
      try {
        results = A.evaluateCandidatesSH(pid, A.getSetupCandidates(pid), mctsCpuRollouts);
      } catch (e) { console.error('MCTS CPU setup error', e); }
      if (!results || results.length === 0) {
        doneThinking();
        state.setupIndex++;
        setTimeout(setupStep, 100);
        return;
      }
      const settle = results[0].sequence[0];
      setupPlaceSettlement(settle.vid);

      // 街道ステージ (setupSettlement がセットされたので候補は setup_road になる)
      setTimeout(() => {
        let pick = null;
        try {
          const roadCands = A.getSetupCandidates(pid);
          if (roadCands.length === 1) {
            pick = roadCands[0];
          } else if (roadCands.length > 1) {
            const rr = A.evaluateCandidatesSH(pid, roadCands, Math.max(8, mctsCpuRollouts >> 1));
            pick = rr[0].sequence[0];
          }
        } catch (e) { console.error('MCTS CPU setup road error', e); }
        doneThinking();
        if (!pick) { state.setupIndex++; setTimeout(setupStep, 100); return; }
        setupPlaceRoad(pick.eid);
      }, 30);
    }, 30);
  }

  // ── 盗賊配置: 全候補タイルをロールアウト評価 ──
  function mctsCpuMoveRobber() {
    const pid = state.currentPlayer;
    const A = window._analysisEval;
    const cands = A.getRobberCandidates(pid);
    if (cands.length === 0) return prevRobber();
    think();
    setTimeout(() => {
      let results = null;
      try {
        results = A.evaluateCandidatesSH(pid, cands, mctsCpuRollouts);
      } catch (e) { console.error('MCTS CPU robber error', e); }
      doneThinking();
      if (!results || results.length === 0) return prevRobber();
      moveRobberTo(results[0].sequence[0].hid);
    }, 30);
  }

  aiSetupTurn = function() {
    if (active()) return mctsCpuSetupTurn();
    return prevSetup();
  };
  aiMainTurn = function() {
    if (active()) return mctsCpuMainTurn();
    return prevMain();
  };
  aiMoveRobber = function() {
    if (active()) return mctsCpuMoveRobber();
    return prevRobber();
  };

  // ── UI 配線 ──
  window.addEventListener('load', () => {
    const chk = document.getElementById('chk-mcts-cpu');
    if (chk) {
      mctsCpuEnabled = chk.checked;
      chk.addEventListener('change', e => {
        mctsCpuEnabled = e.target.checked;
        if (typeof setStatus === 'function') {
          setStatus(mctsCpuEnabled
            ? `🧠 最強CPU(MCTS) 有効: AI全員が勝率最大の手を打ちます (思考に数秒かかります)`
            : '最強CPU(MCTS) 無効');
        }
      });
    }
    const sel = document.getElementById('sel-mcts-cpu-level');
    if (sel) {
      mctsCpuRollouts = parseInt(sel.value) || 20;
      sel.addEventListener('change', e => {
        mctsCpuRollouts = parseInt(e.target.value) || 20;
        if (typeof setStatus === 'function') {
          setStatus(`最強CPUの思考量: ${mctsCpuRollouts}ロールアウト/候補 (有望手は${mctsCpuRollouts * 2})`);
        }
      });
    }
  });
})();
