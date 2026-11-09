// ==========================================
// Supabase 接続設定（直接ここに記述するか、画面の「⚙️ クラウド設定」から登録可能）
// ==========================================
const SUPABASE_URL = '';
const SUPABASE_ANON_KEY = '';

// ストレージキー定義（将来のクラウド移行時もデータ構造を把握しやすいよう集約）
const STORAGE_KEYS = {
  PLANS: 'travel_app_plans',
  ACTIVE_PLAN_ID: 'travel_app_active_plan_id',
  ACTIVE_TAB: 'travel_app_active_tab',
  SUPABASE_CONFIG: 'travel_app_supabase_config',
  ITINERARY: 'travel_app_itinerary',
  MEMBERS: 'travel_app_members',
  EXPENSES: 'travel_app_expenses',
  RATES: 'travel_app_rates',
  PACKING_LIST: 'travel_app_packing_list',
  PACKING_TEMPLATE: 'travel_app_packing_template',
  PLACES_LIST: 'travel_app_places_list',
};

const PLAN_SCOPED_KEYS = [
  STORAGE_KEYS.ITINERARY,
  STORAGE_KEYS.MEMBERS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.RATES,
  STORAGE_KEYS.PACKING_LIST,
  STORAGE_KEYS.PLACES_LIST,
];

// 【重要】クラウド同期対象のキー（持ち物リスト PACKING_LIST と PACKING_TEMPLATE は絶対にクラウドへ送信しない）
const CLOUD_SYNC_KEYS = [
  STORAGE_KEYS.ITINERARY,
  STORAGE_KEYS.MEMBERS,
  STORAGE_KEYS.EXPENSES,
  STORAGE_KEYS.RATES,
  STORAGE_KEYS.PLACES_LIST,
];

let currentPlanId = 'default';
let cloudSyncHook = null;

/**
 * localStorage からJSONデータを安全に取得するヘルパー
 */
function loadData(key, defaultValue) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultValue;
  } catch (e) {
    console.error('データの読み込みに失敗しました:', e);
    return defaultValue;
  }
}

/**
 * localStorage へJSONデータを保存するヘルパー
 */
function saveData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

/**
 * プランID付きのストレージキーを生成するヘルパー
 */
function getPlanStorageKey(baseKey, planId = currentPlanId) {
  return `${baseKey}__${planId}`;
}

/**
 * 現在選択中の旅行プランのデータを取得するヘルパー
 */
function loadPlanData(baseKey, defaultValue) {
  return loadData(getPlanStorageKey(baseKey), defaultValue);
}

/**
 * 現在選択中の旅行プランのデータを保存するヘルパー
 * 共有対象データ（しおり・旅費・行きたい場所）の場合のみ、共有中プランであればクラウド同期を実行する
 * ※持ち物リスト（PACKING_LIST）はローカル保存のみでクラウドへは絶対に送信しない
 */
function savePlanData(baseKey, data) {
  saveData(getPlanStorageKey(baseKey), data);
  if (CLOUD_SYNC_KEYS.includes(baseKey) && typeof cloudSyncHook === 'function') {
    cloudSyncHook(currentPlanId);
  }
}

/**
 * 旅行プランの初期化・既存データの引き継ぎ・Supabase共有機能（持ち物リスト除外）
 */
