import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_URL = 'file://' + path.join(__dirname, 'index.html');
const LS_FILE = path.join(__dirname, 'auto_train_weights.json.ls.json');

async function main() {
  console.log('評価専用スクリプト起動');

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('devCards') && !msg.text().includes('TypeError'))
      console.error('[browser]', msg.text().slice(0, 80));
  });

  console.log('ページ読み込み中...');
  await page.goto(FILE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // モーダルを閉じる
  await page.evaluate(() => {
    const bg = document.getElementById('modal-bg');
    if (bg && !bg.classList.contains('hidden')) {
      if (typeof hideModal === 'function') hideModal();
      else bg.classList.add('hidden');
    }
  });

  // AI設定パネルを開く
  await page.evaluate(() => {
    const d = document.getElementById('ai-panel-wrapper');
    if (d) d.open = true;
  });
  await page.waitForTimeout(500);

  // 保存済み重みをLocalStorageに復元
  if (fs.existsSync(LS_FILE)) {
    const lsData = JSON.parse(fs.readFileSync(LS_FILE, 'utf8'));
    const restored = await page.evaluate((data) => {
      try {
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
        return Object.keys(data).length;
      } catch(e) { return 0; }
    }, lsData);
    console.log(`LocalStorage復元: ${restored}件`);

    // btn-load-weights でNNモデルに読み込む
    await page.evaluate(() => {
      const btn = document.getElementById('btn-load-weights');
      if (btn && !btn.disabled) btn.click();
    });
    await page.waitForTimeout(2000);

    const status = await page.evaluate(() =>
      document.getElementById('ai-status')?.textContent || ''
    );
    console.log('重みロード後ステータス:', status);
  } else {
    console.log('⚠️ 重みファイルが見つかりません:', LS_FILE);
  }

  // 強力AIモードOFF、NN使用OFF（評価はevalModeで行う）
  await page.evaluate(() => {
    const chkStrong = document.getElementById('chk-strong-mode');
    if (chkStrong && chkStrong.checked) chkStrong.click();
    const chkNN = document.getElementById('chk-use-nn');
    if (chkNN && chkNN.checked) chkNN.click();
  });
  await page.waitForTimeout(500);

  // nnReadyとボタン状態を確認
  const debugInfo = await page.evaluate(() => ({
    nnReady: window.nnReady,
    trainRunning: window.trainRunning,
    evalDisabled: document.getElementById('btn-eval')?.disabled,
    strongEnabled: window.strongModeEnabled,
    chkNN: document.getElementById('chk-use-nn')?.checked,
    chkStrong: document.getElementById('chk-strong-mode')?.checked,
  }));
  console.log('デバッグ情報:', JSON.stringify(debugInfo));

  if (!debugInfo.nnReady) {
    console.log('nnReadyがfalse → btn-load-weightsを再クリック');
    await page.evaluate(() => {
      const btn = document.getElementById('btn-load-weights');
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    const nnReadyNow = await page.evaluate(() => window.nnReady);
    console.log('nnReady (再試行後):', nnReadyNow);
  }

  // 評価ボタンをクリック
  console.log('\n評価開始（100ゲーム）...');
  const evalDisabled = await page.evaluate(() =>
    document.getElementById('btn-eval')?.disabled ?? true
  );
  if (evalDisabled) {
    console.error('評価ボタンが無効です');
    await browser.close();
    return;
  }

  const t0 = Date.now();
  // prompt()をモック（btn-evalのonclickがprompt()を呼ぶため）
  await page.evaluate(() => { window.prompt = () => '100'; });
  await page.evaluate(() => document.getElementById('btn-eval').click());

  // 「評価中」がstatusに現れるまで待つ（最大15秒）
  let evalStarted = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const s = await page.evaluate(() => document.getElementById('ai-status')?.textContent || '').catch(() => '');
    if (s.includes('評価中')) { console.log('評価開始確認:', s); evalStarted = true; break; }
  }
  if (!evalStarted) {
    console.error('評価が開始されませんでした。statusを確認:',
      await page.evaluate(() => document.getElementById('ai-status')?.textContent || '').catch(() => ''));
    await browser.close(); return;
  }

  // 「評価中」が消えるまで待機（完了検知）
  let lastStatus = '';
  while (true) {
    await page.waitForTimeout(5000);
    const status = await page.evaluate(() =>
      document.getElementById('ai-status')?.textContent || ''
    ).catch(() => '');

    if (status !== lastStatus) {
      lastStatus = status;
      const sec = Math.floor((Date.now() - t0) / 1000);
      console.log(`[${sec}秒] ${status}`);
    }

    if (!status.includes('評価中')) break;
    if (Date.now() - t0 > 10 * 60 * 1000) { // 10分タイムアウト
      console.log('タイムアウト');
      break;
    }
  }

  // 最終結果を取得
  const finalStatus = await page.evaluate(() =>
    document.getElementById('ai-status')?.textContent || ''
  ).catch(() => '');

  console.log('\n========================================');
  console.log('評価結果:', finalStatus);
  console.log('========================================');

  // ブラウザを開いたままにする
  console.log('\nブラウザを開いたままにします。手動で閉じてください。');
  await page.waitForTimeout(10 * 60 * 1000);
  await browser.close();
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
