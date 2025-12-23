const PROJECT_START_DATE = new Date(2020, 0, 1);
const STORAGE_KEY = 'financial_flow_data_v3';
const SYNC_TIME_KEY = 'flow_last_sync_time'; // [New] 用來追蹤同步狀態
const BATCH_SIZE = 90;
const PAST_BUFFER_DAYS = 90;
const FUTURE_BUFFER_DAYS = 180;
const SUPPORTED_CURRENCIES = ['USD', 'TWD', 'HKD', 'JPY', 'CNY', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD', 'NZD', 'ZAR', 'CHF', 'SEK', 'THB', 'IDR', 'PHP', 'TRY'];
// [Config] Map Currency to Country Code for FlagCDN
const CURRENCY_COUNTRY_MAP = {
    USD: 'us', TWD: 'tw', HKD: 'hk', JPY: 'jp', CNY: 'cn',
    EUR: 'eu', GBP: 'gb', AUD: 'au', CAD: 'ca', SGD: 'sg',
    NZD: 'nz', ZAR: 'za', CHF: 'ch', SEK: 'se', THB: 'th',
    IDR: 'id', PHP: 'ph', TRY: 'tr'
};
const BASE_API_URL = 'https://open.er-api.com/v6/latest';
let exchangeRates = { base: 'EUR', rates: {}, lastUpdated: 0 };
const DEFAULT_FLOW_SETTINGS = { multiCurrency: false, base: 'TWD', currencies: ['TWD'] };

// 日曆圖標 SVG (簡約風格)
const ICON_CAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

// 列表圖標 SVG (簡約風格)
const ICON_LIST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

let appData = {
    currentFlowId: 'flow_default',
    flows: { 'flow_default': { name: 'Prime Flow', transactions: [] } },
    lastUpdated: Date.now() // [New] 初始化時間戳記
};

let loadedStartDate = new Date();
let loadedEndDate = new Date();
let currentNavDate = new Date();
let isNavigating = false;
let isLoading = false;
let isInitialRender = true;
let isFlowEditMode = false;

let tempViewCurrency = null; // [New] 用於 Footer 的純檢視切換，不影響真實資料
let pendingFlowSettings = null; // [New] 用於開啟多幣種時的暫存設定

let undoFadeTimeout = null;

// View State
let currentViewMode = 'timeline'; // 'timeline' or 'calendar'
let selectedCalendarDateStr = null; // For Footer Editor in Calendar Mode

let summaryMode = 'total'; // total, current, custom
let currentBottomRow = null;
let pickerStartDate = new Date();
let pickerEndDate = new Date();
let pickerBaseDate = new Date();
let tempStart = null;
let tempEnd = null;
let pickerHasInteracted = false;
let pickerMode = 'range'; // 'range' (區間) 或 'single' (單選)
let pickerTargetInput = null; // 單選模式下，要回填的 input 元素

// Recurring State
let recurType = 'expense';
let recurFreq = 'weekly';
let recurSelectedDays = new Set(); // Weekly selection (0-6)
let isRecurFormInitialized = false;

// Filter State
let filterSearchText = '';
let filterType = 'all'; // all, income, expense, note

// Undo State
let undoTimeout = null;
let undoData = null;

// Sync Conflict State
let pendingCloudData = null;
let pendingLocalData = null;
let flowToDeleteId = null;

// --- DOM Elements Helper ---
const getEl = (id) => document.getElementById(id);

// Main Containers
const planningList = getEl('planningList');
const timelineContainer = getEl('timelineContainer');
const calendarViewContainer = getEl('calendarViewContainer');
const listViewWrapper = getEl('listViewWrapper');
const listHeader = getEl('listHeader');

// Footer Elements
const forecastContainer = getEl('forecastContainer');
const footerDayEditor = getEl('footerDayEditor');

// Overlays
const filterOverlay = getEl('filterOverlay');
const userProfileOverlay = getEl('userProfileOverlay');
const loginOverlay = getEl('loginOverlay');
const dateRangeOverlay = getEl('dateRangeOverlay');
const recurringOverlay = getEl('recurringOverlay');

let currentUser = null;

// --- Currency Utilities ---
async function fetchExchangeRates() {
    try {
        const base = exchangeRates.base || 'EUR';
        
        // 使用 Open Access 網址結構: https://open.er-api.com/v6/latest/EUR
        const response = await fetch(`${BASE_API_URL}/${base}`);
        
        if (!response.ok) throw new Error('Failed to fetch exchange rates');
        const data = await response.json();
        
        exchangeRates = {
            base: data.base_code || base, // V6 API uses 'base_code'
            rates: data.rates || {},
            lastUpdated: Date.now()
        };

        // UI Refresh logic
        console.log(`[Rate API] Loaded for ${base}. Refreshing UI...`);
        if (typeof updateUIForCurrency === 'function') {
            updateUIForCurrency(true);
        }
    } catch (err) {
        console.error('Exchange rate fetch error:', err);
    }
}

// [修正] 匯率換算邏輯：加入防呆與自動重試
function convertCurrency(amount, fromCurrency, toCurrency) {
    if (!amount || !fromCurrency || !toCurrency || fromCurrency === toCurrency) {
        return amount;
    }
    const { base, rates } = exchangeRates;

    // 如果沒有匯率資料，嘗試重新抓取並暫時回傳原值
    if (!rates || Object.keys(rates).length === 0) {
        console.warn('Exchange rates missing, fetching now...');
        fetchExchangeRates(); // 觸發重抓
        return amount;
    }

    // 定義轉換至 API 基準幣 (通常是 EUR) 的函數
    const toBase = (value, currency) => {
        if (currency === base) return value;
        const rate = rates[currency];
        // 如果找不到匯率，回傳 null 代表失敗
        if (!rate || rate === 0) return null;
        return value / rate;
    };

    // 定義從 API 基準幣轉換至目標幣的函數
    const fromBase = (value, currency) => {
        if (currency === base) return value;
        const rate = rates[currency];
        if (!rate) return null;
        return value * rate;
    };

    let baseValue = toBase(amount, fromCurrency);
    if (baseValue == null) return amount; // 轉換失敗回傳原值
    const converted = fromBase(baseValue, toCurrency);
    return converted == null ? amount : converted;
}

// --- Initialization ---
function init() {
    // [Check] Stop execution if inside In-App Browser
    if (detectInAppBrowser()) {
        return; // 停止載入 App 其餘部分，只顯示引導頁
    }
    fetchExchangeRates();
    const checkFirebase = setInterval(() => {
        if (window.firebaseAuth) {
            clearInterval(checkFirebase);
            setupAuth();
        }
    }, 100);

    loadLocalData();
    setupUI();
    setupScrollListener();
    updateScrollbarWidth();

    const today = new Date();
    pickerStartDate = new Date(today);
    pickerEndDate = new Date(today);
    pickerBaseDate = new Date(today);

    resetViewAroundDate(new Date(), 'auto');
    syncViewStateClasses();
    setTimeout(() => { isInitialRender = false; }, 1000);
}

// --- Helper: 數字縮寫工具 (修正負數與小數點問題) ---
function formatCompactNumber(number) {
    // 1. 如果不是數字，直接回傳
    if (number === undefined || number === null || isNaN(number)) return '0';

    const abs = Math.abs(number);
    const sign = number < 0 ? '-' : '';

    // 2. 門檻值：100,000 (針對絕對值判斷)
    // 如果小於 100k，顯示完整數字，但限制小數點最多 1 位 (避免 .665)
    if (abs < 100000) {
        return number.toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 1
        });
    }

    // 3. 大於 100k，進行 K/M/B/T 縮寫
    const units = ['K', 'M', 'B', 'T'];
    // 計算級距 (0=K, 1=M, 2=B...)
    // log10(100,000) = 5. tier 應該從 1000 (10^3) 開始算
    // 這裡我們簡單處理：除以 1000 的次方
    
    // 找出適當的單位
    let unitIndex = -1;
    let scaled = abs;
    
    // 簡單迴圈找出最大單位
    if (abs >= 1.0e12) { unitIndex = 3; scaled = abs / 1.0e12; }      // T
    else if (abs >= 1.0e9) { unitIndex = 2; scaled = abs / 1.0e9; }   // B
    else if (abs >= 1.0e6) { unitIndex = 1; scaled = abs / 1.0e6; }   // M
    else { unitIndex = 0; scaled = abs / 1.0e3; }                     // K

    const suffix = units[unitIndex];

    // 4. 回傳：符號 + 縮寫後的數字(小數1位) + 單位
    // 例如: -142.3K
    return sign + scaled.toFixed(1).replace(/\.0$/, '') + suffix;
}

// --- Helper: Setup Custom Dropdown Logic ---
function setupCustomDropdown(wrapperId, onSelectCallback) {
    const wrapper = document.getElementById(wrapperId);
    if (!wrapper) return;
    
    const trigger = wrapper.querySelector('.custom-select-trigger');
    const options = wrapper.querySelector('.custom-select-options');
    const textSpan = wrapper.querySelector('span'); // The text inside trigger

    if (!trigger || !options) return;

    // Toggle
    trigger.onclick = (e) => {
        e.stopPropagation();
        const isHidden = options.classList.contains('hidden');
        // Close all other dropdowns
        document.querySelectorAll('.custom-select-options').forEach(el => el.classList.add('hidden'));
        
        if (isHidden) options.classList.remove('hidden');
    };

    // Options Click
    options.querySelectorAll('.custom-option').forEach(opt => {
        opt.onclick = (e) => {
            e.stopPropagation();
            const val = opt.dataset.value;
            if (textSpan) textSpan.textContent = val;
            options.classList.add('hidden');
            if (onSelectCallback) onSelectCallback(val);
        };
    });
}

// Global click to close
document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select-options').forEach(el => el.classList.add('hidden'));
});

