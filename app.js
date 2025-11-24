const PROJECT_START_DATE = new Date(2020, 0, 1);
const STORAGE_KEY = 'financial_flow_data_v3';
const BATCH_SIZE = 90;
const PAST_BUFFER_DAYS = 90;
const FUTURE_BUFFER_DAYS = 180;

// 日曆圖標 SVG (簡約風格)
const ICON_CAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>`;

// 列表圖標 SVG (簡約風格)
const ICON_LIST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>`;

let appData = {
    currentFlowId: 'flow_default',
    flows: { 'flow_default': { name: 'Prime Flow', transactions: [] } }
};

let loadedStartDate = new Date();
let loadedEndDate = new Date();
let currentNavDate = new Date();
let isNavigating = false;
let isLoading = false;
let isInitialRender = true;

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

// Recurring State
let recurType = 'expense';
let recurFreq = 'weekly';
let recurSelectedDays = new Set(); // Weekly selection (0-6)

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

// --- Initialization ---
function init() {
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

// --- Helper: 數字縮寫工具 (門檻: 100K) ---
function formatCompactNumber(number) {
    if (number < 100000) return number.toLocaleString();
    const units = ['K', 'M', 'B', 'T'];
    const tier = Math.floor(Math.log10(number) / 3);
    if (tier === 0) return number;
    const suffix = units[tier - 1];
    const scale = Math.pow(10, tier * 3);
    const scaled = number / scale;
    return scaled.toFixed(1) + suffix;
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

function loadLocalData() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) { try { appData = JSON.parse(stored); } catch { } }
    updateFlowUI();
}

function saveData(skipCloud = false) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    if (currentUser && !skipCloud && window.firebaseDb) {
        const { doc, setDoc } = window;
        setDoc(doc(window.firebaseDb, "users", currentUser.uid), appData, { merge: true });
    }
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

function areFlowsEqual(localFlows, cloudFlows) {
    localFlows = localFlows || {};
    cloudFlows = cloudFlows || {};
    const localKeys = Object.keys(localFlows);
    const cloudKeys = Object.keys(cloudFlows);
    if (localKeys.length !== cloudKeys.length) return false;
    for (const key of localKeys) {
        const lFlow = localFlows[key];
        const cFlow = cloudFlows[key];
        if (!cFlow) return false;
        if (lFlow.name !== cFlow.name) return false;
        const lTxsStr = JSON.stringify(lFlow.transactions || []);
        const cTxsStr = JSON.stringify(cFlow.transactions || []);
        if (lTxsStr !== cTxsStr) return false;
    }
    return true;
}

function checkAndPromptSync(local, cloud) {
    if (areFlowsEqual(local.flows, cloud.flows)) {
        console.log("Local data matches cloud exactly. Skipping sync prompt.");
        appData = cloud;
        updateFlowUI();
        resetViewAroundDate(currentNavDate, 'auto');
        return; 
    }
    const validLocalFlows = Object.values(local.flows || {}).filter(f => f.transactions && f.transactions.length > 0);
    if (validLocalFlows.length === 0) {
        console.log("No valid local data. Overwriting with cloud.");
        appData = cloud;
        saveData(false);
        updateFlowUI();
        resetViewAroundDate(currentNavDate, 'auto');
        return;
    }
    pendingLocalData = local;
    pendingCloudData = cloud;
    const overlay = getEl('syncOverlay');
    overlay?.classList.remove('hidden');
    renderSyncList(validLocalFlows);
}

