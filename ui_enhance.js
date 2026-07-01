// ============================================================
//  UI Enhancements
//  - ヘルプモーダル
//  - キーボードショートカット
//  - 押せないボタンのホバーツールチップ
// ============================================================

(function initUIEnhance() {
  // ── ヘルプモーダル ──
  function showHelp() {
    if (typeof showModal !== 'function') return;
    const html = `
      <div class="help-section">
        <h3>🎯 勝利条件</h3>
        <p>勝利点 (VP) を <b>10</b> 集めた最初のプレイヤーが勝ち。</p>
      </div>
      <div class="help-section">
        <h3>💎 勝利点の集め方</h3>
        <table>
          <tr><td>🏠 開拓地</td><td>1 VP / 個</td></tr>
          <tr><td>🏰 都市</td><td>2 VP / 個 (開拓地を昇格)</td></tr>
          <tr><td>🛣️ 最長街道</td><td>5本以上で最長なら +2 VP</td></tr>
          <tr><td>⚔️ 最大騎士力</td><td>騎士カード3枚以上で最多なら +2 VP</td></tr>
          <tr><td>📜 勝利点カード</td><td>発展カードに当たれば +1 VP (隠し)</td></tr>
        </table>
      </div>
      <div class="help-section">
        <h3>💰 建設コスト</h3>
        <table>
          <tr><td>🛣️ 道</td><td>木 + 土</td></tr>
          <tr><td>🏠 開拓地</td><td>木 + 土 + 麦 + 羊</td></tr>
          <tr><td>🏰 都市</td><td>麦 × 2 + 鉱石 × 3</td></tr>
          <tr><td>📜 発展カード</td><td>麦 + 羊 + 鉱石</td></tr>
        </table>
      </div>
      <div class="help-section">
        <h3>⌨️ キーボードショートカット</h3>
        <table>
          <tr><td><span class="kbd">R</span></td><td>サイコロを振る</td></tr>
          <tr><td><span class="kbd">O</span></td><td>道を建てる</td></tr>
          <tr><td><span class="kbd">S</span></td><td>開拓地を建てる</td></tr>
          <tr><td><span class="kbd">C</span></td><td>都市を建てる</td></tr>
          <tr><td><span class="kbd">D</span></td><td>発展カードを買う</td></tr>
          <tr><td><span class="kbd">T</span></td><td>取引</td></tr>
          <tr><td><span class="kbd">E</span></td><td>ターン終了</td></tr>
          <tr><td><span class="kbd">Esc</span></td><td>キャンセル</td></tr>
          <tr><td><span class="kbd">?</span></td><td>このヘルプを開く</td></tr>
        </table>
      </div>
      <div class="help-section">
        <h3>🎲 サイコロの仕組み</h3>
        <p>2個のサイコロを振り、出目の合計と同じ数字のタイルに隣接する開拓地は資源1枚、都市は2枚もらえます。</p>
        <p><b>7が出たら</b>: 手札8枚以上のプレイヤーは半分を捨てる。盗賊を移動して相手のカードを1枚奪う。</p>
      </div>
      <div class="help-section">
        <h3>🤖 AIモード</h3>
        <p>サイドバー下の「学習AI設定」を開くと、対戦相手をニューラルネットワーク(NN)に切り替えたり、学習させたりできます。</p>
        <ul style="font-size:12px;color:#bbb;margin:6px 0 0 16px;padding:0">
          <li><b>NN使用</b>: 対戦相手 P1-3 がNNで判断</li>
          <li><b>強力AI(P0)</b>: 評価/学習モード時に P0 が強化AIで動く</li>
          <li><b>自分のプレーを学習</b>: あなたの手をNNに教える</li>
        </ul>
      </div>
    `;
    showModal('🎮 操作ヘルプ', html, '<button onclick="hideModal()">閉じる</button>');
  }

  // ── キーボードショートカット ──
  document.addEventListener('keydown', (e) => {
    // モーダル開いている時は ESC のみ
    const modalOpen = !document.getElementById('modal-bg').classList.contains('hidden');
    if (modalOpen) {
      if (e.key === 'Escape' && typeof hideModal === 'function') hideModal();
      return;
    }
    // INPUT/TEXTAREAフォーカス時はスキップ
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const k = e.key.toLowerCase();
    const map = {
      'r': 'btn-roll',
      'o': 'btn-build-road',
      's': 'btn-build-settlement',
      'c': 'btn-build-city',
      'd': 'btn-buy-dev',
      't': 'btn-trade',
      'e': 'btn-end-turn',
    };
    if (e.key === 'Escape') {
      const cancel = document.getElementById('btn-cancel');
      if (cancel && !cancel.disabled) cancel.click();
      return;
    }
    if (e.key === '?' || e.key === '/') {
      showHelp();
      e.preventDefault();
      return;
    }
    if (map[k]) {
      const btn = document.getElementById(map[k]);
      if (btn && !btn.disabled) {
        btn.click();
        e.preventDefault();
      }
    }
  });

  // ── ヘルプボタン + モーダル背景クリックで閉じる ──
  window.addEventListener('load', () => {
    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) helpBtn.addEventListener('click', showHelp);

    // モーダル背景 (黒い部分) をクリックしたら閉じる
    const bg = document.getElementById('modal-bg');
    if (bg) {
      bg.addEventListener('click', (e) => {
        // モーダル本体 (#modal) 内のクリックは無視、背景部分だけで閉じる
        if (e.target === bg && typeof hideModal === 'function') hideModal();
      });
    }

    // 初回起動時はヘルプを自動表示 (1回だけ)
    try {
      if (!localStorage.getItem('catan-help-seen')) {
        setTimeout(showHelp, 600);
        localStorage.setItem('catan-help-seen', '1');
      }
    } catch (e) { /* localStorage 不可なら無視 */ }
  });
})();