// --- Helper: System Toast (Custom Alert) ---
function showSystemToast(msg) {
    const toast = getEl('systemToast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('visible');

    // [New] Click to dismiss immediately
    toast.onclick = () => {
        toast.classList.remove('visible');
    };

    // Auto hide after 3 seconds
    setTimeout(() => {
        toast.classList.remove('visible');
    }, 3000);
}

// --- Data Logic ---
function getCurrentTransactions() {
    const id = appData.currentFlowId;
    if (!appData.flows[id]) appData.flows[id] = { name: 'Prime Flow', transactions: [] };
    return appData.flows[id].transactions;
}

function setCurrentTransactions(t) {
    appData.flows[appData.currentFlowId].transactions = t;
    saveData();
}

function getFlowSettings(flowId = appData.currentFlowId) {
    if (!appData.flows[flowId]) {
        appData.flows[flowId] = { name: 'Prime Flow', transactions: [], settings: { ...DEFAULT_FLOW_SETTINGS } };
    }
    const flow = appData.flows[flowId];
    const settings = { ...DEFAULT_FLOW_SETTINGS, ...(flow.settings || {}) };
    if (!SUPPORTED_CURRENCIES.includes(settings.base)) {
        settings.base = DEFAULT_FLOW_SETTINGS.base;
    }
    if (!Array.isArray(settings.currencies) || settings.currencies.length === 0) {
        settings.currencies = [...DEFAULT_FLOW_SETTINGS.currencies];
    }
    settings.currencies = settings.currencies
        .filter(code => SUPPORTED_CURRENCIES.includes(code))
        .filter((code, idx, arr) => arr.indexOf(code) === idx);
    if (!settings.currencies.includes(settings.base)) settings.currencies.push(settings.base);
    settings.multiCurrency = !!settings.multiCurrency;
    flow.settings = settings;
    return settings;
}

function saveFlowSettings(newSettings = {}, flowId = appData.currentFlowId) {
    if (!appData.flows[flowId]) {
        appData.flows[flowId] = { name: 'Prime Flow', transactions: [] };
    }
    const merged = { ...getFlowSettings(flowId), ...newSettings };
    appData.flows[flowId].settings = merged;
    saveData();
    return merged;
}

function getActiveCurrencyList(settings = getFlowSettings()) {
    const base = settings.base || DEFAULT_FLOW_SETTINGS.base;
    let list = Array.isArray(settings.currencies) ? settings.currencies.slice() : [];
    if (!list.includes(base)) list.push(base);
    list = list.filter(code => SUPPORTED_CURRENCIES.includes(code));
    if (list.length === 0) list = [base];
    return [...new Set(list)];
}

function getCurrencyOptionsHtml(selectedCurrency = null, settings = null) {
    const flowSettings = settings || getFlowSettings();
    const activeCurrencies = getActiveCurrencyList(flowSettings);
    const currentValue = selectedCurrency || flowSettings.base;
    return activeCurrencies.map(code => {
        return `<option value="${code}" ${code === currentValue ? 'selected' : ''}>${code}</option>`;
    }).join('');
}

function populateCurrencySelect(selectEl, selectedCurrency = null, settings = null) {
    if (!selectEl) return;
    const flowSettings = settings || getFlowSettings();
    const currentValue = selectedCurrency || selectEl.value || flowSettings.base;
    selectEl.innerHTML = getCurrencyOptionsHtml(currentValue, flowSettings);
    selectEl.value = currentValue;
    if (!getActiveCurrencyList(flowSettings).includes(selectEl.value)) {
        selectEl.value = flowSettings.base;
    }
}

function setupFlowSettingsUI() {
    const btnSettings = getEl('btnFlowSettings');
    if (btnSettings) {
        btnSettings.onclick = (e) => {
            e.stopPropagation();
            openFlowSettings();
        };
    }

    const closeBtn = getEl('btnFlowSettingsClose');
    const overlay = getEl('flowSettingsOverlay');
    
    const closeSettings = () => {
        overlay.classList.add('hidden');
        // [新增] 關閉時順便移除 expanded，避免下次開啟瞬間閃爍
        overlay.classList.remove('expanded'); 
        
        pendingFlowSettings = null; 
        
        const toggle = getEl('toggleMultiCurrency');
        const currentSettings = getFlowSettings();
        if (toggle) {
            if (!currentSettings.multiCurrency && toggle.checked) {
                toggle.checked = false;
                getEl('multiCurrencyConfigPanel').classList.add('hidden');
            }
        }
    };

    if (closeBtn) closeBtn.onclick = closeSettings;
    if (overlay) {
        overlay.onclick = (e) => {
            if (e.target === overlay) closeSettings();
        };
    }

    const toggle = getEl('toggleMultiCurrency');
    if (toggle) {
        toggle.onchange = null;
        toggle.onclick = (e) => {
            const isTurningOn = e.target.checked;
            const panel = getEl('multiCurrencyConfigPanel');
            
            if (isTurningOn) {
                // [新增] 開啟時 -> 視窗變大 (Expanded)
                overlay.classList.add('expanded');

                if (panel) panel.classList.remove('hidden');
                
                const currentSettings = getFlowSettings();
                pendingFlowSettings = {
                    base: null, 
                    currencies: [...currentSettings.currencies],
                    multiCurrency: true
                };
                
                renderUnifiedCurrencyList(true); 

            } else {
                // [新增] 關閉時 -> 視窗變小 (Compact)
                // 注意：如果下面檢查到有衝突，會被 toggle.checked = true 擋下來
                // 所以這裡先移除，若 return 發生，後面邏輯會處理
                overlay.classList.remove('expanded');

                const settings = getFlowSettings();
                const base = settings.base;
                const txs = getCurrentTransactions();
                const usedCurrencies = new Set();
                
                txs.forEach(t => {
                    if (t.income > 0) usedCurrencies.add(t.incCurrency || base);
                    if (t.expense > 0) usedCurrencies.add(t.expCurrency || base);
                });

                if (usedCurrencies.size > 1 || (usedCurrencies.size === 1 && !usedCurrencies.has(base))) {
                     e.preventDefault(); 
                     toggle.checked = true; 
                     // [例外] 如果被擋下來，視窗要保持開啟狀態
                     overlay.classList.add('expanded');
                     showConvertOverlay('disable', base, usedCurrencies);
                     return;
                }
                
                saveFlowSettings({ multiCurrency: false });
                if (panel) panel.classList.add('hidden');
                updateUIForCurrency();
            }
        };
    }
}

function openFlowSettings() {
    const overlay = getEl('flowSettingsOverlay');
    if (!overlay) return;
    
    const settings = getFlowSettings();
    const toggle = getEl('toggleMultiCurrency');
    const panel = getEl('multiCurrencyConfigPanel');

    // 重置暫存
    pendingFlowSettings = null;

    const isMultiEnabled = !!settings.multiCurrency;

    if (toggle) {
        toggle.checked = isMultiEnabled;
        if (panel) {
            if (isMultiEnabled) panel.classList.remove('hidden');
            else panel.classList.add('hidden');
        }
    }

    // [新增] 根據目前的開啟狀態，決定是否加上 .expanded class
    // 如果開啟 => expanded (高視窗)
    // 如果關閉 => 移除 expanded (矮視窗，置中)
    if (isMultiEnabled) {
        overlay.classList.add('expanded');
    } else {
        overlay.classList.remove('expanded');
    }

    // 渲染列表 (False 代表非 Pending 模式)
    renderUnifiedCurrencyList(false);
    
    overlay.classList.remove('hidden');
}

// [UX Upgrade] 渲染統一貨幣列表 (Frozen Footer 版本)
function renderUnifiedCurrencyList(isPendingMode = false) {
    const listContainer = getEl('unifiedCurrencyList');
    const panel = getEl('multiCurrencyConfigPanel');
    if (!listContainer || !panel) return;
    
    listContainer.innerHTML = '';
    
    // 決定資料來源
    const settings = isPendingMode && pendingFlowSettings ? pendingFlowSettings : getFlowSettings();
    const activeSet = new Set(settings.currencies || []);
    const baseCur = settings.base;

    // 1. 渲染貨幣列表 (這部分會滾動)
    SUPPORTED_CURRENCIES.forEach(code => {
        const isBase = code === baseCur;
        const isActive = activeSet.has(code);
        const item = document.createElement('div');
        
        // 樣式：Pending Base 會觸發 CSS 中的 .pending-base (細黑框)
        item.className = `uc-item ${isBase ? (isPendingMode ? 'pending-base' : 'is-base') : ''}`;
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isActive;
        checkbox.disabled = isBase; 
        
        checkbox.onchange = () => {
            if (isPendingMode) {
                const newSet = new Set(pendingFlowSettings.currencies);
                if (checkbox.checked) {
                    if (newSet.size >= 5) {
                        checkbox.checked = false;
                        showSystemToast("Maximum 5 currencies.");
                        return;
                    }
                    newSet.add(code);
                } else {
                    newSet.delete(code);
                }
                pendingFlowSettings.currencies = Array.from(newSet);
                renderUnifiedCurrencyList(true); 
            } else {
                toggleCurrencySelection(code);
            }
        };

        const countryCode = CURRENCY_COUNTRY_MAP[code];
        const imgHtml = countryCode 
            ? `<img src="https://flagcdn.com/w80/${countryCode}.png" class="flag-img" alt="${code}">` 
            : '';
        
        let actionHtml = '';
        if (isBase) {
            actionHtml = `<span class="badge-default">DEFAULT</span>`;
        } else if (isActive) {
            const visibilityClass = isPendingMode ? 'force-visible' : '';
            actionHtml = `<button class="btn-make-default ${visibilityClass}">Set Default</button>`;
        } else {
            actionHtml = `<div class="btn-placeholder"></div>`;
        }

        item.innerHTML = `
            <div class="uc-left">
                <div class="uc-check-wrapper"></div> 
                ${imgHtml}
                <span class="uc-code">${code}</span>
            </div>
            <div class="uc-right">
                ${actionHtml}
            </div>
        `;
        
        item.querySelector('.uc-check-wrapper').appendChild(checkbox);

        const btnSetDefault = item.querySelector('.btn-make-default');
        if (btnSetDefault) {
            btnSetDefault.onclick = (e) => {
                e.stopPropagation();
                if (isPendingMode) {
                    pendingFlowSettings.base = code;
                    if (!pendingFlowSettings.currencies.includes(code)) {
                        pendingFlowSettings.currencies.push(code);
                    }
                    renderUnifiedCurrencyList(true); 
                } else {
                    const active = new Set(getActiveCurrencyList(settings));
                    active.add(code);
                    saveFlowSettings({ base: code, currencies: Array.from(active) });
                    updateUIForCurrency();
                    openFlowSettings();
                }
            };
        }
        listContainer.appendChild(item);
    });

    // 2. 處理底部按鈕 (Frozen Footer)
    // [關鍵] 先移除舊的按鈕區，避免重複堆疊
    const oldActions = panel.querySelectorAll('.settings-footer-actions');
    oldActions.forEach(el => el.remove());

    if (isPendingMode) {
        const actionDiv = document.createElement('div');
        actionDiv.className = 'settings-footer-actions';
        
        const btnApply = document.createElement('button');
        // [關鍵] 套用新的統一風格 class
        btnApply.className = 'btn-apply-settings btn-action-unified';
        btnApply.textContent = 'CONFIRM & ENABLE';
        
        btnApply.onclick = () => {
            if (!pendingFlowSettings.base) {
                showSystemToast("Please select a DEFAULT currency.");
                return;
            }
            
            const txs = getCurrentTransactions();
            const untaggedTxs = txs.filter(t => !t.incCurrency && !t.expCurrency);
            
            if (untaggedTxs.length > 0) {
                showConvertOverlay('enable', pendingFlowSettings.base, null, pendingFlowSettings.currencies);
            } else {
                finalizeMultiCurrencyEnable();
                showSystemToast("Multi-Currency Mode Enabled");
            }
        };

        actionDiv.appendChild(btnApply);
        
        // [關鍵] 將按鈕區加入到 panel (listContainer 的兄弟層級)，實現固定底部
        panel.appendChild(actionDiv);
    }
}

function finalizeMultiCurrencyEnable(targetCurrencyForOldData = null) {
    if (!pendingFlowSettings) return;

    // 1. 如果有指定舊資料轉換幣別，進行批次更新
    if (targetCurrencyForOldData) {
        const txs = getCurrentTransactions();
        const newTxs = txs.map(t => {
            // 只更新未標記的
            if (!t.incCurrency && !t.expCurrency) {
                return { 
                    ...t, 
                    incCurrency: targetCurrencyForOldData, 
                    expCurrency: targetCurrencyForOldData 
                };
            }
            return t;
        });
        setCurrentTransactions(newTxs);
        showSystemToast(`Old transactions tagged as ${targetCurrencyForOldData}`);
    }

    // 2. 儲存設定
    saveFlowSettings(pendingFlowSettings);
    
    // 3. 清理 UI
    pendingFlowSettings = null;
    getEl('flowSettingsOverlay').classList.add('hidden');
    updateUIForCurrency();
}

// [Refactor] 統一的轉換/賦值詢問介面
function showConvertOverlay(mode, defaultTarget, usedCurrenciesSet = null, allowedOptions = null) {
    const overlay = getEl('currencyConvertOverlay');
    if (!overlay) return;

    const titleEl = overlay.querySelector('.conv-title');
    const descEl = overlay.querySelector('.conv-desc');
    const listEl = getEl('convCurrencyList');
    const selectEl = getEl('selConvTarget');
    const btnConfirm = getEl('btnConvertConfirm');
    const btnCancel = getEl('btnCancelConv');

    // 重置選單
    selectEl.innerHTML = '';
    
    if (mode === 'enable') {
        // --- 開啟模式：詢問舊資料要變成什麼幣 ---
        titleEl.textContent = "ASSIGN CURRENCY";
        
        // 描述
        descEl.innerHTML = `
            You have existing transactions without a currency tag.<br>
            Please select which currency to assign to them:
        `;
        listEl.textContent = ""; // 不需要顯示 used currencies 列表

        // 選項：僅限使用者剛剛勾選的那 5 個幣種
        const options = allowedOptions || [defaultTarget];
        selectEl.innerHTML = options.map(c => 
            `<option value="${c}" ${c === defaultTarget ? 'selected' : ''}>${c}</option>`
        ).join('');
        
        btnConfirm.textContent = "ASSIGN & ENABLE";
        
        // 確認動作
        btnConfirm.onclick = () => {
            const target = selectEl.value;
            finalizeMultiCurrencyEnable(target); // 呼叫套用函數
            overlay.classList.add('hidden');
        };

    } else {
        // --- 關閉模式：詢問要轉換成什麼幣 (原有邏輯) ---
        titleEl.textContent = "DISABLE MULTI-CURRENCY";
        const usedArray = Array.from(usedCurrenciesSet || []);
        listEl.textContent = usedArray.join(", ");
        
        descEl.innerHTML = `
            Your transactions use the following currencies:<br>
            <span id="convCurrencyList" style="font-weight: 700; color: #000; display: block; margin-top: 6px;">${usedArray.join(", ")}</span>
        `;
        
        // 選項：所有支援的幣種 (或 Active)
        const settings = getFlowSettings();
        const activeList = getActiveCurrencyList(settings);
        selectEl.innerHTML = activeList.map(c => 
            `<option value="${c}" ${c === defaultTarget ? 'selected' : ''}>${c}</option>`
        ).join('');
        
        btnConfirm.textContent = "CONVERT & DISABLE";
        
        // 確認動作 (原有轉幣邏輯)
        btnConfirm.onclick = () => {
            const targetCurrency = selectEl.value;
            const txs = getCurrentTransactions();
            const base = settings.base;
            
            const newTxs = txs.map(t => {
                const iCur = t.incCurrency || base;
                const eCur = t.expCurrency || base;
                let newInc = t.income;
                let newExp = t.expense;
                // 執行匯率換算
                if (t.income > 0 && iCur !== targetCurrency) newInc = convertCurrency(t.income, iCur, targetCurrency) || t.income;
                if (t.expense > 0 && eCur !== targetCurrency) newExp = convertCurrency(t.expense, eCur, targetCurrency) || t.expense;
                return { ...t, income: newInc, expense: newExp, incCurrency: targetCurrency, expCurrency: targetCurrency };
            });
            
            setCurrentTransactions(newTxs);
            // 儲存設定 (關閉多幣種，並將 Base 設為目標幣)
            saveFlowSettings({ multiCurrency: false, base: targetCurrency, currencies: [targetCurrency] });
            
            getEl('toggleMultiCurrency').checked = false;
            getEl('multiCurrencyConfigPanel').classList.add('hidden');
            
            // 更新 Footer Select
            const baseSel = getEl('selBaseCurrency'); 
            if(baseSel) baseSel.value = targetCurrency;

            updateUIForCurrency();
            overlay.classList.add('hidden');
            showSystemToast(`Converted all to ${targetCurrency}`);
        };
    }

    btnCancel.onclick = () => {
        overlay.classList.add('hidden');
        // 如果是 Enable 模式取消，要復原開關
        if (mode === 'enable') {
            const toggle = getEl('toggleMultiCurrency');
            if (toggle) toggle.checked = false;
            pendingFlowSettings = null;
            getEl('multiCurrencyConfigPanel').classList.add('hidden');
        } else {
             const toggle = getEl('toggleMultiCurrency');
             if (toggle) toggle.checked = true; // 保持開啟
        }
    };

    overlay.classList.remove('hidden');
}

function toggleCurrencySelection(code) {
    const settings = getFlowSettings();
    const activeSet = new Set(getActiveCurrencyList(settings));
    if (activeSet.has(code)) {
        if (code === settings.base) return;
        activeSet.delete(code);
        if (activeSet.size === 0) activeSet.add(settings.base);
    } else {
        if (activeSet.size >= 5) {
            showSystemToast("Maximum 5 active currencies allowed.");
            openFlowSettings();
            return;
        }
        activeSet.add(code);
    }
    saveFlowSettings({ currencies: Array.from(activeSet) });
    updateUIForCurrency();
    openFlowSettings();
}

function updateUIForCurrency(shouldRefresh = true) {
    const settings = getFlowSettings();
    const badge = getEl('viewCurrencyBadge');
    if (badge) {
        if (settings.multiCurrency) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    if (shouldRefresh) {
        if (currentViewMode === 'timeline') {
            resetViewAroundDate(currentNavDate, 'auto');
        } else {
            renderMainCalendarGrid();
        }
    }

    if (footerDayEditor && !footerDayEditor.classList.contains('hidden')) {
        const editingDate = getEl('editorDateLabel')?.textContent;
        if (editingDate) updateFooterEditor(editingDate);
    }

    updateTotalForecast();
}

// [Fix] Footer 點擊切換：只改變檢視 (View Only)，不影響真實資料或 Default
function cycleViewCurrency() {
    const settings = getFlowSettings();
    const active = getActiveCurrencyList(settings);
    if (active.length <= 1) return;
    
    // 取得當前檢視的幣別 (若無 temp，則從 settings.base 開始)
    const currentView = tempViewCurrency || settings.base;
    
    const currentIndex = active.indexOf(currentView);
    // 如果找不到 (可能被移除了)，歸零重算
    const idx = currentIndex === -1 ? 0 : currentIndex;
    
    const nextIndex = (idx + 1) % active.length;
    const nextCurrency = active[nextIndex];
    
    // [關鍵] 只更新暫存變數，不呼叫 saveFlowSettings
    tempViewCurrency = nextCurrency;
    
    // 更新 UI (Footer 數字 & Badge)
    updateTotalForecast();
    
    // 顯示提示
    showSystemToast(`View: ${nextCurrency} (Converted)`);
}

function loadLocalData() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) { try { appData = JSON.parse(stored); } catch { } }
    updateFlowUI();
}

function saveData(skipCloud = false) {
    // [修正] 每次儲存時，更新最後修改時間
    appData.lastUpdated = Date.now();
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    
    if (currentUser && !skipCloud && window.firebaseDb) {
        const { doc, setDoc } = window;
        
        // [修正重點] 移除 { merge: true }
        // 舊寫法: setDoc(doc(...), appData, { merge: true });
        // 因為刪除 Flow 時，本地物件少了一個 Key，Merge 模式會導致雲端舊 Key 殘留刪不掉。
        // 新寫法: 直接覆寫，確保雲端資料與本地完全一致 (包含刪除的操作)。
        setDoc(doc(window.firebaseDb, "users", currentUser.uid), appData);
    }
    
    // UI 更新邏輯 (保持不變)
    if (currentViewMode === 'timeline') {
        updateTotalForecast();
    } else {
        renderMainCalendarGrid();
        if (selectedCalendarDateStr) updateFooterEditor(selectedCalendarDateStr);
    }
}

async function loadCloudData(uid) {
    const { firebaseDb, doc, getDoc } = window;
    const localSnapshot = JSON.parse(JSON.stringify(appData));
    try {
        const snap = await getDoc(doc(firebaseDb, "users", uid));
        if (snap.exists() && snap.data().flows) {
            const cloudSnapshot = snap.data();
            console.log("Cloud data found, checking for conflicts...");
            checkAndPromptSync(localSnapshot, cloudSnapshot);
        } else {
            console.log("No cloud data, initializing...");
            saveData(false);
        }
    } catch (e) {
        console.error("Sync error:", e);
    }
}

/**
 * [Robust] Deep Comparison for Flows with Debugging
 * Fixes: False positives when re-opening tabs due to minor type mismatches.
 */
function areFlowsEqual(localFlows, cloudFlows) {
    localFlows = localFlows || {};
    cloudFlows = cloudFlows || {};
    const localKeys = Object.keys(localFlows).sort();
    const cloudKeys = Object.keys(cloudFlows).sort();

    // 1. Key count check
    if (localKeys.length !== cloudKeys.length) {
        console.log(`[Sync Diff] Flow count mismatch. Local: ${localKeys.length}, Cloud: ${cloudKeys.length}`);
        return false;
    }

    // 2. Key identity check
    for (let i = 0; i < localKeys.length; i++) {
        if (localKeys[i] !== cloudKeys[i]) {
            console.log(`[Sync Diff] Flow ID mismatch: ${localKeys[i]} vs ${cloudKeys[i]}`);
            return false;
        }
    }

    // 3. Content check per flow
    for (const key of localKeys) {
        const lFlow = localFlows[key];
        const cFlow = cloudFlows[key];

        if (!lFlow || !cFlow) return false;

        // Name Check (Trimmed)
        const lName = String(lFlow.name || '').trim();
        const cName = String(cFlow.name || '').trim();
        if (lName !== cName) {
            console.log(`[Sync Diff] Name mismatch in ${key}: "${lName}" vs "${cName}"`);
            return false;
        }

        // Transaction Comparison
        if (!areTransactionsEqual(lFlow.transactions, cFlow.transactions, key)) {
            return false;
        }
        
        // Settings Comparison (Optional but good for consistency)
        // We ignore settings diff to prevent prompt spam, assuming settings sync separately.
    }

    return true;
}

/**
 * [Robust] Compare Transaction Arrays with Type Safety
 */
