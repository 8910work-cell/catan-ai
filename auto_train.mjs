import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE_URL = 'file://' + path.join(__dirname, 'index.html');
const WEIGHTS_PATH = path.join(__dirname, 'auto_train_weights.json');
const STATUS_PATH = path.join(__dirname, 'auto_train_status.json');

const POLL_MS = 8000;
const MAX_WAIT_MS = 4 * 60 * 60 * 1000;
const MAX_RETRIES = 20; // クラッシュ時の最大リトライ回数

function elapsed(start) {
  const sec = Math.floor((Date.now() - start) / 1000);
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec/60)}分${sec%60}秒`;
}

function saveStatus(data) {
  try { fs.writeFileSync(STATUS_PATH, JSON.stringify(data, null, 2)); } catch(_) {}
}

async function exportWeights(page) {
  // LocalStorageから重みデータを取得してファイル保存
  const lsData = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) result[k] = localStorage.getItem(k);
    }
    return result;
  }).catch(() => null);

  if (lsData && Object.keys(lsData).length > 0) {
    fs.writeFileSync(WEIGHTS_PATH + '.ls.json', JSON.stringify(lsData));
    console.log(`重みをLocalStorageから保存: ${Object.keys(lsData).length}件`);
    return true;
  }
  console.log('⚠️ 重みの取得に失敗');
  return false;
}

async function loadWeights(page) {
  const lsFile = WEIGHTS_PATH + '.ls.json';
  if (!fs.existsSync(lsFile)) return false;
  try {
    const lsData = JSON.parse(fs.readFileSync(lsFile, 'utf8'));
    const ok = await page.evaluate((data) => {
      try {
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
        return true;
      } catch(e) { return false; }
    }, lsData);
    if (ok) {
      // LocalStorageに復元した後、btn-load-weightsをクリックしてNNに読み込む
      await page.evaluate(() => {
        const btn = document.getElementById('btn-load-weights');
        if (btn && !btn.disabled) btn.click();
      });
      await page.waitForTimeout(2000);
      console.log('重みをLocalStorageから復元しました');
      return true;
    }
  } catch(e) {
    console.log('重みロードエラー:', e.message);
  }
  return false;
}

async function waitForTrainingDone(page, startTime) {
  let lastStatus = '';
  let lastLog = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    // ページの生存確認
    const alive = await page.evaluate(() => true).catch(() => false);
    if (!alive) {
      console.log(`[${elapsed(startTime)}] ⚠️ ページが応答しません`);
      throw new Error('page_dead');
    }

    await page.waitForTimeout(POLL_MS);

    // autoTrainFull専用フラグで完了検知
    const done = await page.evaluate(() => !!window._autoTrainFullDone).catch(() => null);
    if (done === null) throw new Error('page_dead');

    const status = await page.evaluate(() => {
      const s = document.getElementById('ai-status');
      const p = document.getElementById('train-progress');
      return (s?.textContent || '') + ' | ' + (p?.textContent || '');
    }).catch(() => null);
    if (status === null) throw new Error('page_dead');

    const modalVisible = await page.evaluate(() => {
      const bg = document.getElementById('modal-bg');
      return bg && !bg.classList.contains('hidden');
    }).catch(() => false);

    if (status !== lastStatus) {
      lastStatus = status;
      console.log(`[${elapsed(startTime)}] ${done ? '✅' : '🔄'} ${status.slice(0, 120)}`);
      lastLog = Date.now();
      saveStatus({ elapsed: elapsed(startTime), status, done, time: new Date().toISOString() });
    } else if (Date.now() - lastLog > 30000) {
      console.log(`[${elapsed(startTime)}] (継続中...)`);
      lastLog = Date.now();
    }

    if (modalVisible) {
      const modalText = await page.evaluate(() =>
        document.getElementById('modal')?.textContent || ''
      ).catch(() => '');
      console.log(`[${elapsed(startTime)}] 🎉 完了モーダル: ${modalText.slice(0, 150)}`);
      return true;
    }

    if (done) {
      console.log(`[${elapsed(startTime)}] ✅ autoTrainFull完了フラグ確認`);
      return true;
    }
  }
  console.log(`[${elapsed(startTime)}] ⏰ タイムアウト`);
  return false;
}

async function runSession(sessionNum, globalStart) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`セッション #${sessionNum} 開始 (累計: ${elapsed(globalStart)})`);
  console.log('='.repeat(50));

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',       // 共有メモリ不足によるクラッシュ防止
      '--js-flags=--max-old-space-size=4096', // JSヒープを4GBに拡張
    ]
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (!t.includes('devCards') && !t.includes('TypeError') && !t.includes('at _ai')) {
        console.error('[browser]', t.slice(0, 80));
      }
    }
  });

  // ブラウザのクラッシュ検知
  page.on('close', () => console.log('⚠️ ページが閉じられました'));
  browser.on('disconnected', () => console.log('⚠️ ブラウザが切断されました'));

  try {
    console.log('ページ読み込み中...');
    await page.goto(FILE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);

    // モーダルを閉じる
    await page.evaluate(() => {
      const bg = document.getElementById('modal-bg');
      if (bg && !bg.classList.contains('hidden')) {
        if (typeof hideModal === 'function') hideModal();
        else bg.classList.add('hidden');
      }
    });
    await page.waitForTimeout(500);

    // AI設定パネルを開く
    await page.evaluate(() => {
      const d = document.getElementById('ai-panel-wrapper');
      if (d) d.open = true;
    });

    // 設定
    await page.evaluate(() => {
      const chkNN = document.getElementById('chk-use-nn');
      if (chkNN && chkNN.checked) chkNN.click();
      const chkStrong = document.getElementById('chk-strong-mode');
      if (chkStrong && !chkStrong.checked) chkStrong.click();
    });

    // 重みをLocalStorageに復元（重みファイルがあれば常にロード）
    const lsFileExists = fs.existsSync(WEIGHTS_PATH + '.ls.json');
    if (lsFileExists) {
      const loaded = await loadWeights(page);
      if (loaded) {
        // 保存済み重みがある場合はPhase 0（モデルリセット）をスキップ
        await page.evaluate(() => { window._skipPhase0 = true; });
        console.log('Phase 0スキップフラグを設定');
      }
    }

    // 完了フラグをリセット
    await page.evaluate(() => { window._autoTrainFullDone = false; });

    // 🚀 ボタンをクリック
    const disabled = await page.evaluate(() =>
      document.getElementById('btn-train-full')?.disabled ?? true
    );
    if (disabled) {
      console.error('btn-train-full が無効です');
      await browser.close();
      return false;
    }

    console.log('🚀 最速50%達成 ボタンをクリック');
    const trainStart = Date.now();
    await page.evaluate(() => document.getElementById('btn-train-full').click());
    await page.waitForTimeout(3000);

    // バックグラウンドで2分ごとに重みを定期保存
    let periodicSaveActive = true;
    const periodicSave = (async () => {
      while (periodicSaveActive) {
        await new Promise(r => setTimeout(r, 2 * 60 * 1000)); // 2分待機
        if (!periodicSaveActive) break;
        const alive = await page.evaluate(() => true).catch(() => false);
        if (!alive) break;
        const ok = await exportWeights(page).catch(() => false);
        if (ok) console.log(`[${elapsed(trainStart)}] 💾 定期保存完了`);
      }
    })();

    // 学習完了まで監視
    const completed = await waitForTrainingDone(page, trainStart);
    periodicSaveActive = false;

    // 重みを保存
    console.log('\n重みを保存中...');
    await exportWeights(page);

    if (completed) {
      const finalStatus = await page.evaluate(() =>
        document.getElementById('ai-status')?.textContent || ''
      ).catch(() => '');
      console.log(`\n🎉 学習完了！ ${elapsed(trainStart)}`);
      console.log('最終ステータス:', finalStatus);
      await page.waitForTimeout(5 * 60 * 1000); // 5分表示
      await browser.close();
      return true; // 完了
    }

  } catch(e) {
    const msg = e.message || '';
    if (msg === 'page_dead' || msg.includes('closed') || msg.includes('disconnected') || msg.includes('Target')) {
      console.log(`⚠️ ブラウザクラッシュ検知: ${msg.slice(0, 80)}`);
      // 重みを保存試みる（失敗してもOK）
      await exportWeights(page).catch(() => {});
    } else {
      console.error('予期しないエラー:', msg);
    }
  }

  try { await browser.close(); } catch(_) {}
  return false; // 再起動が必要
}

async function main() {
  console.log('自動学習スクリプト起動');
  console.log(`重みファイル: ${WEIGHTS_PATH}.ls.json`);
  const globalStart = Date.now();
  let retries = 0;

  while (retries < MAX_RETRIES) {
    const done = await runSession(retries + 1, globalStart);
    if (done) {
      console.log(`\n✅ 目標達成！ 総所要時間: ${elapsed(globalStart)}`);
      break;
    }

    retries++;
    if (retries >= MAX_RETRIES) {
      console.log(`❌ 最大リトライ回数(${MAX_RETRIES})に達しました`);
      break;
    }

    const wait = 10;
    console.log(`\n🔄 ${wait}秒後に再起動します... (${retries}/${MAX_RETRIES}回目)`);
    await new Promise(r => setTimeout(r, wait * 1000));
  }
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