function initPlans(onPlanChange) {
  const planSelect = document.getElementById('plan-select');
  const createBtn = document.getElementById('plan-create-btn');
  const renameBtn = document.getElementById('plan-rename-btn');
  const deleteBtn = document.getElementById('plan-delete-btn');

  const shareStatusBadge = document.getElementById('share-status-badge');
  const shareBtn = document.getElementById('plan-share-btn');
  const copyUrlBtn = document.getElementById('plan-copy-url-btn');
  const syncBtn = document.getElementById('plan-sync-btn');
  const cloudConfigBtn = document.getElementById('cloud-config-btn');

  const cloudModal = document.getElementById('cloud-config-modal');
  const cloudForm = document.getElementById('cloud-config-form');
  const supabaseUrlInput = document.getElementById('supabase-url-input');
  const supabaseKeyInput = document.getElementById('supabase-key-input');
  const cloudCloseBtn = document.getElementById('cloud-config-close-btn');

  let supabaseClient = null;
  let realtimeChannel = null;
  let isApplyingRemote = false;
  let lastSyncedUpdatedAt = null;

  let plans = loadData(STORAGE_KEYS.PLANS, null);

  // 初回起動時：既存データがあれば「デフォルトの旅行」へ自動引き継ぎ
  if (!Array.isArray(plans) || plans.length === 0) {
    const defaultPlanId = 'default';
    plans = [{ id: defaultPlanId, name: 'デフォルトの旅行', shareId: null }];

    PLAN_SCOPED_KEYS.forEach((baseKey) => {
      const legacyRaw = localStorage.getItem(baseKey);
      const scopedKey = getPlanStorageKey(baseKey, defaultPlanId);
      if (legacyRaw !== null && localStorage.getItem(scopedKey) === null) {
        localStorage.setItem(scopedKey, legacyRaw);
      }
    });

    saveData(STORAGE_KEYS.PLANS, plans);
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, defaultPlanId);
  } else {
    // 既存プランオブジェクトに shareId プロパティを保証
    plans = plans.map((p) => ({ ...p, shareId: p.shareId || null }));
  }

  const savedPlanId = localStorage.getItem(STORAGE_KEYS.ACTIVE_PLAN_ID);
  if (savedPlanId && plans.some((p) => p.id === savedPlanId)) {
    currentPlanId = savedPlanId;
  } else {
    currentPlanId = plans[0].id;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, currentPlanId);
  }

  // Supabase 接続情報の取得（コード先頭の定数 または localStorage 設定値）
  function getSupabaseCredentials() {
    const savedCfg = loadData(STORAGE_KEYS.SUPABASE_CONFIG, {});
    const url = (SUPABASE_URL || savedCfg.url || '').trim();
    const key = (SUPABASE_ANON_KEY || savedCfg.anonKey || '').trim();
    return { url, key };
  }

  // Supabase クライアントの初期化・取得
  function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;
    const { url, key } = getSupabaseCredentials();
    if (!url || !key) return null;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.error('Supabase JS クライアントが読み込まれていません。');
      return null;
    }
    supabaseClient = window.supabase.createClient(url, key);
    return supabaseClient;
  }

  // クラウド送信用の plan_data を構築（※持ち物リストとテンプレートは絶対に含めない）
  function buildSharedPlanPayload(planId) {
    const plan = plans.find((p) => p.id === planId);
    return {
      name: plan ? plan.name : '旅行プラン',
      itinerary: loadData(getPlanStorageKey(STORAGE_KEYS.ITINERARY, planId), []),
      members: loadData(getPlanStorageKey(STORAGE_KEYS.MEMBERS, planId), []),
      rates: loadData(getPlanStorageKey(STORAGE_KEYS.RATES, planId), {}),
      expenses: loadData(getPlanStorageKey(STORAGE_KEYS.EXPENSES, planId), []),
      places_list: loadData(getPlanStorageKey(STORAGE_KEYS.PLACES_LIST, planId), []),
    };
  }

  // クラウドから受信した plan_data をローカルへ反映（※持ち物リストとテンプレートは一切上書きしない）
  function applySharedPlanPayload(planId, planData) {
    if (!planData || typeof planData !== 'object') return;
    isApplyingRemote = true;
    try {
      const plan = plans.find((p) => p.id === planId);
      if (plan && planData.name) {
        plan.name = String(planData.name);
        saveData(STORAGE_KEYS.PLANS, plans);
      }
      if (Array.isArray(planData.itinerary)) {
        saveData(getPlanStorageKey(STORAGE_KEYS.ITINERARY, planId), planData.itinerary);
      }
      if (Array.isArray(planData.members)) {
        saveData(getPlanStorageKey(STORAGE_KEYS.MEMBERS, planId), planData.members);
      }
      if (planData.rates && typeof planData.rates === 'object') {
        saveData(getPlanStorageKey(STORAGE_KEYS.RATES, planId), planData.rates);
      }
      if (Array.isArray(planData.expenses)) {
        saveData(getPlanStorageKey(STORAGE_KEYS.EXPENSES, planId), planData.expenses);
      }
      if (Array.isArray(planData.places_list)) {
        saveData(getPlanStorageKey(STORAGE_KEYS.PLACES_LIST, planId), planData.places_list);
      }
      renderPlanSelect();
      if (planId === currentPlanId && onPlanChange) {
        onPlanChange();
      }
    } finally {
      isApplyingRemote = false;
    }
  }

  // 共有中プランの変更を Supabase shared_plans テーブルへ保存（Push）
  async function pushPlanToCloud(planId) {
    if (isApplyingRemote) return false;
    const plan = plans.find((p) => p.id === planId);
    if (!plan || !plan.shareId) return false;

    const client = getSupabaseClient();
    if (!client) return false;

    const nowIso = new Date().toISOString();
    lastSyncedUpdatedAt = nowIso;
    const payload = buildSharedPlanPayload(planId);

    const { error } = await client
      .from('shared_plans')
      .upsert(
        {
          share_id: plan.shareId,
          plan_data: payload,
          updated_at: nowIso,
        },
        { onConflict: 'share_id' }
      );

    if (error) {
      console.error('Supabaseへの保存に失敗しました:', error);
      return false;
    }
    return true;
  }

  // Supabase shared_plans テーブルから指定 share_id の最新データを取得（Pull）
  async function pullPlanFromCloud(shareId) {
    const client = getSupabaseClient();
    if (!client || !shareId) return null;

    const { data, error } = await client
      .from('shared_plans')
      .select('share_id, plan_data, updated_at')
      .eq('share_id', shareId)
      .maybeSingle();

    if (error) {
      console.error('Supabaseからのデータ取得に失敗しました:', error);
      return null;
    }
    return data;
  }

  // 共有中プランの Realtime 購読を切り替え
  function subscribeRealtimeForCurrentPlan() {
    const client = getSupabaseClient();
    if (realtimeChannel && client) {
      client.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!client || !currentPlan || !currentPlan.shareId) return;

    const targetShareId = currentPlan.shareId;
    realtimeChannel = client
      .channel(`shared_plan_${targetShareId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shared_plans',
          filter: `share_id=eq.${targetShareId}`,
        },
        (payload) => {
          const row = payload.new;
          if (!row || !row.plan_data) return;
          if (row.updated_at && row.updated_at === lastSyncedUpdatedAt) return;
          lastSyncedUpdatedAt = row.updated_at || null;
          applySharedPlanPayload(currentPlan.id, row.plan_data);
        }
      )
      .subscribe();
  }

  // savePlanData からの自動クラウド同期フックを設定
  cloudSyncHook = (planId) => {
    pushPlanToCloud(planId);
  };

  function renderShareControls() {
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    const isShared = Boolean(currentPlan && currentPlan.shareId);

    if (isShared) {
      shareStatusBadge.textContent = '☁️ 共有中（持ち物リストは端末個別）';
      shareStatusBadge.classList.add('shared');
      shareBtn.classList.add('hidden');
      copyUrlBtn.classList.remove('hidden');
      syncBtn.classList.remove('hidden');
    } else {
      shareStatusBadge.textContent = 'ローカル保存のみ（未共有）';
      shareStatusBadge.classList.remove('shared');
      shareBtn.classList.remove('hidden');
      copyUrlBtn.classList.add('hidden');
      syncBtn.classList.add('hidden');
    }
  }

  function renderPlanSelect() {
    planSelect.innerHTML = '';
    plans.forEach((plan) => {
      const opt = document.createElement('option');
      opt.value = plan.id;
      opt.textContent = plan.shareId ? `☁️ ${plan.name}` : plan.name;
      if (plan.id === currentPlanId) {
        opt.selected = true;
      }
      planSelect.appendChild(opt);
    });
    renderShareControls();
  }

  // 現在のプランが共有中ならクラウドから最新を取得してRealtime購読を開始
  async function syncActivePlanIfShared() {
    subscribeRealtimeForCurrentPlan();
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!currentPlan || !currentPlan.shareId) return;

    const row = await pullPlanFromCloud(currentPlan.shareId);
    if (row && row.plan_data) {
      lastSyncedUpdatedAt = row.updated_at || null;
      applySharedPlanPayload(currentPlan.id, row.plan_data);
    }
  }

  planSelect.addEventListener('change', () => {
    currentPlanId = planSelect.value;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, currentPlanId);
    renderShareControls();
    if (onPlanChange) onPlanChange();
    syncActivePlanIfShared();
  });

  createBtn.addEventListener('click', () => {
    const name = window.prompt('新しい旅行プラン名を入力してください:', '新しい旅行プラン');
    if (!name || !name.trim()) return;
    const newPlan = {
      id: `plan_${Date.now()}`,
      name: name.trim(),
      shareId: null,
    };
    plans.push(newPlan);
    currentPlanId = newPlan.id;
    saveData(STORAGE_KEYS.PLANS, plans);
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, currentPlanId);
    renderPlanSelect();
    if (onPlanChange) onPlanChange();
    subscribeRealtimeForCurrentPlan();
  });

  renameBtn.addEventListener('click', () => {
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!currentPlan) return;
    const newName = window.prompt('新しいプラン名を入力してください:', currentPlan.name);
    if (!newName || !newName.trim()) return;
    currentPlan.name = newName.trim();
    saveData(STORAGE_KEYS.PLANS, plans);
    renderPlanSelect();
    if (currentPlan.shareId) {
      pushPlanToCloud(currentPlan.id);
    }
  });

  deleteBtn.addEventListener('click', () => {
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!currentPlan) return;
    const ok = window.confirm(`旅行プラン「${currentPlan.name}」をこの端末から削除しますか？\n（このプラン内の予定・旅費・リストも削除されます）`);
    if (!ok) return;

    PLAN_SCOPED_KEYS.forEach((baseKey) => {
      localStorage.removeItem(getPlanStorageKey(baseKey, currentPlanId));
    });

    plans = plans.filter((p) => p.id !== currentPlanId);
    if (plans.length === 0) {
      plans = [{ id: `plan_${Date.now()}`, name: 'デフォルトの旅行', shareId: null }];
    }
    currentPlanId = plans[0].id;
    saveData(STORAGE_KEYS.PLANS, plans);
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, currentPlanId);
    renderPlanSelect();
    if (onPlanChange) onPlanChange();
    syncActivePlanIfShared();
  });

  // 「🔗 このプランを共有する」ボタン
  shareBtn.addEventListener('click', async () => {
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!currentPlan) return;

    const client = getSupabaseClient();
    if (!client) {
      window.alert('先に「⚙️ クラウド設定」または app.js 先頭の定数に SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。');
      openCloudConfigModal();
      return;
    }

    const uniqueShareId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `shr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    currentPlan.shareId = uniqueShareId;
    saveData(STORAGE_KEYS.PLANS, plans);

    const ok = await pushPlanToCloud(currentPlan.id);
    if (!ok) {
      currentPlan.shareId = null;
      saveData(STORAGE_KEYS.PLANS, plans);
      window.alert('Supabase への保存に失敗しました。テーブル shared_plans の作成状態や接続設定を確認してください。');
      return;
    }

    renderPlanSelect();
    subscribeRealtimeForCurrentPlan();
    window.alert(`プラン「${currentPlan.name}」の共有を開始しました！\n「📋 共有用URLをコピー」から同行者へURLを送れます。\n※持ち物リストはクラウドへ送信されず、各端末で個別に管理されます。`);
  });

  // 「📋 共有用URLをコピー」ボタン
  copyUrlBtn.addEventListener('click', async () => {
    const currentPlan = plans.find((p) => p.id === currentPlanId);
    if (!currentPlan || !currentPlan.shareId) return;

    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    const shareUrl = `${baseUrl}?share=${encodeURIComponent(currentPlan.shareId)}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      window.alert(`共有用URLをコピーしました！\n${shareUrl}`);
    } catch (err) {
      window.prompt('以下の共有用URLをコピーしてください:', shareUrl);
    }
  });

  // 「🔄 最新同期」ボタン
  syncBtn.addEventListener('click', async () => {
    await syncActivePlanIfShared();
  });

  // クラウド設定モーダル開閉・保存
  function openCloudConfigModal() {
    const { url, key } = getSupabaseCredentials();
    supabaseUrlInput.value = url;
    supabaseKeyInput.value = key;
    cloudModal.classList.remove('hidden');
  }

  cloudConfigBtn.addEventListener('click', () => {
    openCloudConfigModal();
  });

  cloudCloseBtn.addEventListener('click', () => {
    cloudModal.classList.add('hidden');
  });

  cloudForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = supabaseUrlInput.value.trim();
    const anonKey = supabaseKeyInput.value.trim();
    saveData(STORAGE_KEYS.SUPABASE_CONFIG, { url, anonKey });
    supabaseClient = null;
    cloudModal.classList.add('hidden');
    handleShareUrlParameter().then(() => {
      syncActivePlanIfShared();
    });
  });

  // URLパラメータ (?share=〇〇) で開かれた場合の自動取り込み処理
  async function handleShareUrlParameter() {
    const params = new URLSearchParams(window.location.search);
    const shareParam = params.get('share');
    if (!shareParam) return;

    const client = getSupabaseClient();
    if (!client) {
      window.alert('共有プランを読み込むには、Supabase の接続設定（SUPABASE_URL / SUPABASE_ANON_KEY）を入力してください。');
      openCloudConfigModal();
      return;
    }

    const row = await pullPlanFromCloud(shareParam);
    if (!row || !row.plan_data) {
      window.alert('指定された共有プランが見つかりませんでした。');
      return;
    }

    let targetPlan = plans.find((p) => p.shareId === shareParam);
    if (!targetPlan) {
      targetPlan = {
        id: `plan_${Date.now()}`,
        name: row.plan_data.name || '共有された旅行プラン',
        shareId: shareParam,
      };
      plans.push(targetPlan);
    }

    currentPlanId = targetPlan.id;
    saveData(STORAGE_KEYS.PLANS, plans);
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PLAN_ID, currentPlanId);
    lastSyncedUpdatedAt = row.updated_at || null;
    applySharedPlanPayload(targetPlan.id, row.plan_data);
  }

  renderPlanSelect();
  handleShareUrlParameter().then(() => {
    syncActivePlanIfShared();
  });
}

/**
 * 場所文字列またはURLからGoogleマップ用URLを生成する共通ヘルパー
 */
function buildMapUrl(placeStr) {
  if (/^https?:\/\//i.test(placeStr)) {
    return placeStr;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(placeStr)}`;
}

/**
 * タブ切り替え処理の初期化
 */
function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');

  function switchTab(targetTab) {
    tabButtons.forEach((btn) => {
      const isTarget = btn.dataset.tab === targetTab;
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });

    tabContents.forEach((content) => {
      const isTarget = content.id === `tab-${targetTab}`;
      content.classList.toggle('active', isTarget);
    });

    localStorage.setItem(STORAGE_KEYS.ACTIVE_TAB, targetTab);
  }

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      switchTab(button.dataset.tab);
    });
  });

  // 前回開いていたタブを復元（なければ 'itinerary'）
  const savedTab = localStorage.getItem(STORAGE_KEYS.ACTIVE_TAB) || 'itinerary';
  switchTab(savedTab);
}