function areTransactionsEqual(listA, listB, flowId = 'unknown') {
    const a = listA || [];
    const b = listB || [];

    if (a.length !== b.length) {
        console.log(`[Sync Diff] Tx count mismatch in ${flowId}: ${a.length} vs ${b.length}`);
        return false;
    }

    // Sort by ID to ensure order doesn't cause false flag
    const sortedA = [...a].sort((x, y) => String(x.id || '').localeCompare(String(y.id || '')));
    const sortedB = [...b].sort((x, y) => String(x.id || '').localeCompare(String(y.id || '')));

    for (let i = 0; i < sortedA.length; i++) {
        const txA = sortedA[i];
        const txB = sortedB[i];

        // 1. ID Check
        if (String(txA.id) !== String(txB.id)) {
            console.log(`[Sync Diff] Tx ID mismatch: ${txA.id} vs ${txB.id}`);
            return false;
        }

        // 2. Date Check
        if (String(txA.date) !== String(txB.date)) {
            console.log(`[Sync Diff] Date mismatch for ${txA.id}: ${txA.date} vs ${txB.date}`);
            return false;
        }

        // 3. Numeric Check (Income/Expense)
        // Handle floating point precision and type coercion (string vs number)
        const incA = parseFloat(txA.income) || 0;
        const incB = parseFloat(txB.income) || 0;
        if (Math.abs(incA - incB) > 0.001) {
            console.log(`[Sync Diff] Income mismatch for ${txA.id}: ${incA} vs ${incB}`);
            return false;
        }

        const expA = parseFloat(txA.expense) || 0;
        const expB = parseFloat(txB.expense) || 0;
        if (Math.abs(expA - expB) > 0.001) {
            console.log(`[Sync Diff] Expense mismatch for ${txA.id}: ${expA} vs ${expB}`);
            return false;
        }

        // 4. Note Check (Normalize null/undefined/non-string)
        const noteA = String(txA.note || '').trim();
        const noteB = String(txB.note || '').trim();
        if (noteA !== noteB) {
            console.log(`[Sync Diff] Note mismatch for ${txA.id}: "${noteA}" vs "${noteB}"`);
            return false;
        }
        
        // 5. Currency Check (Optional: Ignore if one side is missing to prevent legacy conflicts)
        // Only compare if both exist to avoid "Ghost Currency" prompt
        if (txA.incCurrency && txB.incCurrency && txA.incCurrency !== txB.incCurrency) {
             console.log(`[Sync Diff] IncCurrency mismatch: ${txA.incCurrency} vs ${txB.incCurrency}`);
             return false;
        }
    }

    return true;
}

function checkAndPromptSync(local, cloud) {
    // 1. 如果資料完全一致 (內容檢查)，直接結束
    // 這裡通常會回傳 true，除非有極小的差異
    if (areFlowsEqual(local.flows, cloud.flows)) {
        // 如果雲端的時間戳記比較新，雖然內容一樣，我們還是默默更新本地的時間戳記，保持同步
        if ((cloud.lastUpdated || 0) > (local.lastUpdated || 0)) {
            appData = cloud;
            saveData(true); // 只存本地，不回寫雲端
        }
        return; 
    }

    // 2. 引入時間戳記判斷
    const localTime = local.lastUpdated || 0;
    const cloudTime = cloud.lastUpdated || 0;

    // [情境 A] 雲端資料比本地新
    // 意義：你在電腦上改了資料 (Cloud變新)，現在打開手機 (Local還是舊的)。
    // 動作：直接自動同步 (Silent Sync)，不要打擾使用者。
    if (cloudTime > localTime) {
        console.log(`[Auto-Sync] Cloud (${cloudTime}) is newer than Local (${localTime}). Updating...`);
        appData = cloud; // 直接套用雲端資料
        saveData(true);  // 寫入本地 localStorage，但在參數設為 true 以避免觸發雲端回寫迴圈
        
        // 刷新畫面
        updateFlowUI();
        resetViewAroundDate(currentNavDate, 'auto');
        showSystemToast("Synced with latest cloud data."); // 友善提示即可
        return;
    }

    // [情境 B] 本地資料比雲端新 (或發生了真正的衝突)
    // 意義：你在手機離線時記了帳 (Local變新)，現在連上網了。
    // 動作：這時候才需要跳出視窗，問你要不要保留這些離線資料。
    
    // 過濾出有效的 Flow，避免空資料觸發
    const validLocalFlows = Object.values(local.flows || {}).filter(f => f.transactions && f.transactions.length > 0);
    
    if (validLocalFlows.length > 0) {
        console.log("Local offline changes detected. Prompting merge.");
        pendingLocalData = local;
        pendingCloudData = cloud;
        const overlay = getEl('syncOverlay');
        overlay?.classList.remove('hidden');
        renderSyncList(validLocalFlows);
    } else {
        // 如果本地其實沒有有效資料，直接用雲端的
        appData = cloud;
        saveData(true);
        updateFlowUI();
        resetViewAroundDate(currentNavDate, 'auto');
    }
}