function renderSyncList(flows) {
    const container = getEl('syncFlowList');
    if (!container) return;
    container.innerHTML = '';
    flows.forEach(flow => {
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
        div.querySelector('.btn-sync-delete').onclick = () => {
            div.remove();
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
    const finalData = JSON.parse(JSON.stringify(pendingCloudData));
    if (keepFlowIds.length > 0) {
        keepFlowIds.forEach(id => {
            const localFlow = pendingLocalData.flows[id];
            if (!localFlow) return;
            if (!finalData.flows[id]) {
                finalData.flows[id] = localFlow;
            } else {
                const existingTxIds = new Set(finalData.flows[id].transactions.map(t => t.id));
                localFlow.transactions.forEach(tx => {
                    if (!existingTxIds.has(tx.id)) {
                        finalData.flows[id].transactions.push(tx);
                    }
                });
            }
        });
    }
    appData = finalData;
    saveData(false);
    getEl('syncOverlay')?.classList.add('hidden');
    updateFlowUI();
    resetViewAroundDate(currentNavDate, 'auto');
    pendingLocalData = null;
    pendingCloudData = null;
}

// --- Flow UI ---
function updateFlowUI() {
    const nameEl = getEl('currentFlowName');
    if (nameEl) nameEl.textContent = appData.flows[appData.currentFlowId]?.name || 'Flow';
    enableFlowNameEdit();
    renderFlowDropdown();
}

function renderFlowDropdown() {
    const list = getEl('flowListContainer');
    if (!list) return;
    list.innerHTML = '';
    const flowIds = Object.keys(appData.flows);
    const canDelete = flowIds.length > 1;
    flowIds.forEach(flowId => {
        const flow = appData.flows[flowId];
        if (!flow) return;
        const item = document.createElement('div');
        item.className = 'flow-item';
        if (flowId === appData.currentFlowId) item.classList.add('active');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'flow-item-name';
        nameSpan.textContent = flow.name;
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-delete-flow';
        deleteBtn.title = 'Delete Flow';
        deleteBtn.textContent = '✕';
        if (!canDelete) {
            deleteBtn.disabled = true;
        }
        item.appendChild(nameSpan);
        item.appendChild(deleteBtn);
        item.onclick = (e) => {
            if (e.target === deleteBtn) return;
            appData.currentFlowId = flowId;
            saveData();
            getEl('flowDropdown')?.classList.add('hidden');
            updateFlowUI();
            resetViewAroundDate(currentNavDate, 'auto');
        };
        if (canDelete) {
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                flowToDeleteId = flowId;
                const overlay = getEl('flowDeleteOverlay');
                const msg = getEl('deleteFlowMsg');
                if (overlay && msg) {
                    msg.innerHTML = `Delete flow "<b>${flow.name}</b>"?<br><span style="font-size:0.8rem; color:#666;">All transactions in this flow will be lost.</span>`;
                    overlay.classList.remove('hidden');
                    getEl('flowDropdown')?.classList.add('hidden');
                }
            };
        }
        list.appendChild(item);
    });
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
    for (let i = 0; i < daysCount; i++) {
        const d = new Date(startDate); d.setDate(startDate.getDate() + i);
        const dateStr = formatDate(d);
        const { totalIncome, totalExpense, notes } = getDaySummary(dateStr);
        const wrapper = document.createElement('div');
        wrapper.className = 'row-wrapper';
        wrapper.dataset.date = dateStr;
        if (d.getTime() === today.getTime()) wrapper.classList.add('today');
        if (d < today) wrapper.classList.add('past');
        if (d.getDay() === 0 || d.getDay() === 6) wrapper.classList.add('weekend');
        const row = document.createElement('div');
        row.className = 'planning-row grid-layout';
        row.innerHTML = `
            <div class="row-date"><span class="date-day">${d.getDate()}</span><span class="date-weekday">${getWeekday(d)}</span></div>
            <div class="row-sum sum-income">${totalIncome > 0 ? `+$${totalIncome.toLocaleString()}` : ''}</div>
            <div class="row-sum sum-expense">${totalExpense > 0 ? `-$${totalExpense.toLocaleString()}` : ''}</div>
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
    const { items } = getDaySummary(dateStr);
    list.innerHTML = '';
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'detail-item grid-layout';
        div.innerHTML = `
            <div class="detail-spacer"></div>
            <div class="d-col income">${item.income > 0 ? `+$${item.income}` : ''}</div>
            <div class="d-col expense">${item.expense > 0 ? `-$${item.expense}` : ''}</div>
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
        const inputRow = document.createElement('div');
        inputRow.className = 'quick-input grid-layout';
        inputRow.innerHTML = `
            <div class="detail-spacer"></div>
            <input type="number" class="quick-input-field inc" id="inc-${dateStr}" placeholder="Inc">
            <input type="number" class="quick-input-field exp" id="exp-${dateStr}" placeholder="Exp">
            <input type="text" class="quick-input-field note" id="note-${dateStr}" placeholder="Note">
            <button class="btn-quick-add">+</button>
        `;
        
        // Bind standard add
        inputRow.querySelector('.btn-quick-add').onclick = (e) => {
            e.stopPropagation();
            addTransactionUnified(dateStr, 'timeline', wrapper);
        };

        inputRow.querySelectorAll('input').forEach(inp => {
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
    let chipsHtml = '';
    if (items.length > 0) {
        items.forEach(item => {
            const inc = item.income || 0;
            const exp = item.expense || 0;
            const note = item.note ? item.note.trim() : '';
            const hasNote = note.length > 0;
            let stateClass = 's-note';
            if (inc > 0 && exp > 0 && hasNote) stateClass = 's-tri';
            else if (inc > 0 && exp > 0) stateClass = 's-inc-exp';
            else if (inc > 0 && hasNote) stateClass = 's-inc-note';
            else if (exp > 0 && hasNote) stateClass = 's-exp-note';
            else if (inc > 0) stateClass = 's-inc';
            else if (exp > 0) stateClass = 's-exp';
            let valHtml = '';
            if (inc > 0) valHtml += `<span class="c-inc">+$${formatCompactNumber(inc)}</span>`;
            if (exp > 0) valHtml += `<span class="c-exp">-$${formatCompactNumber(exp)}</span>`;
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
        let contentHtml = '';
        if (isNoteOnly) {
            contentHtml = `<span class="chip-note" style="max-width: 120px;">${item.note || 'Empty'}</span>`;
        } else {
            let valStr = '';
            if (inc > 0) valStr += `<span class="c-inc">+$${inc.toLocaleString()}</span> `;
            if (exp > 0) valStr += `<span class="c-exp">-$${exp.toLocaleString()}</span>`;
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
    
    // Bind Standard Add
    const btnAdd = getEl('footerBtnAdd');
    const newBtn = btnAdd.cloneNode(true);
    btnAdd.parentNode.replaceChild(newBtn, btnAdd);
    newBtn.onclick = () => addTransactionUnified(dateStr, 'footer');

    ['footerInc', 'footerExp', 'footerNote'].forEach(id => {
        const inp = getEl(id);
        inp.onkeydown = (e) => { if (e.key === 'Enter') addTransactionUnified(dateStr, 'footer'); };
    });
}

// --- Unified Transaction Operations ---
function addTransactionUnified(dateStr, source, rowWrapper = null) {
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
    const newTx = { id: `tx_${Date.now()}`, date: dateStr, income: inc, expense: exp, note: note, createdAt: Date.now() };
    const transactions = getCurrentTransactions();
    transactions.push(newTx);
    setCurrentTransactions(transactions);
    if (source === 'footer') {
        getEl('footerInc').value = ''; getEl('footerExp').value = ''; getEl('footerNote').value = '';
        updateFooterEditor(dateStr);
        if (typeof refreshCalendarCell === 'function') {
            refreshCalendarCell(dateStr);
        } else {
            renderMainCalendarGrid();
        }
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
        const { id, data } = undoData;
        if (id && data) {
            appData.flows[id] = data;
            appData.currentFlowId = id;
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

function getDaySummary(dateStr) {
    const items = getCurrentTransactions().filter(t => t.date === dateStr);
    let totalIncome = 0, totalExpense = 0, notes = [];
    items.forEach(t => {
        totalIncome += (t.income || 0);
        totalExpense += (t.expense || 0);
        if (t.note) notes.push(t.note);
    });
    return { totalIncome, totalExpense, notes, items };
}

function updateTotalForecast() {
    let totalInc = 0, totalExp = 0;
    const trans = getCurrentTransactions();
    const desc = getEl('summaryLabel');
    const incEl = getEl('summaryIncome'), expEl = getEl('summaryExpense'), balEl = getEl('summaryBalance');
    if (!desc) return;
    if (summaryMode === 'total') {
        trans.forEach(t => { totalInc += (t.income || 0); totalExp += (t.expense || 0); });
    } else if (summaryMode === 'current') {
        const limitDateStr = getVisibleBottomDate();
        if (limitDateStr) {
            desc.textContent = `RUNNING (Till ${limitDateStr})`;
            trans.forEach(t => { if (t.date <= limitDateStr) { totalInc += (t.income || 0); totalExp += (t.expense || 0); } });
        }
    } else if (summaryMode === 'custom') {
        const sStr = formatDate(pickerStartDate);
        const eStr = formatDate(pickerEndDate);
        const editIcon = `<svg class="edit-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        desc.innerHTML = `${sStr} ~ ${eStr} ${editIcon}`;
        const start = normalizeToStartOfDay(pickerStartDate).getTime();
        const end = normalizeToEndOfDay(pickerEndDate).getTime();
        trans.forEach(t => {
            const ts = new Date(t.date).getTime();
            if (ts >= start && ts <= end) { totalInc += t.income || 0; totalExp += t.expense || 0; }
        });
    }
    incEl.textContent = `$${totalInc.toLocaleString()}`;
    expEl.textContent = `$${totalExp.toLocaleString()}`;
    balEl.textContent = `$${(totalInc - totalExp).toLocaleString()}`;
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
    getEl('btnCalPrev').onclick = () => { pickerBaseDate.setMonth(pickerBaseDate.getMonth() - 1); renderDatePicker(); };
    getEl('btnCalNext').onclick = () => { pickerBaseDate.setMonth(pickerBaseDate.getMonth() + 1); renderDatePicker(); };
    getEl('btnApplyRange').onclick = () => {
        if (tempStart) {
            pickerStartDate = tempStart; pickerEndDate = tempEnd ? tempEnd : tempStart;
            summaryMode = 'custom'; if (getEl('modeLabel')) getEl('modeLabel').textContent = 'CUSTOM';
            dateRangeOverlay.classList.add('hidden'); updateTotalForecast();
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
                delete appData.flows[targetId];
                if (appData.currentFlowId === targetId) {
                    const firstId = Object.keys(appData.flows)[0];
                    if (firstId) appData.currentFlowId = firstId;
                }
                saveData();
                updateFlowUI();
                resetViewAroundDate(currentNavDate, 'auto');
                showUndoToast({ type: 'flow', id: targetId, data: targetFlow }, 'Flow deleted');
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
    document.body.onclick = () => getEl('flowDropdown')?.classList.add('hidden');
    const btnAdd = getEl('btnAddFlow'); if (btnAdd) btnAdd.onclick = () => { const id = 'f_' + Date.now(); appData.flows[id] = { name: 'Untitled Flow', transactions: [] }; appData.currentFlowId = id; saveData(); updateFlowUI(); resetViewAroundDate(new Date(), 'auto'); getEl('flowDropdown')?.classList.add('hidden'); startEditingFlowName(); };
    
    // Recurring UI Bindings
    const btnOpenRecurring = getEl('btnOpenRecurringOverlay');
    if (btnOpenRecurring) {
        btnOpenRecurring.onclick = () => {
            getEl('flowDropdown')?.classList.add('hidden');
            prepareRecurringOverlay();
        };
    }

    const btnRecurClose = getEl('btnRecurClose');
    if (btnRecurClose) {
        btnRecurClose.onclick = () => recurringOverlay?.classList.add('hidden');
    }

    const incomeBtn = getEl('rtIncome');
    const expenseBtn = getEl('rtExpense');
    if (incomeBtn && expenseBtn) {
        incomeBtn.onclick = () => setRecurType('income');
        expenseBtn.onclick = () => setRecurType('expense');
    }

    document.querySelectorAll('.freq-tab').forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll('.freq-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            recurFreq = tab.dataset.tab;
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

    const monthDayInput = getEl('recurMonthDay');
    if (monthDayInput) monthDayInput.oninput = updateRecurSummary;
    ['recurAmount', 'recurNote', 'recurStartDate', 'recurEndDate'].forEach(id => {
        const field = getEl(id);
        if (field) field.oninput = updateRecurSummary;
    });

    const btnRecurConfirm = getEl('btnRecurConfirm');
    if (btnRecurConfirm) btnRecurConfirm.onclick = executeRecurringAdd;

    setupNavDropdown(); 
    const btnUndo = getEl('btnUndo');
    if (btnUndo) btnUndo.onclick = performUndo;
    setupAuth();
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
            const incStr = i.income > 0 ? '+$' + formatCompactNumber(i.income) : '';
            const expStr = i.expense > 0 ? '-$' + formatCompactNumber(i.expense) : '';
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

function openDateRangePicker() {
    dateRangeOverlay.classList.remove('hidden');
    tempStart = new Date(pickerStartDate);
    if (pickerEndDate.getTime() !== pickerStartDate.getTime()) {
        tempEnd = new Date(pickerEndDate);
    } else {
        tempEnd = null;
    }
    pickerHasInteracted = false;
    pickerBaseDate = new Date(pickerStartDate);
    pickerBaseDate.setDate(1);
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
            if (t === new Date().setHours(0, 0, 0, 0)) cls += ' today';
            const sTime = tempStart ? tempStart.getTime() : 0;
            const eTime = tempEnd ? tempEnd.getTime() : 0;
            if (tempStart && t === sTime) cls += ' range-start';
            if (tempEnd && t === eTime) cls += ' range-end';
            if (tempStart && tempEnd && t > sTime && t < eTime) cls += ' in-range';
            html += `<div class="${cls}" data-ts="${t}">${i}</div>`;
        }
        html += '</div>';
        panes[offset].innerHTML = html;
        panes[offset].querySelectorAll('.cal-day:not(.empty)').forEach(el => {
            el.onclick = () => {
                const ts = parseInt(el.dataset.ts);
                const clickDate = new Date(ts);
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
                    if (tempEnd) {
                        tempStart = tempEnd;
                        tempEnd = null;
                    } else {
                        tempStart = null;
                    }
                } else if (tempEnd && ts === eTime) {
                    tempEnd = null;
                } else {
                    if (!tempStart) {
                        tempStart = clickDate;
                    } else if (tempEnd) {
                        tempStart = clickDate;
                        tempEnd = null;
                    } else {
                        if (clickDate < tempStart) {
                            tempEnd = tempStart;
                            tempStart = clickDate;
                        } else {
                            tempEnd = clickDate;
                        }
                    }
                }
                renderDatePicker();
            };
        });
    });
    getEl('pickerMonthsLabel').textContent = formatMonth(pickerBaseDate);
    const sText = tempStart ? formatDate(tempStart) : 'Select start...';
    const eText = tempEnd ? formatDate(tempEnd) : (tempStart ? 'Select end (or Apply)' : '...');
    const html = `
        <div class="picker-range-display">
            <span class="p-date">${sText}</span>
            <span class="picker-arrow">→</span>
            <span class="p-date">${eText}</span>
        </div>
    `;
    getEl('selectedRangeText').innerHTML = html;
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

function enableFlowNameEdit() {
    const nameSpan = getEl('currentFlowName');
    const nameInput = getEl('flowNameInput');
    const arrow = getEl('flowDropdownArrow');
    const saveBtn = getEl('btnFlowSave');
    if (!nameSpan || !nameInput) return;
    nameSpan.classList.remove('hidden');
    nameInput.classList.add('hidden');
    saveBtn?.classList.add('hidden');
    arrow?.classList.remove('hidden');
    nameSpan.onclick = (e) => {
        e.stopPropagation();
        startEditingFlowName();
    };
    if (arrow) {
        const toggleDropdown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const dropdown = getEl('flowDropdown');
            if (dropdown) {
                const isHidden = dropdown.classList.contains('hidden');
                if (isHidden) dropdown.classList.remove('hidden');
                else dropdown.classList.add('hidden');
            }
        };
        arrow.onclick = toggleDropdown;
        arrow.ontouchend = toggleDropdown;
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
function prepareRecurringOverlay() {
    recurType = 'expense';
    recurFreq = 'weekly';
    recurSelectedDays = new Set([1]); // Default to Monday

    const amountInput = getEl('recurAmount');
    if (amountInput) amountInput.value = '';
    const noteInput = getEl('recurNote');
    if (noteInput) noteInput.value = '';

    document.querySelectorAll('.freq-tab').forEach(tab => tab.classList.remove('active'));
    const weeklyTab = document.querySelector('.freq-tab[data-tab="weekly"]');
    if (weeklyTab) weeklyTab.classList.add('active');

    document.querySelectorAll('.day-circle').forEach(circle => {
        circle.classList.remove('selected');
        if (parseInt(circle.dataset.d, 10) === 1) circle.classList.add('selected');
    });

    const monthDayInput = getEl('recurMonthDay');
    const today = new Date();
    if (monthDayInput) monthDayInput.value = today.getDate();

    const startInput = getEl('recurStartDate');
    const endInput = getEl('recurEndDate');
    if (startInput) startInput.valueAsDate = today;
    if (endInput) {
        const nextYear = new Date(today);
        nextYear.setFullYear(today.getFullYear() + 1);
        endInput.valueAsDate = nextYear;
    }

    setRecurType('expense');
    updateRecurFormVisibility();
    updateRecurSummary();
    recurringOverlay?.classList.remove('hidden');
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

function updateRecurSummary() {
    const summaryEl = getEl('recurSummary');
    if (!summaryEl) return;
    const startInput = getEl('recurStartDate');
    const endInput = getEl('recurEndDate');
    const amountInput = getEl('recurAmount');
    const monthDayInput = getEl('recurMonthDay');

    const startDate = startInput?.valueAsDate;
    const endDate = endInput?.valueAsDate;
    const amount = parseFloat(amountInput?.value || '0');
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

    const noteVal = (getEl('recurNote')?.value || '').trim();
    const monthDay = parseInt(monthDayInput?.value || '1', 10) || 1;
    const previewTxs = generateRecurringTransactions({
        amount,
        note: noteVal,
        startDate,
        endDate,
        type: recurType,
        freq: recurFreq,
        weekdays: new Set(recurSelectedDays),
        monthDay
    });

    if (previewTxs.length === 0) {
        summaryEl.textContent = 'No occurrences found with current settings.';
        return;
    }

    summaryEl.textContent = `Will create ${previewTxs.length} transactions from ${formatDate(startDate)} to ${formatDate(endDate)}.`;
}

function generateRecurringTransactions({ amount, note = '', startDate, endDate, type = 'expense', freq = 'weekly', weekdays = new Set(), monthDay = 1 }) {
    const txs = [];
    if (!amount || !startDate || !endDate) return txs;
    const start = normalizeToStartOfDay(startDate);
    const end = normalizeToStartOfDay(endDate);
    if (end < start) return txs;

    const pushTx = (dateObj) => {
        const iso = formatDate(dateObj);
        txs.push({
            id: `tx_${Date.now()}_${txs.length}`,
            date: iso,
            income: type === 'income' ? amount : 0,
            expense: type === 'expense' ? amount : 0,
            note,
            createdAt: Date.now()
        });
    };

    if (freq === 'daily') {
        for (let d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
            pushTx(new Date(d));
        }
        return txs;
    }

    if (freq === 'weekly') {
        const days = weekdays && weekdays.size > 0 ? Array.from(weekdays) : [start.getDay()];
        const daySet = new Set(days.map(v => parseInt(v, 10)));
        for (let d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
            if (daySet.has(d.getDay())) {
                pushTx(new Date(d));
            }
        }
        return txs;
    }

    if (freq === 'monthly') {
        const dayVal = Math.min(Math.max(parseInt(monthDay, 10) || 1, 1), 31);
        const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
        while (cursor.getTime() <= end.getTime()) {
            const year = cursor.getFullYear();
            const month = cursor.getMonth();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            const targetDay = Math.min(dayVal, daysInMonth);
            const candidate = new Date(year, month, targetDay);
            if (candidate.getTime() >= start.getTime() && candidate.getTime() <= end.getTime()) {
                pushTx(candidate);
            }
            cursor.setMonth(cursor.getMonth() + 1);
        }
        return txs;
    }

    return txs;
}

function executeRecurringAdd() {
    const amountVal = parseFloat(getEl('recurAmount')?.value || '0');
    const noteVal = (getEl('recurNote')?.value || '').trim();
    const startDate = getEl('recurStartDate')?.valueAsDate;
    const endDate = getEl('recurEndDate')?.valueAsDate;
    const monthDay = parseInt(getEl('recurMonthDay')?.value || '1', 10) || 1;

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

    const newTxs = generateRecurringTransactions({
        amount: amountVal,
        note: noteVal,
        startDate,
        endDate,
        type: recurType,
        freq: recurFreq,
        weekdays: new Set(recurSelectedDays),
        monthDay
    });

    if (newTxs.length === 0) {
        alert('No dates matched your criteria.');
        return;
    }

    const transactions = getCurrentTransactions();
    newTxs.forEach(tx => transactions.push(tx));
    setCurrentTransactions(transactions);
    recurringOverlay?.classList.add('hidden');

    if (currentViewMode === 'timeline') {
        resetViewAroundDate(currentNavDate, 'auto');
    } else {
        renderMainCalendarGrid();
        if (selectedCalendarDateStr) updateFooterEditor(selectedCalendarDateStr);
    }

    showUndoToast({ type: 'batch', txs: newTxs }, `Added ${newTxs.length} recurring items`);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();