/**
 * タブ1: 旅のしおり機能の初期化
 */
function initItinerary() {
  const form = document.getElementById('itinerary-form');
  const dayInput = document.getElementById('itinerary-day');
  const timeInput = document.getElementById('itinerary-time');
  const titleInput = document.getElementById('itinerary-title');
  const memoInput = document.getElementById('itinerary-memo');
  const placeInput = document.getElementById('itinerary-place');
  const urlInput = document.getElementById('itinerary-url');
  const submitBtn = document.getElementById('itinerary-submit-btn');
  const cancelBtn = document.getElementById('itinerary-cancel-btn');
  const listContainer = document.getElementById('itinerary-list');

  let items = loadPlanData(STORAGE_KEYS.ITINERARY, []);
  let editingId = null;

  function clearFormInputs() {
    dayInput.value = '';
    timeInput.value = '';
    titleInput.value = '';
    memoInput.value = '';
    placeInput.value = '';
    urlInput.value = '';
  }

  function resetEditMode() {
    editingId = null;
    submitBtn.textContent = '予定を追加';
    cancelBtn.classList.add('hidden');
  }

  // YYYY-MM-DD を「YYYY/MM/DD (曜)」形式に整形するヘルパー
  function formatDateHeader(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if (!match) return dateStr;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dateObj = new Date(year, month - 1, day);
    const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
    const w = weekdays[dateObj.getDay()];
    return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')} (${w})`;
  }

  function renderItinerary() {
    listContainer.innerHTML = '';

    if (items.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'placeholder-text';
      emptyMsg.textContent = 'まだ予定が登録されていません。上のフォームから追加してください。';
      listContainer.appendChild(emptyMsg);
      return;
    }

    // 日程・時刻順にソート
    const sorted = [...items].sort((a, b) => {
      if (a.day !== b.day) return a.day.localeCompare(b.day, 'ja');
      return a.time.localeCompare(b.time);
    });

    // 日程ごとにグループ化
    const grouped = new Map();
    sorted.forEach((item) => {
      if (!grouped.has(item.day)) {
        grouped.set(item.day, []);
      }
      grouped.get(item.day).push(item);
    });

    grouped.forEach((dayItems, dayLabel) => {
      const dayGroup = document.createElement('div');
      dayGroup.className = 'itinerary-day-group';

      const header = document.createElement('div');
      header.className = 'itinerary-day-header';
      header.textContent = formatDateHeader(dayLabel);
      dayGroup.appendChild(header);

      dayItems.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'itinerary-item';

        const main = document.createElement('div');
        main.className = 'itinerary-item-main';

        const timeEl = document.createElement('span');
        timeEl.className = 'itinerary-time';
        timeEl.textContent = item.time;

        const details = document.createElement('div');
        details.className = 'itinerary-details';

        const titleEl = document.createElement('div');
        titleEl.className = 'itinerary-title';
        titleEl.textContent = item.title;
        details.appendChild(titleEl);

        if (item.memo) {
          const memoEl = document.createElement('div');
          memoEl.className = 'itinerary-memo';
          memoEl.textContent = item.memo;
          details.appendChild(memoEl);
        }

        if (item.place || item.url) {
          const linksEl = document.createElement('div');
          linksEl.className = 'itinerary-links';

          if (item.place) {
            const mapLink = document.createElement('a');
            mapLink.className = 'itinerary-link';
            mapLink.href = buildMapUrl(item.place);
            mapLink.target = '_blank';
            mapLink.rel = 'noopener noreferrer';
            const isRawUrl = /^https?:\/\//i.test(item.place);
            mapLink.textContent = isRawUrl ? '📍 マップを開く' : `📍 ${item.place}`;
            linksEl.appendChild(mapLink);
          }

          if (item.url) {
            const webLink = document.createElement('a');
            webLink.className = 'itinerary-link';
            webLink.href = item.url;
            webLink.target = '_blank';
            webLink.rel = 'noopener noreferrer';
            webLink.textContent = '🔗 参考URLを開く';
            linksEl.appendChild(webLink);
          }

          details.appendChild(linksEl);
        }

        main.appendChild(timeEl);
        main.appendChild(details);

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-edit';
        editBtn.textContent = '編集';
        editBtn.addEventListener('click', () => {
          editingId = item.id;
          dayInput.value = item.day;
          timeInput.value = item.time;
          titleInput.value = item.title;
          memoInput.value = item.memo || '';
          placeInput.value = item.place || '';
          urlInput.value = item.url || '';
          submitBtn.textContent = '予定を更新';
          cancelBtn.classList.remove('hidden');
          form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          titleInput.focus();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete';
        deleteBtn.textContent = '削除';
        deleteBtn.addEventListener('click', () => {
          items = items.filter((i) => i.id !== item.id);
          if (editingId === item.id) {
            resetEditMode();
            timeInput.value = '';
            titleInput.value = '';
            memoInput.value = '';
            placeInput.value = '';
            urlInput.value = '';
          }
          savePlanData(STORAGE_KEYS.ITINERARY, items);
          renderItinerary();
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);

        row.appendChild(main);
        row.appendChild(actions);
        dayGroup.appendChild(row);
      });

      listContainer.appendChild(dayGroup);
    });
  }

  cancelBtn.addEventListener('click', () => {
    resetEditMode();
    timeInput.value = '';
    titleInput.value = '';
    memoInput.value = '';
    placeInput.value = '';
    urlInput.value = '';
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const day = dayInput.value.trim();
    const time = timeInput.value;
    const title = titleInput.value.trim();
    const memo = memoInput.value.trim();
    const place = placeInput.value.trim();
    const url = urlInput.value.trim();

    if (!day || !time || !title) return;

    if (editingId) {
      items = items.map((item) =>
        item.id === editingId ? { ...item, day, time, title, memo, place, url } : item
      );
      resetEditMode();
    } else {
      items.push({
        id: Date.now().toString(),
        day,
        time,
        title,
        memo,
        place,
        url,
      });
    }

    savePlanData(STORAGE_KEYS.ITINERARY, items);
    renderItinerary();

    // 続けて同じ日程で入力しやすいよう日程は残し、他をクリア
    timeInput.value = '';
    titleInput.value = '';
    memoInput.value = '';
    placeInput.value = '';
    urlInput.value = '';
    timeInput.focus();
  });

  function reload() {
    resetEditMode();
    clearFormInputs();
    items = loadPlanData(STORAGE_KEYS.ITINERARY, []);
    renderItinerary();
  }

  renderItinerary();
  return { reload };
}

/**
 * タブ2: 旅費・割り勘計算機能の初期化
 */
function initExpenses() {
  const memberForm = document.getElementById('member-form');
  const memberNameInput = document.getElementById('member-name');
  const memberListEl = document.getElementById('member-list');

  const expenseForm = document.getElementById('expense-form');
  const expenseTitleInput = document.getElementById('expense-title');
  const expenseAmountInput = document.getElementById('expense-amount');
  const expenseCurrencySelect = document.getElementById('expense-currency');
  const expensePayerSelect = document.getElementById('expense-payer');
  const expenseSubmitBtn = document.getElementById('expense-submit-btn');
  const expenseCancelBtn = document.getElementById('expense-cancel-btn');
  const rateInputs = document.querySelectorAll('#rate-settings input[data-currency]');

  const summaryEl = document.getElementById('expense-summary');
  const expenseListEl = document.getElementById('expense-list');

  const DEFAULT_RATES = {
    KRW: 0.11,
    USD: 150,
    EUR: 160,
    TWD: 4.8,
  };

  let members = loadPlanData(STORAGE_KEYS.MEMBERS, []);
  let expenses = loadPlanData(STORAGE_KEYS.EXPENSES, []);
  let rates = { ...DEFAULT_RATES, ...loadPlanData(STORAGE_KEYS.RATES, {}) };
  let editingExpenseId = null;

  // 外貨額と通貨コードから日本円換算額（端数切り捨て）を算出するヘルパー
  function convertToJpy(originalAmount, currency) {
    const num = Number(originalAmount) || 0;
    if (!currency || currency === 'JPY') {
      return Math.floor(num);
    }
    const rate = Number(rates[currency]) || 1;
    return Math.floor(num * rate);
  }

  // 各支出データの日本円換算額を最新レートで同期する
  function syncExpenseAmounts() {
    expenses = expenses.map((item) => {
      const currency = item.currency || 'JPY';
      const originalAmount = item.originalAmount !== undefined ? Number(item.originalAmount) : Number(item.amount);
      return {
        ...item,
        currency,
        originalAmount,
        amount: convertToJpy(originalAmount, currency),
      };
    });
  }

  function renderRateInputs() {
    rateInputs.forEach((input) => {
      const cur = input.dataset.currency;
      if (rates[cur] !== undefined) {
        input.value = rates[cur];
      }
    });
  }

  // レート入力欄の初期化とイベント設定
  rateInputs.forEach((input) => {
    const cur = input.dataset.currency;
    input.addEventListener('change', () => {
      const val = Number(input.value);
      if (val > 0) {
        rates[cur] = val;
        savePlanData(STORAGE_KEYS.RATES, rates);
        syncExpenseAmounts();
        savePlanData(STORAGE_KEYS.EXPENSES, expenses);
        renderAll();
      } else {
        input.value = rates[cur];
      }
    });
  });

  renderRateInputs();
  syncExpenseAmounts();

  function resetExpenseEditMode() {
    editingExpenseId = null;
    expenseCurrencySelect.value = 'JPY';
    expenseSubmitBtn.textContent = '支出を追加';
    expenseCancelBtn.classList.add('hidden');
  }

  function renderMembers() {
    memberListEl.innerHTML = '';
    expensePayerSelect.innerHTML = '';

    if (members.length === 0) {
      const emptyMsg = document.createElement('span');
      emptyMsg.className = 'placeholder-text';
      emptyMsg.textContent = '参加メンバーを追加してください。';
      memberListEl.appendChild(emptyMsg);

      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'メンバーを先に追加してください';
      expensePayerSelect.appendChild(opt);
      return;
    }

    members.forEach((member) => {
      const tag = document.createElement('span');
      tag.className = 'member-tag';
      tag.textContent = member;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = '×';
      removeBtn.title = `${member}を削除`;
      removeBtn.addEventListener('click', () => {
        members = members.filter((m) => m !== member);
        savePlanData(STORAGE_KEYS.MEMBERS, members);
        renderAll();
      });

      tag.appendChild(removeBtn);
      memberListEl.appendChild(tag);

      const opt = document.createElement('option');
      opt.value = member;
      opt.textContent = member;
      expensePayerSelect.appendChild(opt);
    });
  }

  function renderSummary() {
    summaryEl.innerHTML = '';

    const total = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const memberCount = members.length;
    const perPerson = memberCount > 0 ? Math.round(total / memberCount) : 0;

    const totalsDiv = document.createElement('div');
    totalsDiv.className = 'summary-totals';
    totalsDiv.innerHTML = `
      <div class="summary-stat">
        <span class="summary-stat-label">合計支出</span>
        <span class="summary-stat-value">${total.toLocaleString()} 円</span>
      </div>
      <div class="summary-stat">
        <span class="summary-stat-label">1人あたり（${memberCount}人）</span>
        <span class="summary-stat-value">${perPerson.toLocaleString()} 円</span>
      </div>
    `;
    summaryEl.appendChild(totalsDiv);

    if (memberCount === 0 || expenses.length === 0) {
      const msg = document.createElement('p');
      msg.className = 'placeholder-text';
      msg.textContent = 'メンバーと支出を登録すると精算目安が表示されます。';
      summaryEl.appendChild(msg);
      return;
    }

    // メンバーごとの立替合計を計算
    const paidByMember = {};
    members.forEach((m) => {
      paidByMember[m] = 0;
    });
    expenses.forEach((e) => {
      if (paidByMember[e.payer] !== undefined) {
        paidByMember[e.payer] += Number(e.amount);
      }
    });

    // 差額（支払額 - 1人あたり負担額）から精算ペアを算出
    const creditors = []; // 多く払った人（受け取る側）
    const debtors = [];   // 少なく払った人（支払う側）

    members.forEach((m) => {
      const diff = paidByMember[m] - perPerson;
      if (diff > 0) creditors.push({ name: m, amount: diff });
      else if (diff < 0) debtors.push({ name: m, amount: -diff });
    });

    const settlements = [];
    let i = 0;
    let j = 0;
    while (i < debtors.length && j < creditors.length) {
      const payAmount = Math.min(debtors[i].amount, creditors[j].amount);
      if (payAmount > 0) {
        settlements.push(`${debtors[i].name} → ${creditors[j].name} に ${payAmount.toLocaleString()} 円`);
      }
      debtors[i].amount -= payAmount;
      creditors[j].amount -= payAmount;
      if (debtors[i].amount === 0) i++;
      if (creditors[j].amount === 0) j++;
    }

    const list = document.createElement('ul');
    list.className = 'settlement-list';
    if (settlements.length === 0) {
      const li = document.createElement('li');
      li.className = 'placeholder-text';
      li.textContent = '全員の支払額が均等です（精算不要）。';
      list.appendChild(li);
    } else {
      settlements.forEach((text) => {
        const li = document.createElement('li');
        li.className = 'settlement-item';
        li.textContent = text;
        list.appendChild(li);
      });
    }
    summaryEl.appendChild(list);
  }

  function renderExpenses() {
    expenseListEl.innerHTML = '';

    if (expenses.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'placeholder-text';
      emptyMsg.textContent = 'まだ支出が登録されていません。';
      expenseListEl.appendChild(emptyMsg);
      return;
    }

    expenses.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'expense-item';

      const info = document.createElement('div');
      info.className = 'expense-info';

      const titleEl = document.createElement('div');
      titleEl.className = 'expense-title';
      titleEl.textContent = item.title;

      const metaEl = document.createElement('div');
      metaEl.className = 'expense-meta';
      metaEl.textContent = `支払: ${item.payer}`;

      info.appendChild(titleEl);
      info.appendChild(metaEl);

      const amountEl = document.createElement('div');
      amountEl.className = 'expense-amount';
      const currency = item.currency || 'JPY';
      const origAmt = item.originalAmount !== undefined ? Number(item.originalAmount) : Number(item.amount);
      const jpyAmt = convertToJpy(origAmt, currency);

      if (currency === 'JPY') {
        amountEl.textContent = `${jpyAmt.toLocaleString()}円`;
      } else {
        amountEl.textContent = `${jpyAmt.toLocaleString()}円`;
        const subEl = document.createElement('span');
        subEl.className = 'expense-sub-amount';
        subEl.textContent = `(${origAmt.toLocaleString()} ${currency})`;
        amountEl.appendChild(subEl);
      }

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-edit';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => {
        editingExpenseId = item.id;
        expenseTitleInput.value = item.title;
        expenseAmountInput.value = origAmt;
        expenseCurrencySelect.value = currency;
        if (!members.includes(item.payer)) {
          const tempOpt = document.createElement('option');
          tempOpt.value = item.payer;
          tempOpt.textContent = item.payer;
          expensePayerSelect.appendChild(tempOpt);
        }
        expensePayerSelect.value = item.payer;
        expenseSubmitBtn.textContent = '支出を更新';
        expenseCancelBtn.classList.remove('hidden');
        expenseForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        expenseTitleInput.focus();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-delete';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', () => {
        expenses = expenses.filter((e) => e.id !== item.id);
        if (editingExpenseId === item.id) {
          resetExpenseEditMode();
          expenseTitleInput.value = '';
          expenseAmountInput.value = '';
        }
        savePlanData(STORAGE_KEYS.EXPENSES, expenses);
        renderAll();
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      row.appendChild(info);
      row.appendChild(amountEl);
      row.appendChild(actions);
      expenseListEl.appendChild(row);
    });
  }

  function renderAll() {
    const currentPayer = expensePayerSelect.value;
    renderMembers();
    if (editingExpenseId && currentPayer) {
      if (!members.includes(currentPayer)) {
        const tempOpt = document.createElement('option');
        tempOpt.value = currentPayer;
        tempOpt.textContent = currentPayer;
        expensePayerSelect.appendChild(tempOpt);
      }
      expensePayerSelect.value = currentPayer;
    }
    renderSummary();
    renderExpenses();
  }

  expenseCancelBtn.addEventListener('click', () => {
    resetExpenseEditMode();
    expenseTitleInput.value = '';
    expenseAmountInput.value = '';
  });

  memberForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = memberNameInput.value.trim();
    if (!name || members.includes(name)) return;
    members.push(name);
    savePlanData(STORAGE_KEYS.MEMBERS, members);
    memberNameInput.value = '';
    renderAll();
  });

  expenseForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = expenseTitleInput.value.trim();
    const originalAmount = Number(expenseAmountInput.value);
    const currency = expenseCurrencySelect.value || 'JPY';
    const payer = expensePayerSelect.value;

    if (!title || !originalAmount || !payer) return;

    const amount = convertToJpy(originalAmount, currency);

    if (editingExpenseId) {
      expenses = expenses.map((item) =>
        item.id === editingExpenseId
          ? { ...item, title, amount, originalAmount, currency, payer }
          : item
      );
      resetExpenseEditMode();
    } else {
      expenses.push({
        id: Date.now().toString(),
        title,
        amount,
        originalAmount,
        currency,
        payer,
      });
    }

    savePlanData(STORAGE_KEYS.EXPENSES, expenses);
    expenseTitleInput.value = '';
    expenseAmountInput.value = '';
    renderAll();
  });

  function reload() {
    resetExpenseEditMode();
    memberNameInput.value = '';
    expenseTitleInput.value = '';
    expenseAmountInput.value = '';
    members = loadPlanData(STORAGE_KEYS.MEMBERS, []);
    expenses = loadPlanData(STORAGE_KEYS.EXPENSES, []);
    rates = { ...DEFAULT_RATES, ...loadPlanData(STORAGE_KEYS.RATES, {}) };
    renderRateInputs();
    syncExpenseAmounts();
    renderAll();
  }

  renderAll();
  return { reload };
}