function renderSyncList(flows) {
    const container = getEl('syncFlowList');
    if (!container) return;
    container.innerHTML = '';
    
    flows.forEach(flow => {
        // Find key in pendingLocalData
        const flowId = Object.keys(pendingLocalData.flows).find(key => pendingLocalData.flows[key] === flow);
        if (!flowId) return;

        const div = document.createElement('div');
        div.className = 'sync-item';
        div.dataset.id = flowId;
        div.innerHTML = `
            <div class="sync-info">
                <span class="sync-name">${flow.name}</span>
                <span class="sync-count">${flow.transactions.length} transactions</span>
            </div>
            <button class="btn-sync-delete" title="Discard this flow">
                <svg class="icon-trash" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;

        // [Logic Fix] Check if list is empty after deletion
        div.querySelector('.btn-sync-delete').onclick = () => {
            div.remove();
            
            // If no items left, close the overlay automatically
            if (container.children.length === 0) {
                getEl('syncOverlay')?.classList.add('hidden');
                pendingLocalData = null;
                pendingCloudData = null;
            }
        };

        container.appendChild(div);
    });

    const confirmBtn = getEl('btnSyncConfirm');
    if (confirmBtn) {
        confirmBtn.onclick = () => {
            const remainingIds = Array.from(container.querySelectorAll('.sync-item')).map(el => el.dataset.id);
            executeMerge(remainingIds);
        };
    }

    const discardBtn = getEl('btnSyncDiscardAll');
    if (discardBtn) {
        discardBtn.onclick = () => executeMerge([]);
    }
}

function executeMerge(keepFlowIds) {
    if (!pendingCloudData || !pendingLocalData) {
        getEl('syncOverlay')?.classList.add('hidden');
        return;
    }
    
    // 深拷貝雲端資料作為基底
    const finalData = JSON.parse(JSON.stringify(pendingCloudData));
    
    if (keepFlowIds.length > 0) {
        keepFlowIds.forEach(id => {
            const localFlow = pendingLocalData.flows[id];
            if (!localFlow) return;

            // [New 1] 獲取本地 Flow 的基礎幣別，若無則用預設值 (TWD)
            const localSettings = localFlow.settings || { ...DEFAULT_FLOW_SETTINGS };
            const localBase = localSettings.base || 'TWD';

            if (!finalData.flows[id]) {
                // 如果是新 Flow，直接整包複製
                finalData.flows[id] = localFlow;
            } else {
                // 如果是合併到現有 Flow
                const cloudFlow = finalData.flows[id];
                
                // 確保雲端物件有 settings
                if (!cloudFlow.settings) {
                    cloudFlow.settings = { ...DEFAULT_FLOW_SETTINGS };
                }

                const existingTxIds = new Set(cloudFlow.transactions.map(t => t.id));
                
                localFlow.transactions.forEach(tx => {
                    if (!existingTxIds.has(tx.id)) {
                        // [New 2] 建立安全副本，避免修改到原始參照
                        const safeTx = { ...tx };

                        // [修正核心] 幣別標籤化 (Currency Stamping)
                        // 如果交易原本沒有指定幣別 (代表是用 Local Base)，在合併時強制標記上去
                        // 這樣即使合併到不同幣別的帳本，數值代表的意義也不會跑掉
                        if (safeTx.income > 0 && !safeTx.incCurrency) {
                            safeTx.incCurrency = localBase;
                        }
                        if (safeTx.expense > 0 && !safeTx.expCurrency) {
                            safeTx.expCurrency = localBase;
                        }

                        cloudFlow.transactions.push(safeTx);
                    }
                });

                // [New 3] 自動擴充雲端 Flow 的支援幣別列表
                // 如果合併進來的交易帶有新的幣別 (例如 JPY)，要確保雲端設定有開啟它
                const activeCurrencies = new Set(cloudFlow.settings.currencies || [cloudFlow.settings.base]);
                if (!activeCurrencies.has(localBase)) {
                    activeCurrencies.add(localBase);
                    // 偵測到新幣別混入，自動開啟多幣種模式，以免使用者看不到選項
                    cloudFlow.settings.multiCurrency = true; 
                }
                cloudFlow.settings.currencies = Array.from(activeCurrencies);
            }
        });
    }
    
    appData = finalData;
    saveData(false); // 儲存到 LocalStorage
    getEl('syncOverlay')?.classList.add('hidden');
    updateFlowUI();
    
    // 重新整理畫面
    resetViewAroundDate(currentNavDate, 'auto');
    
    pendingLocalData = null;
    pendingCloudData = null;

    // 顯示成功訊息
    showSystemToast("Flows merged with currency tags.");
}

// --- Flow UI ---
function updateFlowUI() {
    const nameEl = getEl('currentFlowName');
    if (nameEl) nameEl.textContent = appData.flows[appData.currentFlowId]?.name || 'Flow';
    enableFlowNameEdit();
    renderFlowDropdown();
}

// [Update Function] renderFlowDropdown
function renderFlowDropdown() {
    const list = getEl('flowListContainer');
    const dropdown = getEl('flowDropdown');
    const toggleBtn = getEl('btnToggleEditFlow');
    
    if (!list) return;
    list.innerHTML = '';
    
    // Toggle class on container for CSS styling
    if (isFlowEditMode) {
        dropdown.classList.add('edit-mode');
        toggleBtn?.classList.add('active');
    } else {
        dropdown.classList.remove('edit-mode');
        toggleBtn?.classList.remove('active');
    }

    const flowIds = Object.keys(appData.flows);
    const canDelete = flowIds.length > 1;

    flowIds.forEach(flowId => {
        const flow = appData.flows[flowId];
        if (!flow) return;

        const item = document.createElement('div');
        item.className = 'flow-item';
        item.dataset.id = flowId;
        if (flowId === appData.currentFlowId) item.classList.add('active');

        // 1. Drag Handle (Visible in Edit Mode via CSS)
        const handle = document.createElement('span');
        handle.className = 'drag-handle';
        handle.innerHTML = '☰';

        // 2. Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'flow-item-name';
        nameSpan.textContent = flow.name;

        // 3. Delete Button (Visible in Edit Mode via CSS)
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-flow';
        deleteBtn.textContent = '✕';

        item.appendChild(handle);
        item.appendChild(nameSpan);
        item.appendChild(deleteBtn);

        // Events
        if (isFlowEditMode) {
            // Drag & Drop Logic
            item.draggable = true;
            item.classList.add('draggable');
            
            item.ondragstart = (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', flowId);
                item.classList.add('dragging');
            };

            item.ondragend = () => {
                item.classList.remove('dragging');
                document.querySelectorAll('.flow-item').forEach(i => i.classList.remove('drag-over'));
            };

            item.ondragover = (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                item.classList.add('drag-over');
            };

            item.ondragleave = () => {
                item.classList.remove('drag-over');
            };

            item.ondrop = (e) => {
                e.preventDefault();
                const sourceId = e.dataTransfer.getData('text/plain');
                const targetId = flowId;
                if (sourceId !== targetId) {
                    reorderFlows(sourceId, targetId);
                }
            };

            // In Edit Mode, clicking delete removes flow
            if (canDelete) {
                deleteBtn.onclick = (e) => {
                    e.stopPropagation();
                    confirmDeleteFlow(flowId);
                };
            } else {
                deleteBtn.style.display = 'none'; // Cannot delete last flow
            }

            // In Edit Mode, clicking row does nothing (or could focus rename if implemented)
            item.onclick = (e) => e.stopPropagation();

        } else {
            // Normal Mode: Click to switch flow
            item.onclick = () => {
                appData.currentFlowId = flowId;
                saveData();
                closeFlowDropdown();
                updateFlowUI();
                resetViewAroundDate(currentNavDate, 'auto');
            };
        }

        list.appendChild(item);
    });
}

// [New Helper] Reorder Flows
function reorderFlows(sourceId, targetId) {
    const keys = Object.keys(appData.flows);
    const sourceIndex = keys.indexOf(sourceId);
    const targetIndex = keys.indexOf(targetId);
    
    if (sourceIndex < 0 || targetIndex < 0) return;

    // Move key in array
    keys.splice(sourceIndex, 1);
    keys.splice(targetIndex, 0, sourceId);

    // Reconstruct object to preserve order
    const newFlows = {};
    keys.forEach(key => {
        newFlows[key] = appData.flows[key];
    });

    appData.flows = newFlows;
    saveData();
    renderFlowDropdown(); // Re-render list
}

// [New Helper] Close Dropdown & Reset State
function closeFlowDropdown() {
    const dropdown = getEl('flowDropdown');
    const arrow = getEl('flowDropdownArrow');
    
    dropdown?.classList.add('hidden');
    arrow?.classList.remove('rotated'); // Reset arrow
    
    // Reset Edit Mode when closed
    isFlowEditMode = false;
    renderFlowDropdown(); 
}

// [New Helper] Confirm Delete (Extracted)
function confirmDeleteFlow(flowId) {
    flowToDeleteId = flowId;
    const flow = appData.flows[flowId];
    const overlay = getEl('flowDeleteOverlay');
    const msg = getEl('deleteFlowMsg');
    
    if (overlay && msg) {
        msg.innerHTML = `Delete flow "<b>${flow.name}</b>"?<br><span style="font-size:0.8rem; color:#666;">All transactions in this flow will be lost.</span>`;
        overlay.classList.remove('hidden');
        closeFlowDropdown();
    }
}

// --- Rendering System (Dual View) ---
function resetViewAroundDate(centerDate, behavior = 'smooth') {
    updateNavDisplay(centerDate);
    if (currentViewMode === 'timeline') {
        if (!planningList) return;
        planningList.innerHTML = '';
        const startDate = new Date(centerDate);
        startDate.setDate(centerDate.getDate() - PAST_BUFFER_DAYS);
        if (startDate < PROJECT_START_DATE) startDate.setTime(PROJECT_START_DATE.getTime());
        const totalDays = PAST_BUFFER_DAYS + FUTURE_BUFFER_DAYS;
        const fragment = createDayBatch(startDate, totalDays);
        planningList.appendChild(fragment);
        loadedStartDate = new Date(startDate);
        loadedEndDate = new Date(startDate);
        loadedEndDate.setDate(startDate.getDate() + totalDays);
        isNavigating = true;
        setTimeout(() => {
            scrollToDate(centerDate, behavior);
            setTimeout(() => { isNavigating = false; }, 100);
        }, 50);
    } else {
        renderMainCalendarGrid();
    }
}

function syncViewStateClasses() {
    document.body.classList.toggle('calendar-view-active', currentViewMode === 'calendar');
}

function toggleView() {
    const btn = getEl('btnToggleView');
    const calHeader = getEl('calendarHeader');
    if (currentViewMode === 'timeline') {
        currentViewMode = 'calendar';
        btn.innerHTML = ICON_LIST_SVG;
        listViewWrapper.classList.add('hidden');
        listHeader.classList.add('hidden');
        if (calHeader) calHeader.classList.remove('hidden');
        calendarViewContainer.classList.remove('hidden');
        closeFooterEditor();
        renderMainCalendarGrid();
        if (timelineContainer) timelineContainer.scrollTop = 0;
    } else {
        const hasSelectedDate = selectedCalendarDateStr !== null;
        const targetDateStr = selectedCalendarDateStr;
        currentViewMode = 'timeline';
        btn.innerHTML = ICON_CAL_SVG;
        listViewWrapper.classList.remove('hidden');
        listHeader.classList.remove('hidden');
        if (calHeader) calHeader.classList.add('hidden');
        calendarViewContainer.classList.add('hidden');
        closeFooterEditor();
        if (hasSelectedDate && targetDateStr) {
            jumpToDateContext(targetDateStr);
        } else {
            resetViewAroundDate(currentNavDate, 'auto');
        }
    }
    syncViewStateClasses();
}

// --- Timeline Logic ---
function createDayBatch(startDate, daysCount) {
    const fragment = document.createDocumentFragment();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const flowSettings = getFlowSettings();
    const viewCur = flowSettings.base || DEFAULT_FLOW_SETTINGS.base;
    
    // [新增] 取得多幣種開關狀態
    const multiCurrencyEnabled = !!flowSettings.multiCurrency;
    // [修改] 只有開啟時才顯示幣別 HTML
    const currencyHtml = multiCurrencyEnabled ? ` <small>${viewCur}</small>` : '';

    for (let i = 0; i < daysCount; i++) {
        const d = new Date(startDate); d.setDate(startDate.getDate() + i);
        const dateStr = formatDate(d);
        const { totalIncome, totalExpense, notes } = getDaySummary(dateStr, true);
        const wrapper = document.createElement('div');
        wrapper.className = 'row-wrapper';
        wrapper.dataset.date = dateStr;
        if (d.getTime() === today.getTime()) wrapper.classList.add('today');
        if (d < today) wrapper.classList.add('past');
        if (d.getDay() === 0 || d.getDay() === 6) wrapper.classList.add('weekend');
        const row = document.createElement('div');
        row.className = 'planning-row grid-layout';
        
        // [修改] 使用變數 currencyHtml
        const incStr = totalIncome > 0 ? `+${formatCompactNumber(totalIncome)}${currencyHtml}` : '';
        const expStr = totalExpense > 0 ? `-${formatCompactNumber(totalExpense)}${currencyHtml}` : '';
        
        row.innerHTML = `
            <div class="row-date"><span class="date-day">${d.getDate()}</span><span class="date-weekday">${getWeekday(d)}</span></div>
            <div class="row-sum sum-income">${incStr}</div>
            <div class="row-sum sum-expense">${expStr}</div>
            <div class="row-note-preview">${notes.join(', ')}</div>
            <div></div>
        `;
        row.onclick = () => {
            wrapper.classList.toggle('expanded');
            if (wrapper.classList.contains('expanded')) renderInlineDetails(wrapper, dateStr);
        };
        const details = document.createElement('div');
        details.className = 'row-details';
        details.innerHTML = `<div class="detail-list"></div>`;
        wrapper.appendChild(row);
        wrapper.appendChild(details);
        fragment.appendChild(wrapper);
    }
    return fragment;
}

function renderInlineDetails(wrapper, dateStr) {
    const list = wrapper.querySelector('.detail-list');
    const { items } = getDaySummary(dateStr, false); 
    const flowSettings = getFlowSettings();
    // [重要] 這裡強制重新確認一次開關狀態，避免讀到舊變數
    const multiCurrencyEnabled = !!flowSettings.multiCurrency; 
    
    list.innerHTML = '';
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'detail-item grid-layout';
        
        // 取得幣別，若無則顯示當前 Base
        const iCur = (item.incCurrency || flowSettings.base).toUpperCase();
        const eCur = (item.expCurrency || flowSettings.base).toUpperCase();
        
        // [強制樣式] 使用 tx-currency-tag
        const iCurHtml = multiCurrencyEnabled ? `<span class="tx-currency-tag">${iCur}</span>` : '';
        const eCurHtml = multiCurrencyEnabled ? `<span class="tx-currency-tag">${eCur}</span>` : '';

        const incTxt = item.income > 0 ? `+${formatCompactNumber(item.income)}${iCurHtml}` : '';
        const expTxt = item.expense > 0 ? `-${formatCompactNumber(item.expense)}${eCurHtml}` : '';
        
        div.innerHTML = `
            <div class="detail-spacer"></div>
            <div class="d-col income">${incTxt}</div>
            <div class="d-col expense">${expTxt}</div>
            <div class="d-col note">${item.note || ''}</div>
            <div class="d-del">×</div>
        `;
        div.querySelector('.d-del').onclick = (e) => {
            e.stopPropagation();
            deleteTransaction(item.id, dateStr, wrapper);
        };
        list.appendChild(div);
    });

    if (!wrapper.querySelector('.quick-input')) {
        // ... (Input 生成部分保持原本代碼即可，不需要更動) ...
        const inputRow = document.createElement('div');
        inputRow.className = 'quick-input grid-layout';
        
        const genDropdownHtml = (id, currentVal) => {
            if (!multiCurrencyEnabled) return '';
            const optionsHtml = getActiveCurrencyList(flowSettings).map(c => 
                `<div class="custom-option" data-value="${c}">${c}</div>`
            ).join('');
            
            return `
                <div id="${id}" class="custom-select-wrapper mini">
                    <div class="custom-select-trigger"><span>${currentVal}</span></div>
                    <div class="custom-select-options hidden">${optionsHtml}</div>
                </div>`;
        };

        const base = flowSettings.base;
        const incDropdown = genDropdownHtml(`dd-inc-${dateStr}`, base);
        const expDropdown = genDropdownHtml(`dd-exp-${dateStr}`, base);
        
        const incWrapperClass = multiCurrencyEnabled ? 'input-with-currency' : 'single-currency-wrapper';
        const expWrapperClass = multiCurrencyEnabled ? 'input-with-currency' : 'single-currency-wrapper';

        inputRow.innerHTML = `
            <div class="detail-spacer"></div>
            <div class="${incWrapperClass}">
                <input type="number" class="quick-input-field inc" id="inc-${dateStr}" placeholder="Inc">
                ${incDropdown}
            </div>
            <div class="${expWrapperClass}">
                <input type="number" class="quick-input-field exp" id="exp-${dateStr}" placeholder="Exp">
                ${expDropdown}
            </div>
            <input type="text" class="quick-input-field note" id="note-${dateStr}" placeholder="Note">
            <button class="btn-quick-add">+</button>
        `;

        if (multiCurrencyEnabled) {
            setTimeout(() => {
                setupCustomDropdown(`dd-inc-${dateStr}`);
                setupCustomDropdown(`dd-exp-${dateStr}`);
            }, 0);
        }
        
        inputRow.querySelector('.btn-quick-add').onclick = (e) => {
            e.stopPropagation();
            addTransactionUnified(dateStr, 'timeline', wrapper);
        };
        inputRow.querySelectorAll('input').forEach(inp => {
             if (inp.type === 'number') {
                inp.oninput = (e) => { 
                    if (e.target.value && e.target.value < 0) e.target.value = 0; 
                };
            }
            inp.onkeydown = (e) => {
                if (e.key === 'Enter') addTransactionUnified(dateStr, 'timeline', wrapper);
            };
        });
        wrapper.querySelector('.row-details').appendChild(inputRow);
    }
}

// --- Calendar View Logic ---
function renderMainCalendarGrid() {
    const grid = getEl('mainCalendarGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const y = currentNavDate.getFullYear();
    const m = currentNavDate.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const firstDayOfMonth = new Date(y, m, 1);
    const startDayOfWeek = firstDayOfMonth.getDay();
    const totalWeeks = Math.ceil((startDayOfWeek + daysInMonth) / 7);
    const totalCells = totalWeeks * 7;
    const startDate = new Date(firstDayOfMonth);
    startDate.setDate(1 - startDayOfWeek);
    const todayStr = formatDate(new Date());
    for (let i = 0; i < totalCells; i++) {
        const d = new Date(startDate);
        d.setDate(startDate.getDate() + i);
        const dateStr = formatDate(d);
        const cell = document.createElement('div');
        cell.className = 'main-cal-cell';
        cell.dataset.date = dateStr;
        if (dateStr === todayStr) cell.classList.add('today');
        if (d.getMonth() !== m) cell.classList.add('other-month');
        if (selectedCalendarDateStr === dateStr) cell.classList.add('selected');
        const chipsHtml = generateCalendarChips(dateStr);
        const mobileDotsHtml = generateMobileDots(dateStr);
        cell.innerHTML = `
            <div class="m-day">${d.getDate()}</div>
            <div class="m-data">
                ${chipsHtml}
                ${mobileDotsHtml}
            </div>
        `;
        cell.onclick = () => {
            document.querySelectorAll('.main-cal-cell').forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');
            selectedCalendarDateStr = dateStr;
            openFooterEditor(dateStr);
        };
        grid.appendChild(cell);
    }
}

function refreshCalendarCell(dateStr) {
    const cell = document.querySelector(`.main-cal-cell[data-date="${dateStr}"]`);
    if (!cell) return;
    const d = new Date(dateStr);
    const chipsHtml = generateCalendarChips(dateStr);
    const mobileDotsHtml = generateMobileDots(dateStr);
    cell.innerHTML = `
        <div class="m-day">${d.getDate()}</div>
        <div class="m-data">
            ${chipsHtml}
            ${mobileDotsHtml}
        </div>
    `;
}

function generateMobileDots(dateStr) {
    const { items } = getDaySummary(dateStr);
    if (items.length === 0) return '';
    let dotsHtml = '';
    items.forEach(item => {
        const inc = item.income || 0;
        const exp = item.expense || 0;
        const hasNote = item.note && item.note.trim().length > 0;
        let dotClass = '';
        let isNeutral = false;
        if (inc > 0) {
            dotClass = 'dot-inc';
        } else if (exp > 0) {
            dotClass = 'dot-exp';
        } else {
            dotClass = 'dot-neutral';
            isNeutral = true;
        }
        if (!isNeutral && hasNote) {
            dotClass += ' dot-bordered';
        }
        dotsHtml += `<div class="mobile-day-dot ${dotClass}"></div>`;
    });
    return dotsHtml;
}

function generateCalendarChips(dateStr) {
    const { items } = getDaySummary(dateStr);
    
    // [新增] 取得設定
    const flowSettings = getFlowSettings();
    const multiCurrencyEnabled = !!flowSettings.multiCurrency;
    const baseCur = flowSettings.base;

    let chipsHtml = '';
    if (items.length > 0) {
        items.forEach(item => {
            const inc = item.income || 0;
            const exp = item.expense || 0;
            const note = item.note ? item.note.trim() : '';
            const hasNote = note.length > 0;
            
            // [新增] 準備極簡幣別標籤 (僅在開啟多幣種時顯示)
            // 這裡直接取用交易本身的幣別，若無則用 Base
            const iTxCur = (item.incCurrency || baseCur).toUpperCase();
            const eTxCur = (item.expCurrency || baseCur).toUpperCase();

            const iCurHtml = multiCurrencyEnabled ? `<span class="cal-currency-tag">${iTxCur}</span>` : '';
            const eCurHtml = multiCurrencyEnabled ? `<span class="cal-currency-tag">${eTxCur}</span>` : '';

            let stateClass = 's-note';
            if (inc > 0 && exp > 0 && hasNote) stateClass = 's-tri';
            else if (inc > 0 && exp > 0) stateClass = 's-inc-exp';
            else if (inc > 0 && hasNote) stateClass = 's-inc-note';
            else if (exp > 0 && hasNote) stateClass = 's-exp-note';
            else if (inc > 0) stateClass = 's-inc';
            else if (exp > 0) stateClass = 's-exp';
            
            let valHtml = '';
            // [修改] 將 iCurHtml / eCurHtml 插入顯示
            if (inc > 0) valHtml += `<span class="c-inc">+$${formatCompactNumber(inc)}${iCurHtml}</span>`;
            
            // 如果同時有收入與支出，加一個空格避免太擠
            if (inc > 0 && exp > 0) valHtml += ' '; 

            if (exp > 0) valHtml += `<span class="c-exp">-$${formatCompactNumber(exp)}${eCurHtml}</span>`;
            
            chipsHtml += `
                <div class="m-chip ${stateClass}">
                    <span class="v-wrap">${valHtml}</span>
                    <span class="n-text">${note}</span>
                </div>
            `;
        });
    }
    return chipsHtml;
}

function openFooterEditor(dateStr) {
    forecastContainer.classList.add('hidden');
    footerDayEditor.classList.remove('hidden');
    getEl('editorDateLabel').textContent = dateStr;
    getEl('mainFooter').classList.add('editing');
    updateFooterEditor(dateStr);
}

function closeFooterEditor() {
    selectedCalendarDateStr = null;
    document.querySelectorAll('.main-cal-cell').forEach(c => c.classList.remove('selected'));
    forecastContainer.classList.remove('hidden');
    footerDayEditor.classList.add('hidden');
    getEl('mainFooter').classList.remove('editing');
}

function updateFooterEditor(dateStr) {
    if (!dateStr) return;
    const flowSettings = getFlowSettings();
    const multiCurrencyEnabled = !!flowSettings.multiCurrency;

    // ... (這部分 ensureFooterSelect 邏輯保持不變) ...
    const ensureFooterSelect = (inputId, type) => {
        const inputEl = getEl(inputId);
        if (!inputEl || !inputEl.parentNode) return null;
        
        let wrapper = inputEl.parentNode;
        if (!wrapper.classList.contains('input-with-currency')) {
            wrapper = document.createElement('div');
            wrapper.className = 'input-with-currency';
            inputEl.parentNode.insertBefore(wrapper, inputEl);
            wrapper.appendChild(inputEl);
            inputEl.classList.remove('mini-input'); 
        }

        const dropdownId = type === 'inc' ? 'footerDdInc' : 'footerDdExp';
        let dropdown = getEl(dropdownId);
        
        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.id = dropdownId;
            dropdown.className = 'custom-select-wrapper mini';
            dropdown.innerHTML = `
                <div class="custom-select-trigger"><span>${flowSettings.base}</span></div>
                <div class="custom-select-options hidden"></div>
            `;
            wrapper.appendChild(dropdown);
        }
        
        const optionsContainer = dropdown.querySelector('.custom-select-options');
        const activeList = getActiveCurrencyList(flowSettings);
        optionsContainer.innerHTML = activeList.map(c => 
            `<div class="custom-option" data-value="${c}">${c}</div>`
        ).join('');
        
        setupCustomDropdown(dropdownId);
        return dropdown;
    };

    const incSelect = ensureFooterSelect('footerInc', 'inc');
    const expSelect = ensureFooterSelect('footerExp', 'exp');
    
    if (incSelect) incSelect.classList.toggle('hidden', !multiCurrencyEnabled);
    if (expSelect) expSelect.classList.toggle('hidden', !multiCurrencyEnabled);

    const { items } = getDaySummary(dateStr);
    const list = getEl('editorTxList');
    list.innerHTML = '';
    items.forEach(item => {
        const inc = item.income || 0;
        const exp = item.expense || 0;
        const isNoteOnly = (inc === 0 && exp === 0);
        const chip = document.createElement('div');
        let chipClass = 'neutral';
        if (!isNoteOnly) {
            chipClass = (inc >= exp && inc > 0) ? 'inc' : 'exp';
        }
        chip.className = `mini-tx-chip ${chipClass}`;
        
        // [修改] 準備幣別字串
        const iCur = (item.incCurrency || flowSettings.base).toUpperCase();
        const eCur = (item.expCurrency || flowSettings.base).toUpperCase();
        const iCurHtml = multiCurrencyEnabled ? `<small style="font-size:0.7em; opacity:0.7; margin-left:2px;">${iCur}</small>` : '';
        const eCurHtml = multiCurrencyEnabled ? `<small style="font-size:0.7em; opacity:0.7; margin-left:2px;">${eCur}</small>` : '';

        let contentHtml = '';
        if (isNoteOnly) {
            contentHtml = `<span class="chip-note" style="max-width: 120px;">${item.note || 'Empty'}</span>`;
        } else {
            let valStr = '';
            // [修改] 將幣別 HTML 加入顯示字串
            if (inc > 0) valStr += `<span class="c-inc">+$${inc.toLocaleString()}${iCurHtml}</span> `;
            if (exp > 0) valStr += `<span class="c-exp">-$${exp.toLocaleString()}${eCurHtml}</span>`;
            contentHtml = `
                <span class="chip-val">${valStr}</span>
                <span class="chip-note">${item.note || ''}</span>
            `;
        }
        chip.innerHTML = `${contentHtml}<span class="chip-del">×</span>`;
        chip.querySelector('.chip-del').onclick = (e) => {
            e.stopPropagation();
            deleteTransaction(item.id, dateStr);
        };
        list.appendChild(chip);
    });
    
    // ... (這部分 Binding 按鈕邏輯保持不變) ...
    const btnAdd = getEl('footerBtnAdd');
    const newBtn = btnAdd.cloneNode(true);
    btnAdd.parentNode.replaceChild(newBtn, btnAdd);
    newBtn.onclick = () => addTransactionUnified(dateStr, 'footer');

    ['footerInc', 'footerExp', 'footerNote'].forEach(id => {
        const inp = getEl(id);
            if (inp) {
            if (inp.type === 'number') {
                inp.oninput = (e) => { 
                    if (e.target.value && e.target.value < 0) e.target.value = 0; 
                };
            }
            inp.onkeydown = (e) => { 
                if (e.key === 'Enter') addTransactionUnified(dateStr, 'footer'); 
            };
        }    
    });
}
        
// --- Unified Transaction Operations ---
function addTransactionUnified(dateStr, source, rowWrapper = null) {
    const flowSettings = getFlowSettings();
    const baseCurrency = (flowSettings && flowSettings.base) ? flowSettings.base : DEFAULT_FLOW_SETTINGS.base;
    const multiCurrencyEnabled = !!(flowSettings && flowSettings.multiCurrency);

    let inc, exp, note;
    if (source === 'footer') {
        inc = parseFloat(getEl('footerInc').value) || 0;
        exp = parseFloat(getEl('footerExp').value) || 0;
        note = getEl('footerNote').value.trim();
    } else {
        inc = parseFloat(document.getElementById(`inc-${dateStr}`).value) || 0;
        exp = parseFloat(document.getElementById(`exp-${dateStr}`).value) || 0;
        note = document.getElementById(`note-${dateStr}`).value.trim();
    }
    if (!inc && !exp && !note) return;
    const resolveCurrency = (elementId) => {
        // elementId 現在傳入的是 Wrapper ID (例如 'dd-inc-2025-01-01' 或 'footerDdInc')
        const wrapper = document.getElementById(elementId);
        if (!wrapper) return baseCurrency;
        
        // 嘗試讀取 span 文字 (自定義選單)
        const span = wrapper.querySelector('.custom-select-trigger span');
        if (span) return span.textContent.trim();
        
        // Fallback (如果找不到)
        return baseCurrency;
    };

    // 修改呼叫參數，傳入新的 Wrapper ID
    if (multiCurrencyEnabled) {
        const incId = source === 'footer' ? 'footerDdInc' : `dd-inc-${dateStr}`;
        const expId = source === 'footer' ? 'footerDdExp' : `dd-exp-${dateStr}`;
        incCurrency = resolveCurrency(incId);
        expCurrency = resolveCurrency(expId);
    }
    const newTx = { id: `tx_${Date.now()}_${Math.floor(Math.random() * 1000)}`, date: dateStr, income: inc, expense: exp, note: note, createdAt: Date.now() };
    if (multiCurrencyEnabled) {
        newTx.incCurrency = incCurrency;
        newTx.expCurrency = expCurrency;
    }
    const transactions = getCurrentTransactions();
    transactions.push(newTx);
    setCurrentTransactions(transactions);
    if (source === 'footer') {
        getEl('footerInc').value = ''; getEl('footerExp').value = ''; getEl('footerNote').value = '';
        updateFooterEditor(dateStr);
        refreshCalendarCell(dateStr);
    } else {
        document.getElementById(`inc-${dateStr}`).value = '';
        document.getElementById(`exp-${dateStr}`).value = '';
        document.getElementById(`note-${dateStr}`).value = '';
        const targetWrapper = rowWrapper || document.querySelector(`.row-wrapper[data-date="${dateStr}"]`);
        refreshRowDisplay(targetWrapper, dateStr);
    }
}

function deleteTransaction(txId, dateStr, rowWrapper = null) {
    const transactions = getCurrentTransactions();
    const txIndex = transactions.findIndex(x => x.id === txId);
    if (txIndex === -1) return;
    const tx = transactions[txIndex];
    const newTransactions = transactions.filter(x => x.id !== txId);
    setCurrentTransactions(newTransactions);
    if (currentViewMode === 'timeline') {
        if (rowWrapper) refreshRowDisplay(rowWrapper, dateStr);
        else refreshRowDisplay(document.querySelector(`.row-wrapper[data-date="${dateStr}"]`), dateStr);
    } else {
        updateFooterEditor(dateStr);
        if (typeof refreshCalendarCell === 'function') {
            refreshCalendarCell(dateStr);
        } else {
            renderMainCalendarGrid();
        }
    }
    showUndoToast({ type: 'tx', tx, dateStr }, 'Transaction deleted');
}

function showUndoToast(dataObj, messageText = 'Transaction deleted') {
    const toast = getEl('undoToast');
    const text = getEl('undoText');
    if (undoTimeout) clearTimeout(undoTimeout);
    if (undoFadeTimeout) clearTimeout(undoFadeTimeout);
    if (dataObj?.tx && dataObj?.dateStr && !dataObj.type) {
        undoData = { type: 'tx', ...dataObj };
    } else {
        undoData = dataObj;
    }
    if (!undoData?.type) {
        undoData = { type: 'tx', tx: dataObj, dateStr: dataObj?.dateStr };
    }
    text.textContent = messageText;
    toast.classList.remove('hidden');
    toast.classList.remove('fading-out');
    toast.onclick = (e) => {
        if (e.target.id === 'btnUndo' || e.target.closest('#btnUndo')) return;
        toast.classList.add('hidden');
        undoData = null;
        if (undoTimeout) {
            clearTimeout(undoTimeout);
            undoTimeout = null;
        }
        if (undoFadeTimeout) {
            clearTimeout(undoFadeTimeout);
            undoFadeTimeout = null;
        }
    };
    undoFadeTimeout = setTimeout(() => {
        toast.classList.add('fading-out');
    }, 6000);
    undoTimeout = setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('fading-out');
        undoData = null;
    }, 8000);
}

function performUndo() {
    if (!undoData) return;
    
    if (undoData.type === 'flow') {
        const { id, data, index } = undoData;
        if (id && data) {
            // [Logic Fix] Restore flow at original index
            const currentKeys = Object.keys(appData.flows);
            
            // Insert key back at the specific index
            if (typeof index === 'number' && index >= 0 && index <= currentKeys.length) {
                currentKeys.splice(index, 0, id);
            } else {
                currentKeys.push(id); // Fallback to end
            }

            // Reconstruct object in order
            const newFlows = {};
            currentKeys.forEach(key => {
                if (key === id) {
                    newFlows[key] = data;
                } else {
                    newFlows[key] = appData.flows[key];
                }
            });

            appData.flows = newFlows;
            appData.currentFlowId = id; // Switch back to restored flow
            saveData();
            updateFlowUI();
            resetViewAroundDate(currentNavDate, 'auto');
        }
    } else if (undoData.type === 'batch') {
        // Batch Undo
        const { txs } = undoData;
        const currentTxs = getCurrentTransactions();
        // Re-add all deleted transactions
        txs.forEach(tx => currentTxs.push(tx));
        setCurrentTransactions(currentTxs);
        
        // Refresh View
        if (currentViewMode === 'timeline') {
            resetViewAroundDate(currentNavDate, 'auto');
        } else {
            renderMainCalendarGrid();
        }
    } else {
        const tx = undoData.tx || undoData;
        const dateStr = undoData.dateStr;
        const transactions = getCurrentTransactions();
        transactions.push(tx);
        setCurrentTransactions(transactions);
        if (currentViewMode === 'timeline') {
            refreshRowDisplay(document.querySelector(`.row-wrapper[data-date="${dateStr}"]`), dateStr);
        } else {
            updateFooterEditor(dateStr);
            if (typeof refreshCalendarCell === 'function') {
                refreshCalendarCell(dateStr);
            } else {
                renderMainCalendarGrid();
            }
        }
    }
    getEl('undoToast').classList.add('hidden');
    undoData = null;
    if (undoTimeout) clearTimeout(undoTimeout);
    if (undoFadeTimeout) clearTimeout(undoFadeTimeout);
}

function refreshRowDisplay(wrapper, dateStr) {
    if (!wrapper) return;
    const { totalIncome, totalExpense, notes } = getDaySummary(dateStr);
    wrapper.querySelector('.sum-income').textContent = totalIncome > 0 ? `+$${totalIncome.toLocaleString()}` : '';
    wrapper.querySelector('.sum-expense').textContent = totalExpense > 0 ? `-$${totalExpense.toLocaleString()}` : '';
    wrapper.querySelector('.row-note-preview').textContent = notes.join(', ');
    renderInlineDetails(wrapper, dateStr);
    updateTotalForecast();
}

function getDaySummary(dateStr, convert = false, targetCurrency = null) {
    const items = getCurrentTransactions().filter(t => t.date === dateStr);
    const flowSettings = getFlowSettings();
    const baseCurrency = targetCurrency || flowSettings.base || DEFAULT_FLOW_SETTINGS.base;
    
    let totalIncome = 0, totalExpense = 0, notes = [];

    items.forEach(t => {
        // 1. 確保幣別代碼為大寫 (處理舊資料 'tw' -> 'TWD')
        const tIncCur = (t.incCurrency || t.currency || baseCurrency).toUpperCase();
        const tExpCur = (t.expCurrency || t.currency || baseCurrency).toUpperCase();
        
        const inc = parseFloat(t.income) || 0;
        const exp = parseFloat(t.expense) || 0;

        // 2. 累加邏輯
        if (convert) {
            // 如果需要換算 (用於 Summary)，強制轉成 Base Currency
            // [Fix] 這裡原本直接加總，現在改為先換算
            totalIncome += convertCurrency(inc, tIncCur, baseCurrency);
            totalExpense += convertCurrency(exp, tExpCur, baseCurrency);
        } else {
            // 如果不需要換算 (用於原始資料讀取)，直接加總 (雖然意義不大，但保留行為)
            totalIncome += inc;
            totalExpense += exp;
        }
        
        if (t.note) notes.push(t.note);
    });
    
    return { totalIncome, totalExpense, notes, items };
}

function updateTotalForecast() {
    let totalInc = 0, totalExp = 0;
    const trans = getCurrentTransactions();
    const desc = getEl('summaryLabel');
    const incEl = getEl('summaryIncome');
    const expEl = getEl('summaryExpense');
    const balEl = getEl('summaryBalance');
    if (!incEl || !expEl || !balEl) return;

    const settings = getFlowSettings();
    const viewCurrency = settings.base || DEFAULT_FLOW_SETTINGS.base;

    const badge = getEl('viewCurrencyBadge');
    if (badge) {
        if (settings.multiCurrency) {
            badge.textContent = viewCurrency;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }

    const convertToView = (amount, currency) => {
        const val = parseFloat(amount) || 0;
        if (val === 0) return 0;
        const txCur = currency || viewCurrency;
        const converted = convertCurrency(val, txCur, viewCurrency);
        return typeof converted === 'number' && !Number.isNaN(converted) ? converted : val;
    };

    let filteredTrans = trans;
    if (summaryMode === 'current') {
        const limitDateStr = getVisibleBottomDate();
        if (limitDateStr) {
            filteredTrans = trans.filter(t => t.date <= limitDateStr);
            if (desc) desc.textContent = `RUNNING (Till ${limitDateStr})`;
        }
    } else if (summaryMode === 'custom') {
        const start = normalizeToStartOfDay(pickerStartDate).getTime();
        const end = normalizeToEndOfDay(pickerEndDate).getTime();
        filteredTrans = trans.filter(t => {
            const ts = new Date(t.date).getTime();
            return ts >= start && ts <= end;
        });
        if (desc) {
            const sStr = formatDate(pickerStartDate);
            const eStr = formatDate(pickerEndDate);
            const editIcon = `<svg class="edit-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
            desc.innerHTML = `${sStr} ~ ${eStr} ${editIcon}`;
        }
    } else if (desc && summaryMode === 'total') {
        desc.textContent = 'TOTAL FORECAST';
    }

    filteredTrans.forEach(t => {
        if (t.income) {
            const tIncCur = t.incCurrency || t.currency || viewCurrency;
            totalInc += convertToView(t.income, tIncCur);
        }
        if (t.expense) {
            const tExpCur = t.expCurrency || t.currency || viewCurrency;
            totalExp += convertToView(t.expense, tExpCur);
        }
    });

    const balance = totalInc - totalExp;
    incEl.textContent = formatCompactNumber(totalInc);
    expEl.textContent = formatCompactNumber(totalExp);
    balEl.textContent = formatCompactNumber(balance);
}