/**
 * タブ3: 持ち物＆行きたい場所リスト機能の初期化
 */
function initLists() {
  const packingForm = document.getElementById('packing-form');
  const packingInput = document.getElementById('packing-input');
  const packingListEl = document.getElementById('packing-list');

  const packingNightsInput = document.getElementById('packing-nights');
  const packingOverseasCheckbox = document.getElementById('packing-overseas');
  const packingAutoAddBtn = document.getElementById('packing-auto-add-btn');
  const packingTemplateToggleBtn = document.getElementById('packing-template-toggle-btn');
  const packingTemplatePanel = document.getElementById('packing-template-panel');
  const packingTemplateForm = document.getElementById('packing-template-form');
  const templateCategorySelect = document.getElementById('template-category');
  const templateItemNameInput = document.getElementById('template-item-name');
  const packingTemplateListEl = document.getElementById('packing-template-list');

  const placesForm = document.getElementById('places-form');
  const placeNameInput = document.getElementById('place-name');
  const placeMemoInput = document.getElementById('place-memo');
  const placeLocationInput = document.getElementById('place-location');
  const placeUrlInput = document.getElementById('place-url');
  const placeSubmitBtn = document.getElementById('place-submit-btn');
  const placeCancelBtn = document.getElementById('place-cancel-btn');
  const placesListEl = document.getElementById('places-list');

  const DEFAULT_PACKING_TEMPLATE = {
    always: [
      '財布（現金・クレカ・身分証）',
      'スマートフォン',
      'モバイルバッテリー＆ケーブル',
      'ワイヤレスイヤホン',
      'ハンカチ・ティッシュ',
      '常備薬・絆創膏',
      'エコバッグ',
    ],
    perNight: [
      '着替え',
      '下着・靴下',
    ],
    perNightPlusOne: [
      'コンタクトレンズ',
    ],
    stayFixed: [
      'スマホ・ウォッチ用充電器',
      'スキンケアセット（化粧水等）',
      'ヘアスタイリング剤',
      'シェーバー・洗面用具',
      '洗濯物用ビニール袋・圧縮袋',
    ],
    overseas: [
      'パスポート',
      '電源変換プラグ',
      'eSIM・通信手段の確認',
      '機内記入用ボールペン',
    ],
  };

  const TEMPLATE_CATEGORIES = [
    { key: 'always', label: '【A. 0泊以上（常に追加）】', suffix: '' },
    { key: 'perNight', label: '【B-1. 1泊以上（×〇日分）】', suffix: '（×〇日分）' },
    { key: 'perNightPlusOne', label: '【B-2. 1泊以上（×〇＋1日分）】', suffix: '（×〇＋1日分）' },
    { key: 'stayFixed', label: '【C. 1泊以上（1セット固定）】', suffix: '' },
    { key: 'overseas', label: '【D. 海外旅行のみ追加】', suffix: '' },
  ];

  function loadPackingTemplate() {
    const saved = loadData(STORAGE_KEYS.PACKING_TEMPLATE, null);
    if (!saved || typeof saved !== 'object') {
      return JSON.parse(JSON.stringify(DEFAULT_PACKING_TEMPLATE));
    }
    return {
      always: Array.isArray(saved.always) ? saved.always : [...DEFAULT_PACKING_TEMPLATE.always],
      perNight: Array.isArray(saved.perNight) ? saved.perNight : [...DEFAULT_PACKING_TEMPLATE.perNight],
      perNightPlusOne: Array.isArray(saved.perNightPlusOne)
        ? saved.perNightPlusOne
        : [...DEFAULT_PACKING_TEMPLATE.perNightPlusOne],
      stayFixed: Array.isArray(saved.stayFixed) ? saved.stayFixed : [...DEFAULT_PACKING_TEMPLATE.stayFixed],
      overseas: Array.isArray(saved.overseas) ? saved.overseas : [...DEFAULT_PACKING_TEMPLATE.overseas],
    };
  }

  let packingTemplate = loadPackingTemplate();
  let packingItems = loadPlanData(STORAGE_KEYS.PACKING_LIST, []);
  let placeItems = loadPlanData(STORAGE_KEYS.PLACES_LIST, []);
  let editingPlaceId = null;

  function renderPackingTemplate() {
    packingTemplateListEl.innerHTML = '';

    TEMPLATE_CATEGORIES.forEach(({ key, label, suffix }) => {
      const group = document.createElement('div');
      group.className = 'template-category-group';

      const title = document.createElement('div');
      title.className = 'template-category-title';
      title.textContent = label;
      group.appendChild(title);

      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'member-tags';

      const list = packingTemplate[key] || [];
      if (list.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'placeholder-text';
        empty.textContent = '登録なし';
        tagsWrap.appendChild(empty);
      } else {
        list.forEach((itemName) => {
          const tag = document.createElement('span');
          tag.className = 'member-tag';
          tag.textContent = `${itemName}${suffix}`;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.textContent = '×';
          removeBtn.title = `${itemName}をテンプレートから削除`;
          removeBtn.addEventListener('click', () => {
            packingTemplate[key] = packingTemplate[key].filter((n) => n !== itemName);
            saveData(STORAGE_KEYS.PACKING_TEMPLATE, packingTemplate);
            renderPackingTemplate();
          });

          tag.appendChild(removeBtn);
          tagsWrap.appendChild(tag);
        });
      }

      group.appendChild(tagsWrap);
      packingTemplateListEl.appendChild(group);
    });
  }

  packingTemplateToggleBtn.addEventListener('click', () => {
    packingTemplatePanel.classList.toggle('hidden');
  });

  packingTemplateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cat = templateCategorySelect.value;
    const name = templateItemNameInput.value.trim();
    if (!cat || !name || !packingTemplate[cat]) return;

    if (!packingTemplate[cat].includes(name)) {
      packingTemplate[cat].push(name);
      saveData(STORAGE_KEYS.PACKING_TEMPLATE, packingTemplate);
      renderPackingTemplate();
    }
    templateItemNameInput.value = '';
  });

  packingAutoAddBtn.addEventListener('click', () => {
    const nights = Math.max(0, Math.floor(Number(packingNightsInput.value) || 0));
    packingNightsInput.value = nights;
    const includeOverseas = packingOverseasCheckbox.checked;

    const candidates = [];

    // A. 0泊以上（常に追加）
    packingTemplate.always.forEach((name) => {
      candidates.push(name);
    });

    // B & C. 1泊以上の場合に追加
    if (nights >= 1) {
      packingTemplate.perNight.forEach((name) => {
        candidates.push(`${name}（×${nights}日分）`);
      });
      packingTemplate.perNightPlusOne.forEach((name) => {
        candidates.push(`${name}（×${nights + 1}日分）`);
      });
      packingTemplate.stayFixed.forEach((name) => {
        candidates.push(name);
      });
    }

    // D. 「海外旅行アイテムも含める」にチェックがある場合にのみ追加
    if (includeOverseas) {
      packingTemplate.overseas.forEach((name) => {
        candidates.push(name);
      });
    }

    const existingTitles = new Set(packingItems.map((i) => i.title));
    let addedCount = 0;

    candidates.forEach((title, idx) => {
      if (!existingTitles.has(title)) {
        packingItems.push({
          id: `${Date.now()}_${idx}`,
          title,
          checked: false,
        });
        existingTitles.add(title);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      savePlanData(STORAGE_KEYS.PACKING_LIST, packingItems);
      renderPacking();
    }
  });

  function resetPlaceEditMode() {
    editingPlaceId = null;
    placeSubmitBtn.textContent = '場所を追加';
    placeCancelBtn.classList.add('hidden');
  }

  function renderPacking() {
    packingListEl.innerHTML = '';

    if (packingItems.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'placeholder-text';
      emptyMsg.textContent = 'まだ持ち物が登録されていません。';
      packingListEl.appendChild(emptyMsg);
      return;
    }

    packingItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = `checklist-item${item.checked ? ' checked' : ''}`;

      const label = document.createElement('label');
      label.className = 'checklist-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(item.checked);
      checkbox.addEventListener('change', () => {
        item.checked = checkbox.checked;
        savePlanData(STORAGE_KEYS.PACKING_LIST, packingItems);
        renderPacking();
      });

      const textGroup = document.createElement('div');
      textGroup.className = 'checklist-text-group';

      const titleEl = document.createElement('div');
      titleEl.className = 'checklist-title';
      titleEl.textContent = item.title;
      textGroup.appendChild(titleEl);

      label.appendChild(checkbox);
      label.appendChild(textGroup);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-delete';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', () => {
        packingItems = packingItems.filter((i) => i.id !== item.id);
        savePlanData(STORAGE_KEYS.PACKING_LIST, packingItems);
        renderPacking();
      });

      row.appendChild(label);
      row.appendChild(deleteBtn);
      packingListEl.appendChild(row);
    });
  }

  function renderPlaces() {
    placesListEl.innerHTML = '';

    if (placeItems.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.className = 'placeholder-text';
      emptyMsg.textContent = 'まだ行きたい場所が登録されていません。';
      placesListEl.appendChild(emptyMsg);
      return;
    }

    placeItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = `checklist-item${item.checked ? ' checked' : ''}`;

      const label = document.createElement('label');
      label.className = 'checklist-label';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(item.checked);
      checkbox.addEventListener('change', () => {
        item.checked = checkbox.checked;
        savePlanData(STORAGE_KEYS.PLACES_LIST, placeItems);
        renderPlaces();
      });

      const textGroup = document.createElement('div');
      textGroup.className = 'checklist-text-group';

      const titleEl = document.createElement('div');
      titleEl.className = 'checklist-title';
      titleEl.textContent = item.name;
      textGroup.appendChild(titleEl);

      if (item.memo) {
        const memoEl = document.createElement('div');
        memoEl.className = 'checklist-memo';
        memoEl.textContent = item.memo;
        textGroup.appendChild(memoEl);
      }

      const linksEl = document.createElement('div');
      linksEl.className = 'itinerary-links';

      const mapQuery = item.location || item.name;
      if (mapQuery) {
        const mapLink = document.createElement('a');
        mapLink.className = 'itinerary-link';
        mapLink.href = buildMapUrl(mapQuery);
        mapLink.target = '_blank';
        mapLink.rel = 'noopener noreferrer';
        const isRawUrl = /^https?:\/\//i.test(mapQuery);
        mapLink.textContent = isRawUrl ? '📍 マップを開く' : `📍 ${mapQuery}`;
        linksEl.appendChild(mapLink);
      }

      if (item.url) {
        const webLink = document.createElement('a');
        webLink.className = 'itinerary-link';
        webLink.href = item.url;
        webLink.target = '_blank';
        webLink.rel = 'noopener noreferrer';
        webLink.textContent = '🔗 参考URLを開く';
        linksEl.appendChild(webLink);
      }

      textGroup.appendChild(linksEl);

      label.appendChild(checkbox);
      label.appendChild(textGroup);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-edit';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => {
        editingPlaceId = item.id;
        placeNameInput.value = item.name;
        placeMemoInput.value = item.memo || '';
        placeLocationInput.value = item.location || '';
        placeUrlInput.value = item.url || '';
        placeSubmitBtn.textContent = '場所を更新';
        placeCancelBtn.classList.remove('hidden');
        placesForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        placeNameInput.focus();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-delete';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', () => {
        placeItems = placeItems.filter((i) => i.id !== item.id);
        if (editingPlaceId === item.id) {
          resetPlaceEditMode();
          placeNameInput.value = '';
          placeMemoInput.value = '';
          placeLocationInput.value = '';
          placeUrlInput.value = '';
        }
        savePlanData(STORAGE_KEYS.PLACES_LIST, placeItems);
        renderPlaces();
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);

      row.appendChild(label);
      row.appendChild(actions);
      placesListEl.appendChild(row);
    });
  }

  placeCancelBtn.addEventListener('click', () => {
    resetPlaceEditMode();
    placeNameInput.value = '';
    placeMemoInput.value = '';
    placeLocationInput.value = '';
    placeUrlInput.value = '';
  });

  packingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = packingInput.value.trim();
    if (!title) return;

    packingItems.push({
      id: Date.now().toString(),
      title,
      checked: false,
    });

    savePlanData(STORAGE_KEYS.PACKING_LIST, packingItems);
    packingInput.value = '';
    renderPacking();
  });

  placesForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = placeNameInput.value.trim();
    const memo = placeMemoInput.value.trim();
    const location = placeLocationInput.value.trim();
    const url = placeUrlInput.value.trim();
    if (!name) return;

    if (editingPlaceId) {
      placeItems = placeItems.map((item) =>
        item.id === editingPlaceId ? { ...item, name, memo, location, url } : item
      );
      resetPlaceEditMode();
    } else {
      placeItems.push({
        id: Date.now().toString(),
        name,
        memo,
        location,
        url,
        checked: false,
      });
    }

    savePlanData(STORAGE_KEYS.PLACES_LIST, placeItems);
    placeNameInput.value = '';
    placeMemoInput.value = '';
    placeLocationInput.value = '';
    placeUrlInput.value = '';
    renderPlaces();
  });

  function reload() {
    resetPlaceEditMode();
    packingInput.value = '';
    placeNameInput.value = '';
    placeMemoInput.value = '';
    placeLocationInput.value = '';
    placeUrlInput.value = '';
    packingItems = loadPlanData(STORAGE_KEYS.PACKING_LIST, []);
    placeItems = loadPlanData(STORAGE_KEYS.PLACES_LIST, []);
    renderPacking();
    renderPlaces();
  }

  renderPackingTemplate();
  renderPacking();
  renderPlaces();
  return { reload };
}

document.addEventListener('DOMContentLoaded', () => {
  let itineraryCtrl;
  let expensesCtrl;
  let listsCtrl;

  initPlans(() => {
    if (itineraryCtrl) itineraryCtrl.reload();
    if (expensesCtrl) expensesCtrl.reload();
    if (listsCtrl) listsCtrl.reload();
  });

  initTabs();
  itineraryCtrl = initItinerary();
  expensesCtrl = initExpenses();
  listsCtrl = initLists();
});