// --- User Profile & Data Management ---
function openUserProfile() {
    const overlay = getEl('userProfileOverlay');
    overlay.classList.remove('hidden');
    if (currentUser) {
        getEl('profileAvatar').src = currentUser.photoURL || '';
        getEl('profileName').textContent = currentUser.displayName || 'User';
        getEl('profileEmail').textContent = currentUser.email || '';
    } else {
        getEl('profileName').textContent = 'Guest User';
        getEl('profileEmail').textContent = 'Local Storage Only';
        getEl('profileAvatar').src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjY2NjIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIvPjxwYXRoIGQ9Ik0yMCAyMXYtMmE0IDQgMCAwIDAtNC00SDhhNCA0IDAgMCAwLTQgNHYyIi8+PC9zdmc+';
    }
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            overlay.classList.add('hidden');
        }
    };
    let grandTotalBalance = 0;
    let flowCount = 0;
    if (appData.flows) {
        const flowKeys = Object.keys(appData.flows);
        flowCount = flowKeys.length;
        flowKeys.forEach(key => {
            const flow = appData.flows[key];
            if (flow.transactions) {
                const flowBalance = flow.transactions.reduce((sum, tx) => {
                    const inc = parseFloat(tx.income) || 0;
                    const exp = parseFloat(tx.expense) || 0;
                    return sum + (inc - exp);
                }, 0);
                grandTotalBalance += flowBalance;
            }
        });
    }
    const elTotalBalance = getEl('statTotalBalance');
    const formattedBalance = Math.abs(grandTotalBalance).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2
    });
    elTotalBalance.textContent = (grandTotalBalance < 0 ? "-" : "+") + formattedBalance;
    if (grandTotalBalance > 0) {
        elTotalBalance.style.color = 'var(--income-color)';
    } else if (grandTotalBalance < 0) {
        elTotalBalance.style.color = 'var(--expense-color)';
    } else {
        elTotalBalance.style.color = '#333';
    }
    getEl('statFlowCount').textContent = flowCount;
    const btnExport = getEl('btnExportJson');
    const newExport = btnExport.cloneNode(true);
    btnExport.parentNode.replaceChild(newExport, btnExport);
    newExport.onclick = () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appData));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `flow_backup_${formatDate(new Date())}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    };
    const btnImport = getEl('btnImportJson');
    const fileInput = getEl('importFileInput');
    const newImport = btnImport.cloneNode(true);
    btnImport.parentNode.replaceChild(newImport, btnImport);
    newImport.onclick = () => fileInput.click();
    fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);
                if (importedData && importedData.flows) {
                    if (confirm(`Restore data from "${file.name}"? This will overwrite your current local view.`)) {
                        appData = importedData;
                        saveData();
                        alert('Restored successfully!');
                        location.reload();
                    }
                } else {
                    alert('Invalid file format.');
                }
            } catch (err) {
                console.error(err);
                alert('Error reading file.');
            }
        };
        reader.readAsText(file);
        e.target.value = ''; 
    };
    const btnLogout = getEl('btnLogout');
    const newLogout = btnLogout.cloneNode(true);
    btnLogout.parentNode.replaceChild(newLogout, btnLogout);
    newLogout.onclick = async () => {
        localStorage.removeItem(STORAGE_KEY);
        if (window.signOut && window.firebaseAuth) {
            try { 
                await window.signOut(window.firebaseAuth); 
            } catch (e) { console.error(e); }
        }
        location.reload(); 
    };
    getEl('btnProfileClose').onclick = () => overlay.classList.add('hidden');

    // Update version text dynamically
    const verEl = getEl('dispAppVersion');
    if (verEl && window.APP_VERSION) {
        verEl.textContent = `Personal Flow v${window.APP_VERSION}`;
    }
}

function setupPickerNavDropdown() {
    const label = getEl('pickerMonthsLabel');
    const dropdown = getEl('pickerDateDropdown');
    
    // 1. 點擊標題：切換選單顯示
    if (label) {
        label.onclick = (e) => {
            e.stopPropagation();
            if (dropdown.classList.contains('hidden')) {
                // 開啟時，同步年份狀態
                pickerDropdownYear = pickerBaseDate.getFullYear();
                renderPickerDropdownUI();
                dropdown.classList.remove('hidden');
            } else {
                dropdown.classList.add('hidden');
            }
        };
    }

    // 2. 年份切換
    getEl('pdBtnPrevYear').onclick = (e) => { 
        e.stopPropagation(); 
        pickerDropdownYear--; 
        renderPickerDropdownUI(); 
    };
    getEl('pdBtnNextYear').onclick = (e) => { 
        e.stopPropagation(); 
        pickerDropdownYear++; 
        renderPickerDropdownUI(); 
    };

    // 3. 月份點擊
    document.querySelectorAll('.p-month').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const selectedMonth = parseInt(item.dataset.m);
            
            // 更新 Picker 的基礎日期
            pickerBaseDate.setFullYear(pickerDropdownYear);
            pickerBaseDate.setMonth(selectedMonth);
            pickerBaseDate.setDate(1); // 回到該月1號
            
            // 重新渲染日曆網格
            renderDatePicker();
            
            // 關閉選單
            dropdown.classList.add('hidden');
        };
    });

    // 點擊外部關閉
    document.addEventListener('click', (e) => {
        if (dropdown && !dropdown.classList.contains('hidden')) {
            if (!dropdown.contains(e.target) && e.target !== label) {
                dropdown.classList.add('hidden');
            }
        }
    });
}

// 渲染 Picker 內部的 Dropdown UI (高亮當前月份)
function renderPickerDropdownUI() {
    getEl('pdYearDisplay').textContent = pickerDropdownYear;
    
    // 判斷當前 Picker 顯示的是哪一年哪一月
    const currentBaseYear = pickerBaseDate.getFullYear();
    const currentBaseMonth = pickerBaseDate.getMonth();

    document.querySelectorAll('.p-month').forEach(item => {
        const m = parseInt(item.dataset.m);
        if (pickerDropdownYear === currentBaseYear && m === currentBaseMonth) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

function setupAuth() {
    const { firebaseAuth, googleProvider, signInWithPopup, signOut, onAuthStateChanged } = window;
    const btnAuthAction = getEl('btnAuthAction'), overlay = getEl('loginOverlay');
    const iconUnauth = getEl('iconUnauth'), imgAuth = getEl('imgAuth');
    const btnGoogle = getEl('btnGoogleLogin'), btnClose = getEl('btnLoginClose');
    if (btnAuthAction) {
        btnAuthAction.onclick = () => {
            if (currentUser) openUserProfile();
            else overlay?.classList.remove('hidden');
        };
    }
    if (overlay) {
        overlay.onclick = (e) => {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        };
    }
    if (btnGoogle) btnGoogle.onclick = async () => { try { await signInWithPopup(firebaseAuth, googleProvider); overlay?.classList.add('hidden'); } catch (e) { alert(e.message); } };
    if (btnClose) btnClose.onclick = () => overlay?.classList.add('hidden');
    onAuthStateChanged(firebaseAuth, (u) => {
        currentUser = u;
        if (u) {
            if (iconUnauth) iconUnauth.classList.add('hidden');
            if (imgAuth) {
                imgAuth.classList.remove('hidden');
                imgAuth.src = u.photoURL || '';
                imgAuth.onerror = () => { imgAuth.classList.add('hidden'); iconUnauth.classList.remove('hidden'); };
            }
            loadCloudData(u.uid);
        } else {
            if (iconUnauth) iconUnauth.classList.remove('hidden');
            if (imgAuth) imgAuth.classList.add('hidden');
        }
    });
}

function setupUI() {
    const btnToggle = getEl('btnToggleMode'), label = getEl('modeLabel'), descLabel = getEl('summaryLabel');
    if (btnToggle) btnToggle.onclick = () => {
        if (summaryMode === 'total') {
            summaryMode = 'current'; if (label) label.textContent = 'RUNNING'; if (descLabel) descLabel.textContent = 'CURRENT BALANCE';
        } else if (summaryMode === 'current') {
            summaryMode = 'custom'; if (label) label.textContent = 'CUSTOM';
            const sStr = formatDate(pickerStartDate), eStr = formatDate(pickerEndDate);
            descLabel.innerHTML = `${sStr}<span class="range-sep"> → </span>${eStr}`;
        } else {
            summaryMode = 'total'; if (label) label.textContent = 'TOTAL'; if (descLabel) descLabel.textContent = 'TOTAL FORECAST';
        }
        updateTotalForecast();
    };
    if (descLabel) descLabel.onclick = () => { if (summaryMode === 'custom') openDateRangePicker(); };
    getEl('btnToggleView').onclick = toggleView;
    getEl('btnCloseEditor').onclick = closeFooterEditor;
    getEl('btnPrevMonth').onclick = () => jumpMonth(-1);
    getEl('btnNextMonth').onclick = () => jumpMonth(1);
    getEl('btnToday').onclick = () => {
        const today = new Date();
        currentNavDate = today;
        updateNavDisplay(today);
        if (currentViewMode === 'timeline') {
            resetViewAroundDate(today);
        } else {
            const dateStr = formatDate(today);
            selectedCalendarDateStr = dateStr;
            renderMainCalendarGrid();
            openFooterEditor(dateStr);
        }
    };
    getEl('btnPickerClose').onclick = () => dateRangeOverlay.classList.add('hidden');
    if (dateRangeOverlay) {
        dateRangeOverlay.onclick = (e) => {
            if (e.target === dateRangeOverlay) {
                dateRangeOverlay.classList.add('hidden');
            }
        };
    }
    getEl('btnCalPrev').onclick = () => { pickerBaseDate.setMonth(pickerBaseDate.getMonth() - 1); renderDatePicker(); };
    getEl('btnCalNext').onclick = () => { pickerBaseDate.setMonth(pickerBaseDate.getMonth() + 1); renderDatePicker(); };
    getEl('btnApplyRange').onclick = () => {
        if (pickerMode === 'range-recur') {
            // [Fix] Recurring 區間回填邏輯
            if (tempStart && tempEnd) {
                // 確保順序正確 (防呆)
                if (tempStart > tempEnd) {
                    const swap = tempStart; tempStart = tempEnd; tempEnd = swap;
                }
                
                const sStr = formatDate(tempStart);
                const eStr = formatDate(tempEnd);
                
                const elStart = getEl('recurStartDate');
                const elEnd = getEl('recurEndDate');
                
                if (elStart) elStart.value = sStr;
                if (elEnd) elEnd.value = eStr;
                
                // 觸發更新以計算預覽文字
                updateRecurSummary();
            }
            dateRangeOverlay.classList.add('hidden');

        } else if (pickerMode === 'single') {
            // 單選模式回填
            if (tempStart && pickerTargetInput) {
                pickerTargetInput.value = formatDate(tempStart);
                pickerTargetInput.dispatchEvent(new Event('input'));
            }
            dateRangeOverlay.classList.add('hidden');

        } else {
            // 一般 Filter Range 模式
            if (tempStart) {
                pickerStartDate = tempStart; 
                pickerEndDate = tempEnd ? tempEnd : tempStart;
                
                // 確保順序
                if (pickerStartDate > pickerEndDate) {
                    const swap = pickerStartDate; pickerStartDate = pickerEndDate; pickerEndDate = swap;
                }

                summaryMode = 'custom'; 
                if (getEl('modeLabel')) getEl('modeLabel').textContent = 'CUSTOM';
                dateRangeOverlay.classList.add('hidden'); 
                updateTotalForecast();
            }
        }
    };
    const btnFilter = getEl('btnOpenFilter'); if (btnFilter) btnFilter.onclick = () => { filterOverlay?.classList.remove('hidden'); renderFilterList(); };
    const btnFilterClose = getEl('btnFilterClose'); if (btnFilterClose) btnFilterClose.onclick = () => filterOverlay?.classList.add('hidden');
    const btnConfirmDel = getEl('btnConfirmDeleteFlow');
    const btnCancelDel = getEl('btnCancelDeleteFlow');
    const delOverlay = getEl('flowDeleteOverlay');
    if (btnConfirmDel) {
        btnConfirmDel.onclick = () => {
            if (flowToDeleteId && appData.flows[flowToDeleteId]) {
                const targetId = flowToDeleteId;
                const targetFlow = appData.flows[targetId];
                
                // [Logic Fix] Capture current index before deleting
                const flowKeys = Object.keys(appData.flows);
                const flowIndex = flowKeys.indexOf(targetId);

                delete appData.flows[targetId];

                if (appData.currentFlowId === targetId) {
                    const firstId = Object.keys(appData.flows)[0];
                    if (firstId) appData.currentFlowId = firstId;
                }
                saveData();
                updateFlowUI();
                resetViewAroundDate(currentNavDate, 'auto');
                
                // Pass index to Undo Toast
                showUndoToast({ type: 'flow', id: targetId, data: targetFlow, index: flowIndex }, 'Flow deleted');
            }
            delOverlay?.classList.add('hidden');
            flowToDeleteId = null;
        };
    }
    if (btnCancelDel) {
        btnCancelDel.onclick = () => {
            delOverlay?.classList.add('hidden');
            flowToDeleteId = null;
        };
    }
    if (delOverlay) {
        delOverlay.onclick = (e) => {
            if (e.target === delOverlay) {
                delOverlay.classList.add('hidden');
                flowToDeleteId = null;
            }
        };
    }
    const fInput = getEl('filterSearchInput');
    if (fInput) {
        fInput.oninput = (e) => {
            filterSearchText = e.target.value.trim();
            renderFilterList();
        };
    }
    document.querySelectorAll('.filter-chip').forEach(chip => {
        chip.onclick = () => {
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            filterType = chip.dataset.type;
            renderFilterList();
        };
    });

    document.body.onclick = (e) => {
        // Only close if clicking outside dropdown and not on the arrow
        const dropdown = getEl('flowDropdown');
        const arrow = getEl('flowDropdownArrow');
        if (dropdown && !dropdown.classList.contains('hidden')) {
            if (!dropdown.contains(e.target) && e.target !== arrow && !arrow.contains(e.target)) {
                closeFlowDropdown();
            }
        }
    };

    const btnAdd = getEl('btnAddFlow'); 
    if (btnAdd) btnAdd.onclick = () => { 
        // ... (原本新增 Flow 的邏輯) ...
        const id = 'f_' + Date.now(); 
        appData.flows[id] = { name: 'Untitled Flow', transactions: [] }; 
        appData.currentFlowId = id; 
        saveData(); 
        updateFlowUI(); 
        resetViewAroundDate(new Date(), 'auto'); 
        getEl('flowDropdown')?.classList.add('hidden'); 
        startEditingFlowName(); 
    };

    // ============================================================
    // ★★★ 請將這段「鉛筆按鈕」綁定程式碼貼在這裡 (btnAddFlow 之後) ★★★
    // ============================================================
    const btnEditFlow = getEl('btnToggleEditFlow');
    if (btnEditFlow) {
        btnEditFlow.onclick = (e) => {
            e.stopPropagation();
            isFlowEditMode = !isFlowEditMode; // 切換編輯模式狀態
            renderFlowDropdown();             // 重新渲染清單
        };
    }
    
    // Recurring UI Bindings
    const btnOpenRecurringFooter = getEl('btnOpenRecurringFooter');
    if (btnOpenRecurringFooter) {
        btnOpenRecurringFooter.onclick = () => {
            getEl('filterOverlay')?.classList.add('hidden');
            openRecurringOverlay();
        };
    }

    const btnRecurClose = getEl('btnRecurClose');
    if (btnRecurClose) {
        btnRecurClose.onclick = () => recurringOverlay?.classList.add('hidden');
    }
    if (recurringOverlay) {
        recurringOverlay.onclick = (e) => {
            if (e.target === recurringOverlay) {
                recurringOverlay.classList.add('hidden');
            }
        };
    }

    const incomeBtn = getEl('rtIncome');
    const expenseBtn = getEl('rtExpense');
    if (incomeBtn && expenseBtn) {
        incomeBtn.onclick = () => setRecurType('income');
        expenseBtn.onclick = () => setRecurType('expense');
    }

    document.querySelectorAll('.freq-tab-m').forEach(tab => {
        tab.onclick = () => {
            const nextFreq = tab.dataset.tab;
            setActiveFrequencyTab(nextFreq);
            recurFreq = nextFreq;
            updateRecurFormVisibility();
            updateRecurSummary();
        };
    });

    document.querySelectorAll('.day-circle').forEach(circle => {
        circle.onclick = () => {
            circle.classList.toggle('selected');
            const day = parseInt(circle.dataset.d, 10);
            if (recurSelectedDays.has(day)) {
                recurSelectedDays.delete(day);
            } else {
                recurSelectedDays.add(day);
            }
            updateRecurSummary();
        };
    });

    const btnAddMonth = getEl('btnAddMonthDay');
    if (btnAddMonth) {
        btnAddMonth.onclick = addMonthlyInput;
    }

    document.querySelectorAll('.m-day-slot').forEach(inp => {
        inp.oninput = (e) => {
            validateDayInput(e.target);
            updateRecurSummary();
        };
    });

    checkAddButtonVisibility();
    ['recurAmount', 'recurNote', 'recurStartDate', 'recurEndDate', 'recurCurrency'].forEach(id => {
        const field = getEl(id);
        if (field) {
            field.oninput = (e) => {
                // [New] Prevent negative numbers specifically for recurAmount
                if (id === 'recurAmount' && field.value && parseFloat(field.value) < 0) {
                    field.value = 0;
                }
                updateRecurSummary();
            };
            field.onchange = updateRecurSummary;
        }
    });

    
    const btnRecurConfirm = getEl('btnRecurConfirm');
    if (btnRecurConfirm) btnRecurConfirm.onclick = executeRecurringAdd;

    setupFlowSettingsUI();
    const currencyBadge = getEl('viewCurrencyBadge');
    if (currencyBadge) {
        currencyBadge.onclick = (e) => {
            e.stopPropagation();
            cycleViewCurrency();
        };
    }
    setupNavDropdown(); 
    const btnUndo = getEl('btnUndo');
    if (btnUndo) btnUndo.onclick = performUndo;
    setupAuth();

    setupPickerNavDropdown();

    // [Fix] Recurring 日期改為「區間選擇」模式
    const rStart = getEl('recurStartDate');
    const rEnd = getEl('recurEndDate');
    
    // 定義一個開啟 Recurring 專用區間選擇器的函式
    const openRecurRangePicker = () => openDateRangePicker('range-recur');

    if (rStart) {
        // 傳入 'start' 參數
        rStart.onclick = () => openDateRangePicker('range-recur', null, 'start');
        rStart.readOnly = true; 
    }
    if (rEnd) {
        // 傳入 'end' 參數，讓日曆一打開就顯示結束日期的月份
        rEnd.onclick = () => openDateRangePicker('range-recur', null, 'end');
        rEnd.readOnly = true;
    }
    
    // 同時修改原本 summaryLabel 的呼叫方式，明確傳入 'range'
    if (descLabel) descLabel.onclick = () => { 
        if (summaryMode === 'custom') openDateRangePicker('range'); 
    };
}

// --- Utilities & Infinite Scroll ---
function setupScrollListener() {
    if (!timelineContainer) return;
    setupInfiniteScroll();
    timelineContainer.onscroll = () => {
        handleScroll();
        const st = timelineContainer.scrollTop;
        const tools = document.querySelector('.nav-layer-tools');
        if (tools && Math.abs(st - lastScrollTop) > 20) {
            if (st > lastScrollTop && st > 50) tools.classList.remove('show-tools');
            else if (st < lastScrollTop) tools.classList.add('show-tools');
            lastScrollTop = st;
        }
        if (snapTimeout) clearTimeout(snapTimeout);
        snapTimeout = setTimeout(() => {
            if (isLoading || isNavigating) return;
            const rect = timelineContainer.getBoundingClientRect();
            const topEl = document.elementFromPoint(rect.left + 50, rect.top + 10);
            if (topEl) {
                const row = topEl.closest('.row-wrapper');
                if (row) {
                    timelineContainer.scrollTo({
                        top: row.offsetTop,
                        behavior: 'smooth'
                    });
                }
            }
        }, 150);
    };
}

let snapTimeout = null;
let lastScrollTop = 0;

function setupInfiniteScroll() {
    if (!timelineContainer) return;
    const options = {
        root: timelineContainer,
        rootMargin: '1200px 0px',
        threshold: 0.01
    };
    const observer = new IntersectionObserver(entries => {
        entries.forEach(e => {
            if (e.isIntersecting && !isLoading && !isInitialRender) {
                if (e.target.id === 'bottomLoadingTrigger') {
                    loadMoreFuture();
                } else if (e.target.id === 'topLoadingTrigger') {
                    loadHistory();
                }
            }
        });
    }, options);
    if (getEl('bottomLoadingTrigger')) observer.observe(getEl('bottomLoadingTrigger'));
    if (getEl('topLoadingTrigger')) observer.observe(getEl('topLoadingTrigger'));
}

function loadMoreFuture() {
    isLoading = true;
    const fragment = createDayBatch(loadedEndDate, BATCH_SIZE);
    planningList.appendChild(fragment);
    loadedEndDate.setDate(loadedEndDate.getDate() + BATCH_SIZE);
    setTimeout(() => { isLoading = false; }, 100);
}

function loadHistory() {
    if (loadedStartDate <= PROJECT_START_DATE) return;
    isLoading = true;
    const oldH = timelineContainer.scrollHeight;
    const oldT = timelineContainer.scrollTop;
    const newStart = new Date(loadedStartDate);
    newStart.setDate(loadedStartDate.getDate() - BATCH_SIZE);
    if (newStart < PROJECT_START_DATE) newStart.setTime(PROJECT_START_DATE.getTime());
    const count = Math.ceil((loadedStartDate - newStart) / (1000 * 60 * 60 * 24));
    if (count <= 0) {
        isLoading = false;
        return;
    }
    const fragment = createDayBatch(newStart, count);
    planningList.insertBefore(fragment, planningList.firstChild);
    loadedStartDate = newStart;
    timelineContainer.scrollTop = oldT + (timelineContainer.scrollHeight - oldH);
    setTimeout(() => {
        isLoading = false;
    }, 50);
}

function handleScroll() {
    if (!timelineContainer || currentViewMode === 'calendar' || isNavigating) return;
    const rect = timelineContainer.getBoundingClientRect();
    const topEl = document.elementFromPoint(rect.left + 50, rect.top + 100);
    if (topEl?.closest('.row-wrapper')) {
        const d = new Date(topEl.closest('.row-wrapper').dataset.date);
        if (!isNaN(d.getTime()) && d.getMonth() !== currentNavDate.getMonth()) {
            updateNavDisplay(d);
        }
    }
    if (summaryMode === 'current') updateTotalForecast();
}

function getVisibleBottomDate() {
    const rows = Array.from(document.querySelectorAll('.row-wrapper'));
    if (!timelineContainer) return null;
    const rect = timelineContainer.getBoundingClientRect();
    const targetY = rect.bottom - 5;
    for (let i = rows.length - 1; i >= 0; i--) {
        const rRect = rows[i].getBoundingClientRect();
        if (rRect.top < targetY) return rows[i].dataset.date;
    }
    return null;
}

function renderFilterList() {
    const c = getEl('filterListContainer');
    if (!c) return;
    c.innerHTML = '';
    const flowSettings = getFlowSettings();
    const multiCurrencyEnabled = !!flowSettings.multiCurrency;
    const baseCur = flowSettings.base;
    let t = getCurrentTransactions();
    if (filterType !== 'all') {
        t = t.filter(x => {
            if (filterType === 'income') return (x.income || 0) > 0;
            if (filterType === 'expense') return (x.expense || 0) > 0;
            if (filterType === 'note') return x.note && x.note.trim().length > 0;
            return true;
        });
    }
    if (filterSearchText) {
        const lower = filterSearchText.toLowerCase();
        t = t.filter(x => {
            const noteMatch = (x.note || '').toLowerCase().includes(lower);
            const incMatch = (x.income || 0).toString().includes(lower);
            const expMatch = (x.expense || 0).toString().includes(lower);
            return noteMatch || incMatch || expMatch;
        });
    }
    t.sort((a, b) => new Date(a.date) - new Date(b.date));
    const groups = {};
    t.forEach(tx => {
        if (!groups[tx.date]) groups[tx.date] = [];
        groups[tx.date].push(tx);
    });
    let curYear = null;
    Object.keys(groups).sort((a, b) => new Date(a) - new Date(b)).forEach(dateStr => {
        const year = new Date(dateStr).getFullYear();
        if (year !== curYear) {
            curYear = year;
            const h = document.createElement('div');
            h.className = 'year-header';
            h.textContent = year;
            c.appendChild(h);
        }
        const groupDiv = document.createElement('div');
        groupDiv.className = 'filter-group';
        const dateHeader = document.createElement('div');
        dateHeader.className = 'filter-group-header';
        dateHeader.textContent = dateStr.slice(5);
        groupDiv.appendChild(dateHeader);
        groups[dateStr].forEach(i => {
            const row = document.createElement('div');
            row.className = 'filter-item-row';
            // [新增] 準備幣別標籤 HTML (使用 tx-currency-tag 樣式)
            const iTxCur = (i.incCurrency || baseCur).toUpperCase();
            const eTxCur = (i.expCurrency || baseCur).toUpperCase();
            
            const iCurHtml = multiCurrencyEnabled ? `<span class="tx-currency-tag">${iTxCur}</span>` : '';
            const eCurHtml = multiCurrencyEnabled ? `<span class="tx-currency-tag">${eTxCur}</span>` : '';

            // [修改] 將標籤加入金額字串
            const incStr = i.income > 0 ? `+$${formatCompactNumber(i.income)}${iCurHtml}` : '';
            const expStr = i.expense > 0 ? `-$${formatCompactNumber(i.expense)}${eCurHtml}` : '';
            row.innerHTML = `
                <div class="f-amt income">${incStr}</div>
                <div class="f-amt expense">${expStr}</div>
                <div class="f-note filter-note-col">${i.note || ''}</div>
                <div class="btn-jump-date" title="Jump to Edit">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
                    </svg>
                </div>
            `;
            row.querySelector('.btn-jump-date').onclick = (e) => {
                e.stopPropagation();
                jumpToDateContext(dateStr);
            };
            groupDiv.appendChild(row);
        });
        c.appendChild(groupDiv);
    });
}

function jumpToDateContext(dateStr) {
    const overlay = document.getElementById('filterOverlay');
    if (overlay) overlay.classList.add('hidden');
    const targetDate = new Date(dateStr);
    if (currentViewMode === 'timeline') {
        isNavigating = true;
        resetViewAroundDate(targetDate, 'auto');
        setTimeout(() => {
            const rowWrapper = document.querySelector(`.row-wrapper[data-date="${dateStr}"]`);
            if (rowWrapper) {
                const top = rowWrapper.offsetTop - 10;
                timelineContainer.scrollTo({ top: top, behavior: 'smooth' });
                if (!rowWrapper.classList.contains('expanded')) {
                    rowWrapper.classList.add('expanded');
                    renderInlineDetails(rowWrapper, dateStr);
                }
                rowWrapper.style.transition = 'background 0.5s';
                rowWrapper.style.backgroundColor = '#fffbeb';
                setTimeout(() => {
                    rowWrapper.style.backgroundColor = '';
                }, 1000);
            }
            isNavigating = false;
        }, 150);
    } else {
        currentNavDate = targetDate;
        updateNavDisplay(targetDate);
        renderMainCalendarGrid();
        selectedCalendarDateStr = dateStr;
        const cell = document.querySelector(`.main-cal-cell[data-date="${dateStr}"]`);
        if (cell) {
            document.querySelectorAll('.main-cal-cell').forEach(c => c.classList.remove('selected'));
            cell.classList.add('selected');
        }
        openFooterEditor(dateStr);
    }
}

// [修改] 增加 focusTarget 參數 ('start' 或 'end')
function openDateRangePicker(mode = 'range', targetInput = null, focusTarget = 'start') {
    pickerMode = mode; 
    pickerTargetInput = targetInput;
    
    const card = dateRangeOverlay.querySelector('.picker-card');
    if (card) card.classList.remove('single-mode');

    dateRangeOverlay.classList.remove('hidden');
    
    // 初始化日期邏輯
    if (pickerMode === 'range-recur') {
        const sVal = getEl('recurStartDate')?.value;
        const eVal = getEl('recurEndDate')?.value;
        
        const parse = (str) => {
            if (!str) return null;
            const parts = str.split('-');
            return parts.length === 3 ? new Date(parts[0], parts[1]-1, parts[2]) : null;
        };

        const existingStart = parse(sVal);
        const existingEnd = parse(eVal);

        tempStart = existingStart || new Date();
        tempEnd = existingEnd || new Date(tempStart);
        
        // [關鍵 UX] 根據點擊的是 Start 還是 End 輸入框，決定日曆預設顯示哪個月
        if (focusTarget === 'end' && existingEnd) {
            pickerBaseDate = new Date(existingEnd);
        } else {
            pickerBaseDate = new Date(tempStart);
        }
        pickerBaseDate.setDate(1); 

    } else if (pickerMode === 'single') {
        if (targetInput && targetInput.value) {
            const parts = targetInput.value.split('-');
            if (parts.length === 3) {
                tempStart = new Date(parts[0], parts[1] - 1, parts[2]);
            } else {
                tempStart = new Date();
            }
        } else {
            tempStart = new Date();
        }
        tempEnd = null;
        pickerBaseDate = new Date(tempStart);

    } else {
        // 一般 Filter Range
        tempStart = new Date(pickerStartDate);
        tempEnd = new Date(pickerEndDate);
        pickerBaseDate = new Date(pickerStartDate);
    }
    
    pickerHasInteracted = false;
    renderDatePicker();
}

function renderDatePicker() {
    const panes = [getEl('calLeft'), getEl('calRight')];
    [0, 1].forEach(offset => {
        const d = new Date(pickerBaseDate); d.setMonth(d.getMonth() + offset);
        const m = d.getMonth(), y = d.getFullYear();
        let html = `<div class="cal-head">${formatMonth(d)}</div><div class="cal-grid">`;
        const firstDay = new Date(y, m, 1).getDay();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        for (let i = 0; i < firstDay; i++) html += `<div class="cal-day empty"></div>`;
        for (let i = 1; i <= daysInMonth; i++) {
            const cd = new Date(y, m, i);
            const t = cd.getTime();
            let cls = 'cal-day';
            
            // Highlight Today
            if (t === new Date().setHours(0, 0, 0, 0)) cls += ' today';
            
            const sTime = tempStart ? tempStart.getTime() : 0;
            const eTime = tempEnd ? tempEnd.getTime() : 0;
            
            // [修改] 樣式邏輯：區分單選與區間
            if (pickerMode === 'single') {
                // 單選模式：只標記選中的那天為 range-start (借用黑色圓圈樣式)
                if (tempStart && t === sTime) cls += ' range-start range-end'; 
            } else {
                // 區間模式 (原邏輯)
                if (tempStart && t === sTime) cls += ' range-start';
                if (tempEnd && t === eTime) cls += ' range-end';
                if (tempStart && tempEnd && t > sTime && t < eTime) cls += ' in-range';
            }
            
            html += `<div class="${cls}" data-ts="${t}">${i}</div>`;
        }
        html += '</div>';
        panes[offset].innerHTML = html;
        
        panes[offset].querySelectorAll('.cal-day:not(.empty)').forEach(el => {
            el.onclick = () => {
                const ts = parseInt(el.dataset.ts);
                const clickDate = new Date(ts);
                
                // [修改] 點擊邏輯
                if (pickerMode === 'single') {
                    tempStart = clickDate;
                    tempEnd = null;
                    renderDatePicker(); // 刷新顯示
                    return;
                }

                // 區間模式 (原邏輯)
                if (!pickerHasInteracted) {
                    tempStart = clickDate;
                    tempEnd = null;
                    pickerHasInteracted = true;
                    renderDatePicker();
                    return;
                }
                const sTime = tempStart ? tempStart.getTime() : 0;
                const eTime = tempEnd ? tempEnd.getTime() : 0;
                if (tempStart && ts === sTime) {
                    if (tempEnd) { tempStart = tempEnd; tempEnd = null; } else { tempStart = null; }
                } else if (tempEnd && ts === eTime) {
                    tempEnd = null;
                } else {
                    if (!tempStart) { tempStart = clickDate; }
                    else if (tempEnd) { tempStart = clickDate; tempEnd = null; }
                    else {
                        if (clickDate < tempStart) { tempEnd = tempStart; tempStart = clickDate; }
                        else { tempEnd = clickDate; }
                    }
                }
                renderDatePicker();
            };
        });
    });
    
    getEl('pickerMonthsLabel').textContent = formatMonth(pickerBaseDate);
    
    // [UX Upgrade] 底部文字顯示與互動綁定
    const footerTextContainer = getEl('selectedRangeText');
    const sText = tempStart ? formatDate(tempStart) : 'Select date...';
    
    if (pickerMode === 'single') {
        // 單選模式
        footerTextContainer.innerHTML = `<span class="p-date" id="pDateStart">${sText}</span>`;
    } else {
        // 區間模式
        const eText = tempEnd ? formatDate(tempEnd) : (tempStart ? 'Select end (or Apply)' : '...');
        footerTextContainer.innerHTML = `
            <span class="p-date" id="pDateStart">${sText}</span>
            <span class="picker-arrow">→</span>
            <span class="p-date" id="pDateEnd">${eText}</span>
        `;
    }

    // [關鍵] 綁定點擊事件：點擊文字 -> 跳轉日曆至該月份
    const btnStart = getEl('pDateStart');
    const btnEnd = getEl('pDateEnd');

    if (btnStart && tempStart) {
        btnStart.onclick = (e) => {
            e.stopPropagation();
            pickerBaseDate = new Date(tempStart);
            pickerBaseDate.setDate(1);
            renderDatePicker();
        };
    }

    if (btnEnd && tempEnd) {
        btnEnd.onclick = (e) => {
            e.stopPropagation();
            pickerBaseDate = new Date(tempEnd);
            pickerBaseDate.setDate(1);
            renderDatePicker();
        };
    }
}

function jumpMonth(delta) {
    const targetDate = new Date(currentNavDate);
    targetDate.setMonth(targetDate.getMonth() + delta);
    targetDate.setDate(1);
    if (currentViewMode === 'calendar') {
        currentNavDate = targetDate;
        updateNavDisplay(targetDate);
        renderMainCalendarGrid();
        selectedCalendarDateStr = null; 
        document.querySelectorAll('.main-cal-cell').forEach(c => c.classList.remove('selected'));
        closeFooterEditor();
        return;
    }
    const safetyMargin = 7 * 24 * 60 * 60 * 1000;
    if (targetDate.getTime() > (loadedStartDate.getTime() + safetyMargin) &&
        targetDate.getTime() < (loadedEndDate.getTime() - safetyMargin)) {
        updateNavDisplay(targetDate);
        isNavigating = true; 
        scrollToDate(targetDate, 'smooth');
        setTimeout(() => { isNavigating = false; }, 500);
    } else {
        resetViewAroundDate(targetDate, 'auto');
    }
}

function updateNavDisplay(d) { const el = getEl('currentMonthDisplay'); if (el) { el.textContent = `${d.getFullYear()} / ${d.getMonth() + 1}`; currentNavDate = d; } }
function scrollToDate(d, behavior = 'smooth') {
    const s = formatDate(d);
    const r = document.querySelector(`.row-wrapper[data-date="${s}"]`);
    if (r && timelineContainer) {
        const top = r.offsetTop - 10;
        timelineContainer.scrollTo({ top: top, behavior: behavior });
    }
}
function formatDate(d) { const m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0'); return `${d.getFullYear()}-${m}-${day}`; }
function getWeekday(d) { return ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getDay()]; }
function normalizeToStartOfDay(d) { const n = new Date(d); n.setHours(0, 0, 0, 0); return n; }
function normalizeToEndOfDay(d) { const n = new Date(d); n.setHours(23, 59, 59, 999); return n; }
function formatMonth(d) { return `${d.getFullYear()} / ${String(d.getMonth() + 1).padStart(2, '0')}`; }

// [Update Function] enableFlowNameEdit (Modify the Arrow Click Logic)
function enableFlowNameEdit() {
    const nameSpan = getEl('currentFlowName');
    const nameInput = getEl('flowNameInput');
    const arrow = getEl('flowDropdownArrow');
    const saveBtn = getEl('btnFlowSave');
    
    if (!nameSpan || !nameInput) return;

    // ... (Keep existing UI state logic: show nameSpan, hide input) ...
    nameSpan.classList.remove('hidden');
    nameInput.classList.add('hidden');
    saveBtn?.classList.add('hidden');
    arrow?.classList.remove('hidden');

    nameSpan.onclick = (e) => {
        e.stopPropagation();
        startEditingFlowName();
    };

    if (arrow) {
        // Unbind previous event first to avoid duplicates if called multiple times
        arrow.onclick = null; 
        arrow.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const dropdown = getEl('flowDropdown');
            if (dropdown) {
                const isHidden = dropdown.classList.contains('hidden');
                if (isHidden) {
                    // Open
                    dropdown.classList.remove('hidden');
                    arrow.classList.add('rotated');
                    isFlowEditMode = false; // Always start in normal mode
                    renderFlowDropdown();
                } else {
                    // Close
                    closeFlowDropdown();
                }
            }
        };
        // Also handle touch for better mobile response
        arrow.ontouchend = arrow.onclick;
    }
}

function startEditingFlowName() {
    const nameSpan = getEl('currentFlowName');
    const nameInput = getEl('flowNameInput');
    const arrow = getEl('flowDropdownArrow');
    const saveBtn = getEl('btnFlowSave');
    getEl('flowDropdown')?.classList.add('hidden');
    arrow?.classList.add('hidden');
    nameSpan.classList.add('hidden');
    nameInput.classList.remove('hidden');
    saveBtn?.classList.remove('hidden');
    nameInput.value = appData.flows[appData.currentFlowId].name;
    nameInput.focus();
    const saveAndExit = () => {
        const v = nameInput.value.trim();
        if (v) {
            appData.flows[appData.currentFlowId].name = v;
            saveData();
            nameSpan.textContent = v;
        }
        nameInput.classList.add('hidden');
        saveBtn?.classList.add('hidden');
        nameSpan.classList.remove('hidden');
        arrow?.classList.remove('hidden');
    };
    nameInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            nameInput.blur();
        }
    };
    nameInput.onblur = () => {
        setTimeout(saveAndExit, 200);
    };
    if (saveBtn) {
        saveBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const v = nameInput.value.trim();
            if (v) {
                appData.flows[appData.currentFlowId].name = v;
                saveData();
                nameSpan.textContent = v;
            }
            nameInput.classList.add('hidden');
            saveBtn.classList.add('hidden');
            nameSpan.classList.remove('hidden');
            arrow?.classList.remove('hidden');
        };
        saveBtn.ontouchend = saveBtn.onclick;
    }
    nameInput.onclick = (e) => e.stopPropagation();
}

// --- [New Feature] Date Navigation Dropdown Logic ---
let dropdownYearState = new Date().getFullYear();

function setupNavDropdown() {
    const displayEl = getEl('currentMonthDisplay');
    const dropdown = getEl('navDateDropdown');
    if (displayEl) {
        displayEl.onclick = (e) => {
            e.stopPropagation(); 
            const isHidden = dropdown.classList.contains('hidden');
            if (isHidden) {
                dropdownYearState = currentNavDate.getFullYear();
                renderNavDropdown();
                dropdown.classList.remove('hidden');
            } else {
                dropdown.classList.add('hidden');
            }
        };
    }
    getEl('ddBtnPrevYear').onclick = (e) => { e.stopPropagation(); dropdownYearState--; renderNavDropdown(); };
    getEl('ddBtnNextYear').onclick = (e) => { e.stopPropagation(); dropdownYearState++; renderNavDropdown(); };
    document.querySelectorAll('.dd-month-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const selectedMonth = parseInt(item.dataset.m);
            const newDate = new Date(dropdownYearState, selectedMonth, 1);
            if (currentViewMode === 'timeline') {
                isNavigating = true;
                resetViewAroundDate(newDate, 'auto');
            } else {
                currentNavDate = newDate;
                renderMainCalendarGrid();
                updateNavDisplay(newDate);
            }
            dropdown.classList.add('hidden');
        };
    });
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== displayEl) {
            dropdown.classList.add('hidden');
        }
    });
}

function renderNavDropdown() {
    getEl('ddYearDisplay').textContent = dropdownYearState;
    const currentNavYear = currentNavDate.getFullYear();
    const currentNavMonth = currentNavDate.getMonth();
    document.querySelectorAll('.dd-month-item').forEach(item => {
        const m = parseInt(item.dataset.m);
        if (dropdownYearState === currentNavYear && m === currentNavMonth) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
}

function updateScrollbarWidth() {
    const outer = document.createElement('div');
    outer.style.visibility = 'hidden';
    outer.style.overflow = 'scroll';
    outer.style.msOverflowStyle = 'scrollbar';
    document.body.appendChild(outer);
    const inner = document.createElement('div');
    outer.appendChild(inner);
    const scrollbarWidth = outer.offsetWidth - inner.offsetWidth;
    outer.parentNode.removeChild(outer);
    document.documentElement.style.setProperty('--scrollbar-width', `${scrollbarWidth}px`);
}

// --- Recurring Rule Logic ---
function openRecurringOverlay() {
    if (!isRecurFormInitialized) {
        resetRecurringForm();
    }

    const settings = getFlowSettings();
    const wrapper = getEl('recurCurrencyWrapper');

    // [Fix] 根據多幣種設定，決定是否顯示選單
    if (wrapper) {
        if (settings.multiCurrency) {
            // A. 開啟模式：顯示選單並刷新選項
            wrapper.classList.remove('hidden');
            
            const recurOptions = getEl('recurCurrencyOptions');
            const recurText = getEl('recurCurrencyText');
            
            if (recurOptions && recurText) {
                // 1. 防呆：如果目前顯示的幣別已經被移出支援列表，重置為 Base
                const activeList = getActiveCurrencyList(settings);
                if (!activeList.includes(recurText.textContent)) {
                     recurText.textContent = settings.base;
                }
                
                // 2. 重新渲染選項 (確保與設定同步)
                recurOptions.innerHTML = '';
                activeList.forEach(code => {
                    const div = document.createElement('div');
                    div.className = 'custom-option';
                    div.textContent = code;
                    if (code === recurText.textContent) div.classList.add('selected');
                    
                    div.onclick = (e) => {
                        e.stopPropagation();
                        recurText.textContent = code;
                        recurOptions.classList.add('hidden');
                        updateRecurSummary(); // 更新預覽文字
                    };
                    recurOptions.appendChild(div);
                });
            }
        } else {
            // B. 關閉模式：隱藏選單
            wrapper.classList.add('hidden');
            
            // 強制將幣別重置為 Base，確保建立的交易幣別正確
            const recurText = getEl('recurCurrencyText');
            if (recurText) recurText.textContent = settings.base;
        }
    }

    recurringOverlay?.classList.remove('hidden');
}

function addMonthlyInput() {
    const wrapper = getEl('monthInputsWrapper');
    if (!wrapper) return;
    const currentInputs = wrapper.querySelectorAll('.m-day-slot');
    if (currentInputs.length >= 5) return;

    const newInput = document.createElement('input');
    newInput.type = 'number';
    newInput.className = 'recur-month-input-circle m-day-slot';
    newInput.min = 1;
    newInput.max = 31;
    newInput.value = '';
    newInput.placeholder = '-';

    newInput.oninput = (e) => {
        validateDayInput(e.target);
        updateRecurSummary();
    };
    newInput.onblur = (e) => {
        if (!e.target.value) {
            e.target.remove();
        }
        checkAddButtonVisibility();
        updateRecurSummary();
    };

    const addBtn = getEl('btnAddMonthDay');
    if (addBtn) {
        wrapper.insertBefore(newInput, addBtn);
    } else {
        wrapper.appendChild(newInput);
    }
    newInput.focus();

    checkAddButtonVisibility();
}

function validateDayInput(input) {
    let val = parseInt(input.value, 10);
    if (!isNaN(val)) {
        if (val < 1) input.value = 1;
        if (val > 31) input.value = 31;
    }
}

function checkAddButtonVisibility() {
    const btn = getEl('btnAddMonthDay');
    if (!btn) return;
    const count = document.querySelectorAll('.m-day-slot').length;
    if (count >= 5) {
        btn.classList.add('hidden');
    } else {
        btn.classList.remove('hidden');
    }
}

function resetRecurringForm() {
    recurType = 'expense';
    recurFreq = 'weekly';
    recurSelectedDays = new Set([0]);

    const amountInput = getEl('recurAmount');
    if (amountInput) amountInput.value = '';
    const noteInput = getEl('recurNote');
    if (noteInput) noteInput.value = '';

    setActiveFrequencyTab('weekly');

    document.querySelectorAll('.day-circle').forEach(circle => {
        const dayVal = parseInt(circle.dataset.d, 10);
        if (dayVal === 0) {
            circle.classList.add('selected');
        } else {
            circle.classList.remove('selected');
        }
    });

    const monthWrapper = getEl('monthInputsWrapper');
    if (monthWrapper) {
        const slots = monthWrapper.querySelectorAll('.m-day-slot');
        slots.forEach((el, index) => {
            if (index === 0) {
                el.value = '1';
            } else {
                el.remove();
            }
        });
        checkAddButtonVisibility();
    }

    const today = new Date();

    const startInput = getEl('recurStartDate');
    const endInput = getEl('recurEndDate');
    if (startInput) startInput.value = formatDate(today);
    if (endInput) {
        const nextYear = new Date(today);
        nextYear.setFullYear(today.getFullYear() + 1);
        endInput.value = formatDate(nextYear);
    }

    setRecurType('expense');
    updateRecurFormVisibility();
    const recurCurrencySelect = getEl('recurCurrency');
    if (recurCurrencySelect) {
        const settings = getFlowSettings();
        recurCurrencySelect.innerHTML = getCurrencyOptionsHtml(settings.base, settings);
        recurCurrencySelect.value = settings.base;
    }
    updateRecurSummary();
    isRecurFormInitialized = true;
    // [New] Render Recurring Custom Dropdown
    const recurTrigger = getEl('recurCurrencyTrigger');
    const recurOptions = getEl('recurCurrencyOptions');
    const recurText = getEl('recurCurrencyText');
    const settings = getFlowSettings();
    const currentBase = settings.base;

    if (recurTrigger && recurOptions && recurText) {
        // 1. 初始化顯示文字
        recurText.textContent = currentBase;
        
        // 2. 渲染選項 (使用 Active Currencies)
        recurOptions.innerHTML = '';
        const activeCurrencies = getActiveCurrencyList(settings);
        
        activeCurrencies.forEach(code => {
            const div = document.createElement('div');
            div.className = 'custom-option';
            div.textContent = code;
            if (code === currentBase) div.classList.add('selected');
            
            div.onclick = (e) => {
                e.stopPropagation();
                recurText.textContent = code; // 更新顯示
                recurOptions.classList.add('hidden');
            };
            recurOptions.appendChild(div);
        });

        // 3. 綁定開關事件
        recurTrigger.onclick = (e) => {
            e.stopPropagation();
            const isHidden = recurOptions.classList.contains('hidden');
            // Close others first (Optional)
            document.querySelectorAll('.custom-select-options').forEach(el => el.classList.add('hidden'));
            
            if (isHidden) recurOptions.classList.remove('hidden');
            else recurOptions.classList.add('hidden');
        };
    }
}

function setActiveFrequencyTab(target) {
    document.querySelectorAll('.freq-tab-m').forEach(tab => {
        if (tab.dataset.tab === target) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

function setRecurType(type) {
    recurType = type === 'income' ? 'income' : 'expense';
    const incomeBtn = getEl('rtIncome');
    const expenseBtn = getEl('rtExpense');
    if (incomeBtn && expenseBtn) {
        if (recurType === 'income') {
            incomeBtn.classList.add('active');
            expenseBtn.classList.remove('active');
        } else {
            incomeBtn.classList.remove('active');
            expenseBtn.classList.add('active');
        }
    }
    updateRecurSummary();
}

function updateRecurFormVisibility() {
    const weekly = getEl('optWeekly');
    const monthly = getEl('optMonthly');
    const daily = getEl('optDaily');
    weekly?.classList.add('hidden');
    monthly?.classList.add('hidden');
    daily?.classList.add('hidden');

    if (recurFreq === 'weekly') weekly?.classList.remove('hidden');
    if (recurFreq === 'monthly') monthly?.classList.remove('hidden');
    if (recurFreq === 'daily') daily?.classList.remove('hidden');
}

function getMonthDaysFromUI() {
    const inputs = Array.from(document.querySelectorAll('.m-day-slot'));
    return inputs
        .map(inp => parseInt(inp.value, 10))
        .filter(val => !isNaN(val) && val > 0);
}

function updateRecurSummary() {
    const summaryEl = getEl('recurSummary');
    if (!summaryEl) return;
    const startInput = getEl('recurStartDate');
    const endInput = getEl('recurEndDate');
    const amountInput = getEl('recurAmount');

    // [修改] 解析 YYYY-MM-DD 字串轉為本地 Date 物件
    const parseYMD = (val) => {
        if (!val) return null;
        const [y, m, d] = val.split('-').map(Number);
        return new Date(y, m - 1, d);
    };

    // [修改] 讀取 .value 並轉換，取代 .valueAsDate
    const startDate = parseYMD(startInput?.value);
    const endDate = parseYMD(endInput?.value);
    const amount = parseFloat(amountInput?.value || '0');
    const monthDays = getMonthDaysFromUI();
    if (!startDate || !endDate || !amount) {
        summaryEl.textContent = 'Please fill in amount and dates.';
        return;
    }
    if (endDate < startDate) {
        summaryEl.textContent = 'End date cannot be before start date.';
        return;
    }
    if (recurFreq === 'weekly' && recurSelectedDays.size === 0) {
        summaryEl.textContent = 'Select at least one weekday.';
        return;
    }
    if (recurFreq === 'monthly' && monthDays.length === 0) {
        summaryEl.textContent = 'Enter at least one day of the month.';
        return;
    }

    const noteVal = (getEl('recurNote')?.value || '').trim();
    const selectedCurrency = getEl('recurCurrency')?.value || getFlowSettings().base;
    const previewTxs = generateRecurringTransactions({
        amount,
        note: noteVal,
        startDate,
        endDate,
        type: recurType,
        freq: recurFreq,
        weekdays: new Set(recurSelectedDays),
        monthDays,
        currency: selectedCurrency
    });

    if (previewTxs.length === 0) {
        summaryEl.textContent = 'No occurrences found with current settings.';
        return;
    }

    let summaryText = `Will create ${previewTxs.length} transactions from ${formatDate(startDate)} to ${formatDate(endDate)}.`;
    if (recurFreq === 'monthly') {
        summaryText += ` On days: ${monthDays.join(', ')}.`;
    }
    summaryEl.textContent = summaryText;
}

function generateRecurringTransactions({ amount, note = '', startDate, endDate, type = 'expense', freq = 'weekly', weekdays = new Set(), monthDays = [], currency = null }) {
    const txs = [];
    if (!amount || !startDate || !endDate) return txs;

    const start = new Date(startDate); start.setHours(0, 0, 0, 0);
    const end = new Date(endDate); end.setHours(23, 59, 59, 999);

    if (end < start) return txs;

    const txCurrency = currency || getFlowSettings().base;

    const pushTx = (dateObj) => {
        const iso = formatDate(dateObj);
        txs.push({
            id: `tx_${Date.now()}_${txs.length}`,
            date: iso,
            income: type === 'income' ? amount : 0,
            expense: type === 'expense' ? amount : 0,
            note,
            createdAt: Date.now(),
            incCurrency: txCurrency,
            expCurrency: txCurrency
        });
    };

    if (freq === 'daily') {
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            pushTx(new Date(d));
        }
    } else if (freq === 'weekly') {
        const weekSet = weekdays instanceof Set ? weekdays : new Set(Array.isArray(weekdays) ? weekdays : []);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            if (weekSet.has(d.getDay())) {
                pushTx(new Date(d));
            }
        }

    }else if (freq === 'monthly') {
        // [Logic Change] Allow duplicates (e.g. input 5, 5 => create two txs on 5th)
        // Filter invalid numbers but keep duplicates
        const targetDays = monthDays.filter(d => d >= 1 && d <= 31);

        if (targetDays.length === 0) return txs;

        const cursor = new Date(start);
        cursor.setDate(1); 

        while (cursor <= end) {
            const currentYear = cursor.getFullYear();
            const currentMonth = cursor.getMonth();

            targetDays.forEach(day => {
                const candidate = new Date(currentYear, currentMonth, day);

                // Check if day exists in this month
                if (candidate.getMonth() === currentMonth) {
                    if (candidate >= start && candidate <= end) {
                        pushTx(candidate);
                    }
                }
            });

            cursor.setMonth(cursor.getMonth() + 1);
            cursor.setDate(1);
        }
    }

    return txs;
}

function executeRecurringAdd() {
    const amountVal = parseFloat(getEl('recurAmount')?.value || '0');
    const noteVal = (getEl('recurNote')?.value || '').trim();
    // [修改] 內聯解析函數 (或提取為共用函數亦可)
    const parseYMD = (val) => {
        if (!val) return null;
        const [y, m, d] = val.split('-').map(Number);
        return new Date(y, m - 1, d);
    };
    const startDate = parseYMD(getEl('recurStartDate')?.value);
    const endDate = parseYMD(getEl('recurEndDate')?.value);

    const monthDays = getMonthDaysFromUI();

    if (!amountVal || !startDate || !endDate) {
        alert('Missing fields!');
        return;
    }
    if (endDate < startDate) {
        alert('End date cannot be before start date.');
        return;
    }
    if (recurFreq === 'weekly' && recurSelectedDays.size === 0) {
        alert('Please select at least one weekday.');
        return;
    }
    if (recurFreq === 'monthly' && monthDays.length === 0) {
        alert('Please enter at least one day of the month.');
        return;
    }

    const recurCurrency = getEl('recurCurrencyText')?.textContent || getFlowSettings().base;
    const newTxs = generateRecurringTransactions({
        amount: amountVal,
        note: noteVal,
        startDate,
        endDate,
        type: recurType,
        freq: recurFreq,
        weekdays: new Set(recurSelectedDays),
        monthDays,
        currency: recurCurrency
    });

    if (newTxs.length === 0) {
        alert('No dates matched your criteria.');
        return;
    }

    const transactions = getCurrentTransactions();
    newTxs.forEach(tx => transactions.push(tx));
    setCurrentTransactions(transactions);
    recurringOverlay?.classList.add('hidden');
    resetRecurringForm();

    if (currentViewMode === 'timeline') {
        resetViewAroundDate(currentNavDate, 'auto');
    } else {
        renderMainCalendarGrid();
        if (selectedCalendarDateStr) updateFooterEditor(selectedCalendarDateStr);
    }
    updateTotalForecast();

    showUndoToast({ type: 'batch', txs: newTxs }, `Added ${newTxs.length} recurring items`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

// --- In-App Browser Detector (Comprehensive) ---
function detectInAppBrowser() {
    // 取得 User Agent 並轉為小寫，方便比對
    const ua = (navigator.userAgent || navigator.vendor || window.opera).toLowerCase();

    // 定義常見的 App 內建瀏覽器關鍵字
    const iabKeywords = [
        'fban', 'fbav',       // Facebook (iOS/Android)
        'instagram',          // Instagram
        'line',               // LINE
        'micromessenger',     // WeChat (微信)
        'tiktok', 'musical_ly', // TikTok
        'twitter',            // Twitter (X)
        'kakaotalk',          // KakaoTalk (Korea)
        'naver',              // Naver (Korea)
        'snapchat',           // Snapchat
        'pinterest',          // Pinterest
        'linkedin',           // LinkedIn
        'discord',            // Discord
        'slack',              // Slack
        'zalo',               // Zalo (Vietnam)
        'viber',              // Viber
        'vk',                 // VKontakte (Russia/Europe)
        'weibo'               // Weibo
    ];

    // 檢查 User Agent 是否包含上述任一關鍵字
    const isInApp = iabKeywords.some(keyword => ua.includes(keyword));

    if (isInApp) {
        const overlay = document.getElementById('inAppBrowserOverlay');
        if (overlay) {
            overlay.classList.remove('hidden');
            // 強制隱藏主介面，避免使用者嘗試操作
            const appContainer = document.querySelector('.app-container');
            if (appContainer) appContainer.style.display = 'none';
        }
        return true;
    }
    return false;
}