// ===== TaskFlow App =====
(function () {
    'use strict';

    // ===== State =====
    const STATE_KEY = 'taskflow_data_v2';
    const SYNC_CFG_KEY = 'taskflow_firebase_config';
    const SYNC_CODE_KEY = 'taskflow_sync_code';
    let state = loadState();
    let currentView = 'weekly';
    let currentWeekOffset = 0;
    let currentMonthOffset = 0;
    let miniMonthOffset = 0;
    let editingItemId = null;
    let selectedCategories = [];
    let draggedItemId = null;
    let currentItemType = 'task'; // 'task' or 'event'
    let calendarMode = 'deadline'; // 'deadline' or 'schedule'
    let miniCalMode = 'schedule';
    let editingCategoryId = null;
    let addFromCategory = null; // category id when adding from category view
    let addFromDate = null; // pre-set schedule date when adding from weekly

    function defaultState() {
        return {
            tasks: [],
            events: [],
            categories: [
                { id: genId(), name: '仕事', color: '#7C8CF8' },
                { id: genId(), name: 'プライベート', color: '#7DDBA3' },
                { id: genId(), name: '勉強', color: '#FFBD9B' },
            ],
        };
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                if (data && data.tasks && data.categories) {
                    if (!data.events) data.events = [];
                    return data;
                }
            }
        } catch (e) { /* ignore */ }
        return defaultState();
    }

    function saveStateLocal() {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
    }

    function saveState() {
        saveStateLocal();
        if (typeof Sync !== 'undefined' && Sync && Sync.isActive()) {
            Sync.pushDebounced();
        }
    }

    // ===== Sync (Firebase Firestore) =====
    const Sync = {
        app: null,
        db: null,
        code: null,
        unsub: null,
        pushTimer: null,
        applyingRemote: false,
        status: 'disabled', // disabled | connecting | connected | error
        error: null,

        isActive() {
            return !!(this.db && this.code);
        },

        loadConfig() {
            try {
                const raw = localStorage.getItem(SYNC_CFG_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch { return null; }
        },

        genCode() {
            const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
            let s = '';
            const arr = new Uint8Array(32);
            (crypto || window.crypto).getRandomValues(arr);
            for (let i = 0; i < 32; i++) s += chars[arr[i] % chars.length];
            return s;
        },

        async init() {
            const cfg = this.loadConfig();
            if (!cfg) {
                this.status = 'disabled';
                this.updateUI();
                return;
            }
            if (typeof firebase === 'undefined') {
                this.status = 'error';
                this.error = 'Firebase SDK未読込 (ネット要)';
                this.updateUI();
                return;
            }
            try {
                // Clean up any existing app safely
                try {
                    const existing = firebase.apps && firebase.apps[0];
                    if (existing) existing.delete();
                } catch {}
                // Small delay to let deletion settle
                await new Promise(r => setTimeout(r, 200));
                this.app = firebase.initializeApp(cfg);
                this.db = firebase.firestore();
                this.code = localStorage.getItem(SYNC_CODE_KEY) || this.genCode();
                localStorage.setItem(SYNC_CODE_KEY, this.code);
                this.status = 'connecting';
                this.updateUI();
                this.subscribe();
            } catch (e) {
                this.status = 'error';
                this.error = (e && e.message) || 'init失敗';
                this.updateUI();
            }
        },

        async configure(cfg, newCode) {
            // Disconnect current
            if (this.unsub) { try { this.unsub(); } catch {} this.unsub = null; }
            if (this.app) { try { this.app.delete(); } catch {} this.app = null; }
            this.db = null;
            // Save config
            localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(cfg));
            if (newCode) {
                localStorage.setItem(SYNC_CODE_KEY, newCode.trim());
            }
            await this.init();
        },

        disconnect() {
            if (this.unsub) { try { this.unsub(); } catch {} this.unsub = null; }
            if (this.app) { try { this.app.delete(); } catch {} this.app = null; }
            this.db = null;
            this.code = null;
            localStorage.removeItem(SYNC_CFG_KEY);
            localStorage.removeItem(SYNC_CODE_KEY);
            this.status = 'disabled';
            this.error = null;
            this.updateUI();
        },

        subscribe() {
            if (!this.db || !this.code) return;
            const ref = this.db.collection('syncs').doc(this.code);
            this.unsub = ref.onSnapshot(snap => {
                this.status = 'connected';
                this.error = null;
                this.updateUI();
                if (!snap.exists) {
                    // First time - upload current
                    this.pushNow();
                    return;
                }
                const data = snap.data();
                if (!data || !data.payload) return;
                // Skip if this change came from us
                if (data.origin && data.origin === this.deviceId()) return;
                try {
                    const remote = JSON.parse(data.payload);
                    if (JSON.stringify(state) === data.payload) return;
                    this.applyingRemote = true;
                    // Replace state in place so references survive
                    state.tasks = remote.tasks || [];
                    state.events = remote.events || [];
                    state.categories = remote.categories || [];
                    saveStateLocal();
                    if (typeof renderCurrentView === 'function') renderCurrentView();
                    if (typeof scheduleAlarms === 'function') scheduleAlarms();
                    this.applyingRemote = false;
                    if (typeof showToast === 'function') showToast('同期: 他端末の変更を反映');
                } catch (e) {
                    this.applyingRemote = false;
                }
            }, err => {
                this.status = 'error';
                this.error = err.message || '接続エラー';
                this.updateUI();
            });
        },

        deviceId() {
            let id = localStorage.getItem('taskflow_device_id');
            if (!id) {
                id = 'dev_' + Math.random().toString(36).slice(2, 10);
                localStorage.setItem('taskflow_device_id', id);
            }
            return id;
        },

        pushDebounced() {
            if (this.applyingRemote) return;
            if (!this.isActive()) return;
            clearTimeout(this.pushTimer);
            this.pushTimer = setTimeout(() => this.pushNow(), 1200);
        },

        pushNow() {
            if (!this.isActive()) return;
            const ref = this.db.collection('syncs').doc(this.code);
            const payload = JSON.stringify(state);
            ref.set({
                payload: payload,
                updatedAt: Date.now(),
                origin: this.deviceId(),
            }).catch(err => {
                this.status = 'error';
                this.error = err.message || '書き込みエラー';
                this.updateUI();
            });
        },

        updateUI() {
            const map = {
                disabled:   { text: '同期 OFF',      cls: 'sync-off' },
                connecting: { text: '接続中…',       cls: 'sync-connecting' },
                connected:  { text: '同期中 ✓',      cls: 'sync-on' },
                error:      { text: 'エラー: ' + (this.error || ''), cls: 'sync-error' },
            };
            const s = map[this.status] || map.disabled;
            const main = document.getElementById('sync-status-indicator');
            if (main) {
                main.textContent = s.text;
                main.className = 'sync-status ' + s.cls;
            }
            const mini = document.getElementById('sync-status-mini');
            if (mini) {
                mini.textContent = s.text;
                mini.className = 'sync-status-mini ' + s.cls;
            }
            const codeEl = document.getElementById('sync-code-display');
            if (codeEl) codeEl.value = this.code || '';
            const cfgEl = document.getElementById('sync-config-input');
            if (cfgEl && !cfgEl.value) {
                const cfg = this.loadConfig();
                if (cfg) cfgEl.value = JSON.stringify(cfg, null, 2);
            }
        },
    };

    function genId() {
        return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    // ===== Touch Drag & Drop =====
    const TouchDnD = {
        active: false,
        pendingId: null,
        pendingType: null,
        clone: null,
        originalEl: null,
        longPressTimer: null,
        startX: 0,
        startY: 0,
        currentDropZone: null,
        currentDropDate: null,
        _moveHandler: null,
        _endHandler: null,

        bindItem(el, id, type) {
            el.addEventListener('touchstart', e => this._onStart(e, el, id, type), { passive: true });
        },

        _onStart(e, el, id, type) {
            this.cancel();
            this.startX = e.touches[0].clientX;
            this.startY = e.touches[0].clientY;

            // Early-move: cancel long-press if finger moves too much
            const earlyMove = ev => {
                const dx = ev.touches[0].clientX - this.startX;
                const dy = ev.touches[0].clientY - this.startY;
                if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
                    clearTimeout(this.longPressTimer);
                    document.removeEventListener('touchmove', earlyMove);
                }
            };
            document.addEventListener('touchmove', earlyMove, { passive: true });

            this.longPressTimer = setTimeout(() => {
                document.removeEventListener('touchmove', earlyMove);
                this._activate(el, id, type);
            }, 550);
        },

        _activate(el, id, type) {
            this.active = true;
            this.pendingId = id;
            this.pendingType = type;
            this.originalEl = el;

            // Haptic feedback
            if (navigator.vibrate) navigator.vibrate(40);

            // Prevent text selection during drag
            document.body.classList.add('drag-in-progress');

            // Create floating clone
            const rect = el.getBoundingClientRect();
            const clone = el.cloneNode(true);
            clone.className = (clone.className || '') + ' drag-clone';
            clone.style.width = rect.width + 'px';
            clone.style.left = rect.left + 'px';
            clone.style.top = rect.top + 'px';
            document.body.appendChild(clone);
            this.clone = clone;
            el.classList.add('drag-active');

            // Switch to document-level drag tracking
            this._moveHandler = ev => this._onMove(ev);
            this._endHandler = ev => this._onEnd(ev);
            document.addEventListener('touchmove', this._moveHandler, { passive: false });
            document.addEventListener('touchend', this._endHandler);
            document.addEventListener('touchcancel', this._endHandler);
        },

        _onMove(e) {
            if (!this.active) return;
            e.preventDefault(); // Block page scroll while dragging

            const x = e.touches[0].clientX;
            const y = e.touches[0].clientY;
            const w = parseInt(this.clone.style.width) || 200;
            this.clone.style.left = (x - w / 2) + 'px';
            this.clone.style.top = (y - 50) + 'px';

            // Auto-scroll when near top/bottom edge of scrollable view
            const scrollEl = document.querySelector('.view.active');
            if (scrollEl) {
                const rect = scrollEl.getBoundingClientRect();
                const edgeSize = 90;
                const viewTop = rect.top;
                const viewBottom = Math.min(rect.bottom, window.innerHeight);
                if (y < viewTop + edgeSize) {
                    scrollEl.scrollTop -= 8;
                } else if (y > viewBottom - edgeSize) {
                    scrollEl.scrollTop += 8;
                }
            }

            // Find drop zone under finger (hide clone temporarily)
            this.clone.style.visibility = 'hidden';
            const under = document.elementFromPoint(x, y);
            this.clone.style.visibility = '';

            const zone = under && under.closest('[data-date]');
            const date = zone ? zone.dataset.date : null;

            if (date !== this.currentDropDate) {
                if (this.currentDropZone) this.currentDropZone.classList.remove('drop-zone-highlight');
                this.currentDropDate = date;
                this.currentDropZone = zone;
                if (zone) zone.classList.add('drop-zone-highlight');
            }
        },

        _onEnd(e) {
            document.removeEventListener('touchmove', this._moveHandler);
            document.removeEventListener('touchend', this._endHandler);
            document.removeEventListener('touchcancel', this._endHandler);

            const dropDate = this.currentDropDate;
            const id = this.pendingId;
            const type = this.pendingType;
            this.cancel();

            if (dropDate && id) {
                // Delay so the touchend doesn't accidentally tap dialog buttons
                setTimeout(() => this._showDialog(id, type, dropDate), 80);
            }
        },

        _showDialog(id, type, date) {
            const modal = document.getElementById('dnd-modal');
            const label = document.getElementById('dnd-date-label');
            if (!modal) return;
            if (label) label.textContent = formatDateFull(date) + ' に';

            const close = () => modal.classList.remove('active');

            document.getElementById('dnd-move').onclick = () => {
                if (type === 'task') {
                    const t = state.tasks.find(t => t.id === id);
                    if (t) { t.scheduleDate = date; saveState(); renderCurrentView(); }
                } else {
                    const ev = state.events.find(e => e.id === id);
                    if (ev) { ev.date = date; saveState(); renderCurrentView(); }
                }
                close();
                showToast('移動しました');
            };

            document.getElementById('dnd-copy').onclick = () => {
                if (type === 'task') {
                    const t = state.tasks.find(t => t.id === id);
                    if (t) {
                        state.tasks.push(Object.assign({}, t, { id: genId(), scheduleDate: date }));
                        saveState(); renderCurrentView(); scheduleAlarms();
                    }
                } else {
                    const ev = state.events.find(e => e.id === id);
                    if (ev) {
                        state.events.push(Object.assign({}, ev, { id: genId(), date: date }));
                        saveState(); renderCurrentView();
                    }
                }
                close();
                showToast('コピーしました');
            };

            document.getElementById('dnd-cancel').onclick = close;
            document.getElementById('dnd-modal-close').onclick = close;
            modal.classList.add('active');
        },

        cancel() {
            clearTimeout(this.longPressTimer);
            if (this.clone) { this.clone.remove(); this.clone = null; }
            if (this.originalEl) { this.originalEl.classList.remove('drag-active'); this.originalEl = null; }
            if (this.currentDropZone) { this.currentDropZone.classList.remove('drop-zone-highlight'); this.currentDropZone = null; }
            document.body.classList.remove('drag-in-progress');
            this.active = false;
            this.currentDropDate = null;
            this.pendingId = null;
            this.pendingType = null;
        },
    };

    // ===== Date Helpers =====
    function today() { return dateStr(new Date()); }

    function dateStr(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function parseDate(str) {
        const [y,m,d] = str.split('-').map(Number);
        return new Date(y, m-1, d);
    }

    function addDays(d, n) {
        const r = new Date(d);
        r.setDate(r.getDate() + n);
        return r;
    }

    function getMonday(d) {
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.getFullYear(), d.getMonth(), diff);
    }

    function formatDateShort(str) {
        const d = parseDate(str);
        return `${d.getMonth()+1}/${d.getDate()}`;
    }

    function formatDateFull(str) {
        const d = parseDate(str);
        const days = ['日','月','火','水','木','金','土'];
        return `${d.getMonth()+1}月${d.getDate()}日(${days[d.getDay()]})`;
    }

    function getDayName(d) {
        return ['日','月','火','水','木','金','土'][d.getDay()];
    }

    function getWeekDates(offset) {
        const monday = getMonday(new Date());
        monday.setDate(monday.getDate() + offset * 7);
        return Array.from({length:7}, (_,i) => addDays(monday, i));
    }

    // ===== Notifications =====
    // ===== Notification & Alarm System =====
    const REPEAT_INTERVALS_MS = [
        15 * 60 * 1000,   // 15分後
        30 * 60 * 1000,   // さらに30分後
        60 * 60 * 1000,   // さらに1時間後
        60 * 60 * 1000,   // さらに1時間後
    ];

    async function registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        try {
            await navigator.serviceWorker.register('/taskflow/sw.js', { scope: '/taskflow/' });
            navigator.serviceWorker.addEventListener('message', e => {
                if (e.data && e.data.type === 'MARK_DONE' && e.data.taskId) {
                    const t = state.tasks.find(t => t.id === e.data.taskId);
                    if (t && !t.completed) {
                        t.completed = true;
                        saveState();
                        renderCurrentView();
                        showToast('タスクを完了しました');
                    }
                }
            });
        } catch (err) { /* SW not available */ }
    }

    function updateNotifStatusUI() {
        const el = document.getElementById('notif-status');
        const btn = document.getElementById('notif-enable-btn');
        if (!el) return;
        if (!('Notification' in window)) {
            el.textContent = 'この端末は非対応';
            el.className = 'sync-status sync-error';
            if (btn) btn.style.display = 'none';
            return;
        }
        const p = Notification.permission;
        if (p === 'granted') {
            el.textContent = '✅ 許可済み';
            el.className = 'sync-status sync-on';
            if (btn) btn.textContent = '🔔 通知テストを送る';
        } else if (p === 'denied') {
            el.textContent = '❌ ブロック中 (設定アプリから変更)';
            el.className = 'sync-status sync-error';
            if (btn) btn.style.display = 'none';
        } else {
            el.textContent = '未許可';
            el.className = 'sync-status sync-off';
            if (btn) { btn.textContent = '🔔 通知を許可する'; btn.style.display = ''; }
        }
    }

    async function requestNotificationPermission() {
        // SW registration (safe to call on load — no permission prompt)
        registerServiceWorker();
        updateNotifStatusUI();
    }

    async function enableNotifications() {
        if (!('Notification' in window)) {
            alert('この端末はWeb通知に対応していません。');
            return;
        }
        if (Notification.permission === 'granted') {
            // Send a test notification
            fireNotification({
                id: 'test',
                title: 'テスト通知',
                scheduleDate: today(),
                time: '',
                alarm: 'ontime',
            }, false);
            showToast('テスト通知を送りました');
            return;
        }
        if (Notification.permission === 'denied') {
            alert('通知がブロックされています。\niPhoneの場合:「設定」→「Safari」→「通知」または「設定」→「通知」→アプリ名からONにしてください。');
            return;
        }
        const result = await Notification.requestPermission();
        updateNotifStatusUI();
        if (result === 'granted') {
            scheduleAlarms();
            showToast('通知を許可しました！');
        } else {
            showToast('通知が許可されませんでした');
        }
    }

    function getAlarmTime(task) {
        if (!task.scheduleDate || !task.time) return null;
        const d = parseDate(task.scheduleDate);
        const [h, m] = task.time.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        const offsets = { ontime: 0, '5min': 5, '15min': 15, '30min': 30, '1hour': 60, '1day': 1440 };
        d.setMinutes(d.getMinutes() - (offsets[task.alarm] || 0));
        return d;
    }

    function fireNotification(task, isRepeat = false) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const prefix = isRepeat ? '🔔 再通知: ' : '🔔 ';
        const body = `${formatDateFull(task.scheduleDate)} ${task.time || ''}`.trim();
        // Try via Service Worker (works when app is backgrounded on iOS PWA)
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({
                type: 'SHOW_NOTIFICATION',
                title: prefix + task.title,
                body,
                taskId: task.id,
            });
        }
        // Also fire direct notification (works when app is open)
        try {
            new Notification(prefix + task.title, {
                body,
                tag: task.id,
                requireInteraction: true,
                vibrate: [200, 100, 200],
            });
        } catch (e) { /* ignore */ }
    }

    function scheduleAlarms() {
        if (window._alarmTimers) window._alarmTimers.forEach(t => clearTimeout(t));
        window._alarmTimers = [];
        if (!('Notification' in window) || Notification.permission !== 'granted') return;

        const now = new Date();

        // Check missed alarms (fired while app was closed)
        const missedKey = 'taskflow_alarm_fired';
        const firedMap = JSON.parse(localStorage.getItem(missedKey) || '{}');

        state.tasks.forEach(task => {
            if (task.completed || !task.alarm || task.alarm === 'none') return;
            const alarmTime = getAlarmTime(task);
            if (!alarmTime) return;

            const alarmMs = alarmTime.getTime();
            const nowMs = now.getTime();
            const lastFired = firedMap[task.id] || 0;

            if (alarmMs <= nowMs) {
                // Alarm already passed
                if (!task.completed && lastFired === 0) {
                    // Missed alarm — notify now
                    firedMap[task.id] = alarmMs;
                    localStorage.setItem(missedKey, JSON.stringify(firedMap));
                    setTimeout(() => fireNotification(task, false), 500);
                    scheduleRepeat(task, 0, firedMap);
                } else if (!task.completed && lastFired > 0) {
                    // Already fired, check if repeat is due
                    scheduleRepeat(task, 0, firedMap);
                }
            } else if (alarmMs - nowMs < 24 * 60 * 60 * 1000) {
                // Future alarm within 24h — schedule it
                const diff = alarmMs - nowMs;
                window._alarmTimers.push(setTimeout(() => {
                    firedMap[task.id] = alarmMs;
                    localStorage.setItem(missedKey, JSON.stringify(firedMap));
                    fireNotification(task, false);
                    scheduleRepeat(task, 0, firedMap);
                }, diff));
            }
        });

        // Clean up fired map (remove completed or non-existent tasks)
        const taskIds = new Set(state.tasks.map(t => t.id));
        Object.keys(firedMap).forEach(id => {
            const t = state.tasks.find(t => t.id === id);
            if (!t || t.completed) delete firedMap[id];
        });
        localStorage.setItem(missedKey, JSON.stringify(firedMap));
    }

    function scheduleRepeat(task, repeatIndex, firedMap) {
        if (task.completed) return;
        if (repeatIndex >= REPEAT_INTERVALS_MS.length) return;

        const delay = REPEAT_INTERVALS_MS[repeatIndex];
        window._alarmTimers = window._alarmTimers || [];
        window._alarmTimers.push(setTimeout(() => {
            // Re-check if still incomplete
            const t = state.tasks.find(t => t.id === task.id);
            if (!t || t.completed) return;
            fireNotification(t, true);
            scheduleRepeat(t, repeatIndex + 1, firedMap);
        }, delay));
    }

    // ===== DOM Helpers =====
    const $ = sel => document.querySelector(sel);
    const $$ = sel => document.querySelectorAll(sel);

    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k,v] of Object.entries(attrs)) {
            if (k === 'className') e.className = v;
            else if (k === 'textContent') e.textContent = v;
            else if (k === 'innerHTML') e.innerHTML = v;
            else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k === 'draggable') e.draggable = v;
            else e.setAttribute(k, v);
        }
        children.forEach(c => {
            if (typeof c === 'string') e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        });
        return e;
    }

    function getCategoryById(id) { return state.categories.find(c => c.id === id); }

    // Get tasks by schedule date (for weekly view)
    function getItemsByScheduleDate(ds) {
        const tasks = state.tasks
            .filter(t => t.scheduleDate === ds)
            .sort((a,b) => {
                const p = {urgent:0, high:1, medium:2, low:3};
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                return (p[a.priority]||2) - (p[b.priority]||2);
            });
        const events = state.events
            .filter(ev => ev.date === ds)
            .sort((a,b) => (a.time||'').localeCompare(b.time||''));
        return { tasks, events };
    }

    // Get tasks by deadline (for calendar deadline view)
    function getTasksByDeadline(ds) {
        return state.tasks
            .filter(t => t.deadline === ds)
            .sort((a,b) => {
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                return 0;
            });
    }

    function getTasksByCategory(catId) {
        return state.tasks
            .filter(t => t.categories && t.categories.includes(catId))
            .sort((a,b) => {
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                return (a.deadline||'').localeCompare(b.deadline||'');
            });
    }

    function getOverdueTasks() {
        const td = today();
        return state.tasks
            .filter(t => !t.completed && t.deadline && t.deadline < td)
            .sort((a,b) => a.deadline.localeCompare(b.deadline));
    }

    // Unfinished tasks from past schedule dates (not today)
    function getCarryoverTasks() {
        const td = today();
        return state.tasks
            .filter(t => !t.completed && t.scheduleDate && t.scheduleDate < td)
            .sort((a,b) => a.scheduleDate.localeCompare(b.scheduleDate));
    }

    // ===== Copy Task =====
    function copyTask(id) {
        const t = state.tasks.find(t => t.id === id);
        if (!t) return;
        const copy = {
            ...t,
            id: genId(),
            title: t.title + ' (コピー)',
            completed: false,
            createdAt: new Date().toISOString(),
            categories: [...(t.categories||[])],
        };
        state.tasks.push(copy);
        saveState();
        showToast('タスクをコピーしました');
        renderCurrentView();
    }

    function copyEvent(id) {
        const ev = state.events.find(e => e.id === id);
        if (!ev) return;
        const copy = {
            ...ev,
            id: genId(),
            title: ev.title + ' (コピー)',
            createdAt: new Date().toISOString(),
        };
        state.events.push(copy);
        saveState();
        showToast('予定をコピーしました');
        renderCurrentView();
    }

    // ===== Toast =====
    function showToast(msg) {
        const toast = $('#toast');
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(window._toastTimer);
        window._toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
    }

    // ===== Render Task Item (compact for columns) =====
    function renderTaskItem(task) {
        const cats = (task.categories||[]).map(getCategoryById).filter(Boolean);
        const pClass = `priority-${task.priority||'medium'}`;
        const td = today();

        const metaChildren = [];
        cats.forEach(cat => {
            metaChildren.push(el('span', {
                className: 'task-category-tag',
                textContent: '#'+cat.name,
                style: { background: cat.color+'1A', color: cat.color },
            }));
        });
        if (task.deadline) {
            const isOverdue = !task.completed && task.deadline < td;
            metaChildren.push(el('span', {
                className: `task-deadline-tag ${isOverdue ? 'overdue' : ''}`,
                textContent: '〆 '+formatDateShort(task.deadline),
            }));
        }
        if (task.alarm && task.alarm !== 'none') metaChildren.push(el('span', { className:'task-alarm-icon', textContent:'🔔' }));
        if (task.memo) metaChildren.push(el('span', { className:'task-memo-icon', textContent:'📝' }));

        const item = el('div', {
            className: `task-item ${pClass} ${task.completed?'completed':''}`,
            draggable: true,
            'data-item-id': task.id,
            'data-item-type': 'task',
            onDragstart: e => { draggedItemId = {id:task.id,type:'task'}; e.dataTransfer.effectAllowed='move'; e.target.classList.add('dragging'); },
            onDragend: e => { e.target.classList.remove('dragging'); draggedItemId=null; },
        }, [
            el('div', { className:'task-item-header' }, [
                el('div', {
                    className: `task-checkbox ${task.completed?'checked':''}`,
                    onClick: e => { e.stopPropagation(); toggleTask(task.id); },
                }),
                el('span', { className:'task-title', textContent: task.title }),
                el('span', { className:'task-priority-dot' }),
            ]),
            metaChildren.length > 0 ? el('div', { className:'task-meta' }, metaChildren) : null,
            el('div', { className:'task-actions' }, [
                el('button', { className:'task-action-btn', textContent:'📋', title:'コピー', onClick: e => { e.stopPropagation(); copyTask(task.id); } }),
                el('button', { className:'task-action-btn', textContent:'✏️', title:'編集', onClick: e => { e.stopPropagation(); openEditTask(task.id); } }),
                el('button', { className:'task-action-btn', textContent:'📅', title:'移動', onClick: e => { e.stopPropagation(); openMoveModal(task.id,'task'); } }),
            ]),
        ]);
        item.addEventListener('click', () => openEditTask(task.id));
        TouchDnD.bindItem(item, task.id, 'task');
        return item;
    }

    function renderEventItem(ev) {
        const item = el('div', {
            className: 'event-item',
            draggable: true,
            'data-item-id': ev.id,
            'data-item-type': 'event',
            onDragstart: e => { draggedItemId = {id:ev.id,type:'event'}; e.dataTransfer.effectAllowed='move'; e.target.classList.add('dragging'); },
            onDragend: e => { e.target.classList.remove('dragging'); draggedItemId=null; },
        }, [
            el('div', { className:'task-item-header' }, [
                el('span', { textContent: ev.time ? ev.time+' ' : '', style:{color:'var(--sky)',fontWeight:'600',fontSize:'0.75rem'} }),
                el('span', { className:'task-title', textContent: ev.title }),
            ]),
            ev.memo ? el('div', { className:'task-meta' }, [el('span', { className:'task-memo-icon', textContent:'📝' })]) : null,
            el('div', { className:'task-actions' }, [
                el('button', { className:'task-action-btn', textContent:'📋', title:'コピー', onClick: e => { e.stopPropagation(); copyEvent(ev.id); } }),
                el('button', { className:'task-action-btn', textContent:'✏️', onClick: e => { e.stopPropagation(); openEditEvent(ev.id); } }),
                el('button', { className:'task-action-btn', textContent:'📅', onClick: e => { e.stopPropagation(); openMoveModal(ev.id,'event'); } }),
            ]),
        ]);
        item.addEventListener('click', () => openEditEvent(ev.id));
        TouchDnD.bindItem(item, ev.id, 'event');
        return item;
    }

    // ===== Render Weekly View =====
    function renderWeeklyView() {
        const dates = getWeekDates(currentWeekOffset);
        const td = today();
        const tmr = dateStr(addDays(new Date(), 1));

        $('#week-range').textContent = `${formatDateShort(dateStr(dates[0]))} ~ ${formatDateShort(dateStr(dates[6]))}`;

        // Carryover section
        renderCarryoverSection();

        // Today / Tomorrow
        $('#today-date').textContent = formatDateFull(td);
        $('#tomorrow-date').textContent = formatDateFull(tmr);
        $('#today-tasks').setAttribute('data-date', td);
        $('#tomorrow-tasks').setAttribute('data-date', tmr);

        renderScheduleList($('#today-tasks'), td);
        renderScheduleList($('#tomorrow-tasks'), tmr);
        setupDropZone($('#today-tasks'), td);
        setupDropZone($('#tomorrow-tasks'), tmr);

        // Columns
        const container = $('#weekly-columns');
        container.innerHTML = '';
        dates.forEach(d => {
            const ds = dateStr(d);
            const isToday = ds === td;
            const isPast = ds < td;

            const dayBody = el('div', { className:'day-body', 'data-date': ds });
            const {tasks, events} = getItemsByScheduleDate(ds);
            events.forEach(ev => dayBody.appendChild(renderEventItem(ev)));
            tasks.forEach(t => dayBody.appendChild(renderTaskItem(t)));
            if (tasks.length === 0 && events.length === 0) {
                dayBody.appendChild(el('div', { style:{textAlign:'center',padding:'10px 0',color:'var(--text-muted)',fontSize:'0.72rem'}, textContent:'なし' }));
            }
            setupDropZone(dayBody, ds);

            const col = el('div', { className:`day-column ${isToday?'is-today':''} ${isPast?'is-past':''}` }, [
                el('div', { className:'day-header', onClick: () => { addFromDate = ds; openAddModal(); } }, [
                    el('div', { className:'day-name', textContent: getDayName(d) }),
                    el('div', { className:'day-number', textContent: String(d.getDate()) }),
                ]),
                dayBody,
            ]);
            container.appendChild(col);
        });

        // Mini calendar
        renderMiniCalendar();
    }

    function renderScheduleList(container, ds) {
        container.innerHTML = '';
        const {tasks, events} = getItemsByScheduleDate(ds);
        if (tasks.length === 0 && events.length === 0) {
            container.appendChild(el('div', { style:{textAlign:'center',padding:'6px 0',color:'var(--text-muted)',fontSize:'0.78rem'}, textContent:'なし' }));
            return;
        }
        events.forEach(ev => container.appendChild(renderEventItem(ev)));
        tasks.forEach(t => container.appendChild(renderTaskItem(t)));
    }

    function renderCarryoverSection() {
        const section = $('#carryover-section');
        const carryover = getCarryoverTasks();

        if (carryover.length === 0) {
            section.style.display = 'none';
            section.innerHTML = '';
            return;
        }

        section.style.display = '';
        section.innerHTML = '';

        // Banner
        const banner = el('div', { className:'carryover-banner' }, [
            el('span', { className:'carryover-banner-icon', textContent:'⚡' }),
            el('span', {}, [
                document.createTextNode('未完了のタスク'),
                el('span', { className:'carryover-banner-count', textContent: String(carryover.length) }),
            ]),
            el('div', { className:'carryover-actions' }, [
                el('button', {
                    className:'carryover-btn move-all',
                    textContent:'すべて今日に移動',
                    onClick: () => {
                        const td = today();
                        carryover.forEach(t => { t.scheduleDate = td; });
                        saveState();
                        showToast(`${carryover.length}件のタスクを今日に移動しました`);
                        renderCurrentView();
                    },
                }),
            ]),
        ]);
        section.appendChild(banner);

        // List
        const list = el('div', { className:'carryover-list' });
        carryover.forEach(t => {
            const cats = (t.categories||[]).map(getCategoryById).filter(Boolean);
            const catTags = cats.map(c => el('span', {
                className:'task-category-tag',
                textContent:'#'+c.name,
                style:{background:c.color+'1A',color:c.color,fontSize:'0.64rem'},
            }));

            list.appendChild(el('div', { className:'carryover-item', onClick: () => openEditTask(t.id) }, [
                el('div', {
                    className: `task-checkbox ${t.completed?'checked':''}`,
                    onClick: e => { e.stopPropagation(); toggleTask(t.id); },
                }),
                el('span', { textContent: t.title, style:{flex:'1',fontSize:'0.82rem'} }),
                ...catTags,
                el('span', { className:'carryover-from', textContent: formatDateShort(t.scheduleDate) + 'から' }),
                el('div', { className:'carryover-item-actions' }, [
                    el('button', {
                        className:'carryover-move-btn',
                        textContent:'今日へ',
                        onClick: e => {
                            e.stopPropagation();
                            t.scheduleDate = today();
                            saveState();
                            showToast('今日に移動しました');
                            renderCurrentView();
                        },
                    }),
                    el('button', {
                        className:'task-action-btn',
                        textContent:'📋',
                        title:'コピー',
                        style:{width:'20px',height:'20px'},
                        onClick: e => { e.stopPropagation(); copyTask(t.id); },
                    }),
                ]),
            ]));
        });
        section.appendChild(list);
    }

    function setupDropZone(element, ds) {
        element.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; element.classList.add('drag-over'); });
        element.addEventListener('dragleave', () => element.classList.remove('drag-over'));
        element.addEventListener('drop', e => {
            e.preventDefault();
            element.classList.remove('drag-over');
            if (!draggedItemId) return;
            const id = draggedItemId.id;
            const type = draggedItemId.type;
            draggedItemId = null;
            // Show copy/move dialog for PC drag too
            TouchDnD._showDialog(id, type, ds);
        });
    }

    // ===== Calendar Rendering (shared) =====
    function renderCalendarGrid(gridEl, monthOffset, mode) {
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const year = target.getFullYear();
        const month = target.getMonth();
        const td = today();

        gridEl.innerHTML = '';
        ['月','火','水','木','金','土','日'].forEach(n => {
            gridEl.appendChild(el('div', { className:'calendar-day-header', textContent: n }));
        });

        const firstDay = new Date(year, month, 1);
        let startDay = firstDay.getDay() - 1;
        if (startDay < 0) startDay = 6;
        const daysInMonth = new Date(year, month+1, 0).getDate();
        const daysInPrev = new Date(year, month, 0).getDate();
        const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;

        for (let i = 0; i < totalCells; i++) {
            let dayNum, ds, isOther = false;
            if (i < startDay) {
                dayNum = daysInPrev - startDay + i + 1;
                ds = dateStr(new Date(year, month-1, dayNum));
                isOther = true;
            } else if (i >= startDay + daysInMonth) {
                dayNum = i - startDay - daysInMonth + 1;
                ds = dateStr(new Date(year, month+1, dayNum));
                isOther = true;
            } else {
                dayNum = i - startDay + 1;
                ds = dateStr(new Date(year, month, dayNum));
            }

            const isToday = ds === td;
            const dayEl = el('div', {
                className: `calendar-day ${isOther?'other-month':''} ${isToday?'is-today':''}`,
                onClick: () => { addFromDate = ds; openAddModal(); },
            }, [
                el('div', { className:'calendar-day-number', textContent: String(dayNum) }),
            ]);

            // Get items based on mode
            let items = [];
            if (mode === 'deadline') {
                items = getTasksByDeadline(ds).map(t => ({
                    title: t.title, color: getTaskColor(t), completed: t.completed, id: t.id, type: 'task'
                }));
            } else {
                const {tasks, events} = getItemsByScheduleDate(ds);
                events.forEach(ev => items.push({ title: (ev.time?ev.time+' ':'')+ev.title, color: 'var(--sky)', completed: false, id: ev.id, type: 'event' }));
                tasks.forEach(t => items.push({ title: t.title, color: getTaskColor(t), completed: t.completed, id: t.id, type: 'task' }));
            }

            const maxShow = 3;
            items.slice(0, maxShow).forEach(item => {
                const isEvent = item.type === 'event';
                dayEl.appendChild(el('div', {
                    className: isEvent ? 'calendar-event-dot' : 'calendar-task-dot',
                    textContent: item.title,
                    style: isEvent ? {} : { background: item.color+'22', color: item.color, textDecoration: item.completed?'line-through':'none' },
                    onClick: e => {
                        e.stopPropagation();
                        if (item.type === 'task') openEditTask(item.id);
                        else openEditEvent(item.id);
                    },
                }));
            });
            if (items.length > maxShow) {
                dayEl.appendChild(el('div', { className:'calendar-task-more', textContent:`+${items.length-maxShow}件` }));
            }

            setupDropZone(dayEl, ds);
            gridEl.appendChild(dayEl);
        }

        return `${year}年 ${month+1}月`;
    }

    function getTaskColor(t) {
        const cats = (t.categories||[]).map(getCategoryById).filter(Boolean);
        return cats.length > 0 ? cats[0].color : 'var(--accent)';
    }

    // ===== Render Calendar View =====
    function renderCalendarView() {
        const label = renderCalendarGrid($('#calendar-grid'), currentMonthOffset, calendarMode);
        $('#calendar-month').textContent = label;
    }

    // ===== Render Mini Calendar (bottom of weekly) =====
    function renderMiniCalendar() {
        const label = renderCalendarGrid($('#mini-calendar-grid'), miniMonthOffset, miniCalMode);
        $('#mini-cal-month').textContent = label;
    }

    // ===== Render Categories View =====
    function renderCategoriesView() {
        const container = $('#categories-content');
        container.innerHTML = '';

        if (state.categories.length === 0) {
            container.appendChild(el('div', { className:'empty-state' }, [
                el('div', { className:'empty-state-icon', textContent:'📁' }),
                el('div', { className:'empty-state-text', textContent:'カテゴリーがありません' }),
            ]));
            return;
        }

        state.categories.forEach(cat => {
            const tasks = getTasksByCategory(cat.id);
            const section = el('div', { className:'category-section' }, [
                el('div', { className:'category-header' }, [
                    el('div', { className:'category-header-dot', style:{background:cat.color} }),
                    el('span', { className:'category-header-title', textContent: cat.name }),
                    el('span', { className:'category-header-count', textContent:`${tasks.length}件` }),
                    el('button', {
                        className:'category-action-btn', textContent:'✏️', title:'編集',
                        onClick: () => openEditCategory(cat.id),
                    }),
                    el('button', {
                        className:'category-action-btn delete', textContent:'🗑️', title:'削除',
                        onClick: () => deleteCategory(cat.id),
                    }),
                ]),
            ]);

            const taskList = el('div', { className:'category-task-list' });
            if (tasks.length > 0) {
                tasks.forEach(t => {
                    const pColors = {urgent:'var(--urgent)',high:'var(--peach)',medium:'var(--accent)',low:'var(--mint)'};
                    taskList.appendChild(el('div', {
                        className:'category-task-item',
                        onClick: () => openEditTask(t.id),
                    }, [
                        el('div', {
                            className: `task-checkbox ${t.completed?'checked':''}`,
                            onClick: e => { e.stopPropagation(); toggleTask(t.id); },
                        }),
                        el('span', {
                            style: { width:'8px',height:'8px',borderRadius:'50%',background:pColors[t.priority]||pColors.medium,flexShrink:'0' },
                        }),
                        el('span', {
                            textContent: t.title,
                            style: { flex:'1', textDecoration:t.completed?'line-through':'none', color:t.completed?'var(--text-muted)':'var(--text-primary)' },
                        }),
                        t.deadline ? el('span', { className:'category-task-date', textContent:'〆 '+formatDateShort(t.deadline) }) : null,
                        t.scheduleDate ? el('span', { className:'category-task-date', textContent:'予 '+formatDateShort(t.scheduleDate) }) : null,
                    ]));
                });
            }

            // Add task button in category
            taskList.appendChild(el('button', {
                className:'category-add-btn',
                textContent:'+ タスク追加',
                onClick: () => { addFromCategory = cat.id; openAddModal(); },
            }));

            section.appendChild(taskList);
            container.appendChild(section);
        });
    }

    // ===== Render Overdue View =====
    function renderOverdueView() {
        const container = $('#overdue-content');
        container.innerHTML = '';
        const tasks = getOverdueTasks();

        if (tasks.length === 0) {
            container.appendChild(el('div', { className:'empty-state' }, [
                el('div', { className:'empty-state-icon', textContent:'🎉' }),
                el('div', { className:'empty-state-text', textContent:'未達成のタスクはありません！' }),
            ]));
        } else {
            tasks.forEach(t => {
                const cats = (t.categories||[]).map(getCategoryById).filter(Boolean);
                const meta = [];
                cats.forEach(c => meta.push(el('span', { className:'task-category-tag', textContent:'#'+c.name, style:{background:c.color+'1A',color:c.color} })));

                container.appendChild(el('div', { className:'overdue-task-item' }, [
                    el('div', { className:`task-checkbox ${t.completed?'checked':''}`, onClick:()=>toggleTask(t.id) }),
                    el('div', { style:{flex:'1'} }, [
                        el('div', { textContent:t.title, style:{fontWeight:'500'} }),
                        meta.length>0 ? el('div', { style:{display:'flex',gap:'5px',marginTop:'3px'} }, meta) : null,
                    ]),
                    el('span', { className:'overdue-date', textContent:'期限: '+formatDateFull(t.deadline) }),
                    el('div', { className:'overdue-actions' }, [
                        el('button', {
                            className:'btn-secondary', textContent:'今日に移動',
                            style:{padding:'3px 10px',fontSize:'0.72rem'},
                            onClick: () => { t.scheduleDate = today(); saveState(); renderCurrentView(); },
                        }),
                        el('button', { className:'task-action-btn', textContent:'✏️', onClick:()=>openEditTask(t.id) }),
                    ]),
                ]));
            });
        }

        const badge = $('#overdue-badge');
        if (tasks.length > 0) { badge.style.display = 'inline'; badge.textContent = tasks.length; }
        else { badge.style.display = 'none'; }
    }

    // ===== Sidebar Categories =====
    function renderSidebarCategories() {
        const list = $('#category-list');
        list.innerHTML = '';
        state.categories.forEach(cat => {
            const count = getTasksByCategory(cat.id).filter(t=>!t.completed).length;
            list.appendChild(el('li', {
                className:'category-nav-item',
                onClick: () => {
                    switchView('categories');
                    setTimeout(() => {
                        const sections = $$('.category-section');
                        const idx = state.categories.findIndex(c=>c.id===cat.id);
                        if (sections[idx]) sections[idx].scrollIntoView({behavior:'smooth'});
                    }, 50);
                },
            }, [
                el('span', { className:'category-dot', style:{background:cat.color} }),
                el('span', { textContent:cat.name }),
                el('span', { className:'category-count', textContent:String(count) }),
            ]));
        });
    }

    // ===== View Switching =====
    function scrollViewToTop() {
        const activeView = document.querySelector('.view.active');
        if (activeView) activeView.scrollTop = 0;
        // Also reset window scroll (iOS fallback)
        try { window.scrollTo(0, 0); } catch {}
    }

    function switchView(view) {
        currentView = view;
        $$('.view').forEach(v => v.classList.remove('active'));
        $$('.nav-item').forEach(n => n.classList.remove('active'));
        $(`#${view}-view`).classList.add('active');
        $(`.nav-item[data-view="${view}"]`).classList.add('active');
        const titles = {weekly:'ウィークリー',calendar:'カレンダー',categories:'カテゴリー',overdue:'未達成タスク'};
        $('#view-title').textContent = titles[view]||'';
        renderCurrentView();
        scrollViewToTop();
    }

    function renderCurrentView() {
        renderOverdueView();
        renderSidebarCategories();
        switch(currentView) {
            case 'weekly': renderWeeklyView(); break;
            case 'calendar': renderCalendarView(); break;
            case 'categories': renderCategoriesView(); break;
        }
    }

    // ===== Task CRUD =====
    function addTask(data) {
        state.tasks.push({
            id: genId(),
            title: data.title,
            scheduleDate: data.scheduleDate || '',
            deadline: data.deadline || '',
            time: data.time || '',
            priority: data.priority || 'medium',
            alarm: data.alarm || 'none',
            memo: data.memo || '',
            categories: data.categories || [],
            completed: false,
            createdAt: new Date().toISOString(),
        });
        saveState(); scheduleAlarms(); renderCurrentView();
    }

    function updateTask(id, data) {
        const idx = state.tasks.findIndex(t=>t.id===id);
        if (idx===-1) return;
        Object.assign(state.tasks[idx], data);
        saveState(); scheduleAlarms(); renderCurrentView();
    }

    function deleteTask(id) {
        state.tasks = state.tasks.filter(t=>t.id!==id);
        saveState(); renderCurrentView();
    }

    function toggleTask(id) {
        const t = state.tasks.find(t=>t.id===id);
        if (t) { t.completed = !t.completed; saveState(); renderCurrentView(); }
    }

    // ===== Event CRUD =====
    function addEvent(data) {
        state.events.push({
            id: genId(),
            title: data.title,
            date: data.date || '',
            time: data.time || '',
            memo: data.memo || '',
            createdAt: new Date().toISOString(),
        });
        saveState(); renderCurrentView();
    }

    function updateEvent(id, data) {
        const idx = state.events.findIndex(e=>e.id===id);
        if (idx===-1) return;
        Object.assign(state.events[idx], data);
        saveState(); renderCurrentView();
    }

    function deleteEvent(id) {
        state.events = state.events.filter(e=>e.id!==id);
        saveState(); renderCurrentView();
    }

    // ===== Category CRUD =====
    function addCategoryToState(name, color) {
        if (state.categories.find(c=>c.name===name)) return null;
        const cat = { id: genId(), name, color };
        state.categories.push(cat);
        saveState(); renderCurrentView();
        return cat;
    }

    function updateCategory(id, name, color) {
        const cat = state.categories.find(c=>c.id===id);
        if (!cat) return;
        cat.name = name;
        cat.color = color;
        saveState(); renderCurrentView();
    }

    function deleteCategory(id) {
        if (!confirm('このカテゴリーを削除しますか？')) return;
        state.categories = state.categories.filter(c=>c.id!==id);
        state.tasks.forEach(t => { if (t.categories) t.categories = t.categories.filter(c=>c!==id); });
        saveState(); renderCurrentView();
    }

    // ===== Modal Logic =====
    function resetModal() {
        editingItemId = null;
        currentItemType = 'task';
        selectedCategories = [];
        addFromCategory = null;
        addFromDate = null;
        $('#task-form').reset();
        $('#task-fields').style.display = '';
        $('#event-fields').style.display = 'none';
        $$('.type-option').forEach(o => o.classList.remove('active'));
        $('.type-option[data-type="task"]').classList.add('active');
        $('#delete-task-btn').style.display = 'none';
        renderSelectedCategories();
    }

    function openAddModal() {
        resetModal();
        $('#modal-title').textContent = '追加';

        // Pre-fill schedule date if from weekly
        if (addFromDate) {
            $('#task-schedule-date').value = addFromDate;
            $('#event-date').value = addFromDate;
        } else {
            $('#task-schedule-date').value = today();
            $('#event-date').value = today();
        }

        // Pre-fill category if from category view
        if (addFromCategory) {
            selectedCategories = [addFromCategory];
            renderSelectedCategories();
        }

        $('#task-modal').classList.add('active');
        setTimeout(() => $('#task-title').focus(), 80);
    }

    function openEditTask(id) {
        const task = state.tasks.find(t=>t.id===id);
        if (!task) return;
        resetModal();
        editingItemId = id;
        currentItemType = 'task';
        $('#modal-title').textContent = 'タスク編集';
        $('#task-title').value = task.title;
        $('#task-schedule-date').value = task.scheduleDate || '';
        $('#task-deadline').value = task.deadline || '';
        $('#task-time').value = task.time || '';
        $('#task-priority').value = task.priority;
        $('#task-alarm').value = task.alarm;
        $('#task-memo').value = task.memo || '';
        selectedCategories = [...(task.categories||[])];
        renderSelectedCategories();
        $('#delete-task-btn').style.display = 'block';
        $('#task-modal').classList.add('active');
    }

    function openEditEvent(id) {
        const ev = state.events.find(e=>e.id===id);
        if (!ev) return;
        resetModal();
        editingItemId = id;
        currentItemType = 'event';
        $('#modal-title').textContent = '予定編集';
        setItemType('event');
        $('#task-title').value = ev.title;
        $('#event-date').value = ev.date || '';
        $('#event-time').value = ev.time || '';
        $('#task-memo').value = ev.memo || '';
        $('#delete-task-btn').style.display = 'block';
        $('#task-modal').classList.add('active');
    }

    function setItemType(type) {
        currentItemType = type;
        $$('.type-option').forEach(o => o.classList.remove('active'));
        $(`.type-option[data-type="${type}"]`).classList.add('active');
        $('#task-fields').style.display = type === 'task' ? '' : 'none';
        $('#event-fields').style.display = type === 'event' ? '' : 'none';
    }

    function closeModal(id) { $(id).classList.remove('active'); }

    function openMoveModal(id, type) {
        editingItemId = id;
        currentItemType = type;
        if (type === 'task') {
            const t = state.tasks.find(t=>t.id===id);
            $('#move-date').value = t ? (t.scheduleDate||today()) : today();
        } else {
            const e = state.events.find(e=>e.id===id);
            $('#move-date').value = e ? (e.date||today()) : today();
        }
        $('#move-modal').classList.add('active');
    }

    function openAddCategory() {
        editingCategoryId = null;
        $('#category-modal-title').textContent = 'カテゴリー追加';
        $('#category-submit-btn').textContent = '追加';
        $('#category-form').reset();
        $$('.color-option').forEach(o => o.classList.remove('selected'));
        $('.color-option').classList.add('selected');
        $('#category-modal').classList.add('active');
        setTimeout(() => $('#category-name').focus(), 80);
    }

    function openEditCategory(id) {
        const cat = getCategoryById(id);
        if (!cat) return;
        editingCategoryId = id;
        $('#category-modal-title').textContent = 'カテゴリー編集';
        $('#category-submit-btn').textContent = '保存';
        $('#category-name').value = cat.name;
        $$('.color-option').forEach(o => {
            o.classList.toggle('selected', o.dataset.color === cat.color);
        });
        $('#category-modal').classList.add('active');
    }

    // ===== Category Suggestions =====
    function renderSelectedCategories() {
        const container = $('#selected-categories');
        container.innerHTML = '';
        selectedCategories.forEach(catId => {
            const cat = getCategoryById(catId);
            if (!cat) return;
            container.appendChild(el('span', {
                className:'selected-category-tag',
                style: { background:cat.color+'1A', color:cat.color },
            }, [
                document.createTextNode('#'+cat.name),
                el('span', {
                    className:'remove-tag', textContent:'✕',
                    onClick: () => { selectedCategories = selectedCategories.filter(c=>c!==catId); renderSelectedCategories(); },
                }),
            ]));
        });
    }

    function showCategorySuggestions(query) {
        const container = $('#category-suggestions');
        container.innerHTML = '';
        const q = query.replace(/^#/,'').toLowerCase();
        const matches = state.categories.filter(c => c.name.toLowerCase().includes(q) && !selectedCategories.includes(c.id));

        if (q.length > 0 && matches.length === 0) {
            container.appendChild(el('div', {
                className:'category-suggestion-item',
                onClick: () => {
                    const newCat = addCategoryToState(q, '#7C8CF8');
                    if (newCat) { selectedCategories.push(newCat.id); renderSelectedCategories(); }
                    $('#task-category-input').value = '';
                    container.classList.remove('active');
                },
            }, [el('span', { textContent:`"${q}" を新規作成`, style:{color:'var(--accent)'} })]));
            container.classList.add('active');
            return;
        }

        if (matches.length === 0) { container.classList.remove('active'); return; }

        matches.forEach(cat => {
            container.appendChild(el('div', {
                className:'category-suggestion-item',
                onClick: () => {
                    selectedCategories.push(cat.id);
                    renderSelectedCategories();
                    $('#task-category-input').value = '';
                    container.classList.remove('active');
                },
            }, [
                el('span', { className:'category-dot', style:{background:cat.color} }),
                el('span', { textContent: cat.name }),
            ]));
        });
        container.classList.add('active');
    }

    // ===== ICS Generator (Apple Calendar export) =====
    function icsEscape(str) {
        return (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    }

    function icsDate(dateStr, timeStr) {
        if (!dateStr) return null;
        const d = parseDate(dateStr);
        if (timeStr) {
            const [h, m] = timeStr.split(':').map(Number);
            d.setHours(h, m, 0, 0);
            const pad = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
        }
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
    }

    function icsTrigger(alarmType) {
        const map = { ontime: 0, '5min': -5, '15min': -15, '30min': -30, '1hour': -60, '1day': -1440 };
        const mins = map[alarmType] || 0;
        if (mins === 0) return 'PT0S';
        return `-PT${Math.abs(mins)}M`;
    }

    function generateICS(filterCategoryIds, syncTasks, syncEvents) {
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//TaskFlow//JP',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH',
        ];
        const now = icsDate(today(), null);

        if (syncEvents) {
            state.events.forEach(ev => {
                const dt = icsDate(ev.date, ev.time);
                if (!dt) return;
                lines.push('BEGIN:VEVENT');
                lines.push(`UID:tf-event-${ev.id}@taskflow`);
                lines.push(`DTSTAMP:${now}T000000Z`);
                lines.push(`DTSTART${ev.time ? '' : ';VALUE=DATE'}:${dt}`);
                lines.push(`DTEND${ev.time ? '' : ';VALUE=DATE'}:${dt}`);
                lines.push(`SUMMARY:${icsEscape(ev.title)}`);
                if (ev.memo) lines.push(`DESCRIPTION:${icsEscape(ev.memo)}`);
                lines.push('END:VEVENT');
            });
        }

        if (syncTasks) {
            state.tasks.filter(t => {
                if (!filterCategoryIds || filterCategoryIds.length === 0) return true;
                return (t.categories || []).some(c => filterCategoryIds.includes(c));
            }).forEach(t => {
                lines.push('BEGIN:VTODO');
                lines.push(`UID:tf-task-${t.id}@taskflow`);
                lines.push(`DTSTAMP:${now}T000000Z`);
                lines.push(`SUMMARY:${icsEscape(t.title)}`);
                if (t.scheduleDate) {
                    const dt = icsDate(t.scheduleDate, t.time);
                    lines.push(`DTSTART${t.time ? '' : ';VALUE=DATE'}:${dt}`);
                }
                if (t.deadline) {
                    lines.push(`DUE;VALUE=DATE:${icsDate(t.deadline, null)}`);
                }
                lines.push(`STATUS:${t.completed ? 'COMPLETED' : 'NEEDS-ACTION'}`);
                const pmap = { urgent: 1, high: 3, medium: 5, low: 9 };
                lines.push(`PRIORITY:${pmap[t.priority] || 5}`);
                if (t.memo) lines.push(`DESCRIPTION:${icsEscape(t.memo)}`);
                // Alarm
                if (t.alarm && t.alarm !== 'none' && t.time) {
                    lines.push('BEGIN:VALARM');
                    lines.push('ACTION:AUDIO');
                    lines.push(`TRIGGER:${icsTrigger(t.alarm)}`);
                    lines.push(`DESCRIPTION:${icsEscape(t.title)}`);
                    lines.push('END:VALARM');
                }
                lines.push('END:VTODO');
            });
        }

        lines.push('END:VCALENDAR');
        return lines.join('\r\n');
    }

    function exportICS(filterCategoryIds, syncTasks, syncEvents) {
        const content = generateICS(filterCategoryIds, syncTasks, syncEvents);
        const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `taskflow_${today()}.ics`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ===== Google Calendar Module =====
    const GCAL_CFG_KEY = 'taskflow_gcal_clientid';
    const GCAL_SYNC_MAP_KEY = 'taskflow_gcal_syncmap'; // taskflowId -> googleEventId

    const GoogleCal = {
        clientId: null,
        accessToken: null,
        tokenExpiry: 0,
        syncing: false,

        loadClientId() {
            return localStorage.getItem(GCAL_CFG_KEY) || '';
        },

        saveClientId(id) {
            localStorage.setItem(GCAL_CFG_KEY, id);
            this.clientId = id;
        },

        getSyncMap() {
            try { return JSON.parse(localStorage.getItem(GCAL_SYNC_MAP_KEY) || '{}'); } catch { return {}; }
        },

        saveSyncMap(m) {
            localStorage.setItem(GCAL_SYNC_MAP_KEY, JSON.stringify(m));
        },

        isSignedIn() {
            return !!(this.accessToken && Date.now() < this.tokenExpiry);
        },

        async signIn() {
            const clientId = this.clientId || this.loadClientId();
            if (!clientId) { showToast('クライアントIDを入力してください'); return false; }
            if (typeof google === 'undefined' || !google.accounts) {
                showToast('Google SDKが読み込まれていません。ネット接続を確認してください。');
                return false;
            }
            return new Promise(resolve => {
                const client = google.accounts.oauth2.initTokenClient({
                    client_id: clientId,
                    scope: 'https://www.googleapis.com/auth/calendar.events',
                    callback: resp => {
                        if (resp.error) { showToast('サインイン失敗: ' + resp.error); resolve(false); return; }
                        this.accessToken = resp.access_token;
                        this.tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
                        this.updateUI();
                        resolve(true);
                    },
                });
                client.requestAccessToken({ prompt: '' });
            });
        },

        signOut() {
            if (this.accessToken && typeof google !== 'undefined') {
                try { google.accounts.oauth2.revoke(this.accessToken); } catch {}
            }
            this.accessToken = null;
            this.tokenExpiry = 0;
            this.updateUI();
            showToast('Googleカレンダーとの接続を切断しました');
        },

        async apiFetch(url, method = 'GET', body = null) {
            const opts = {
                method,
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
            };
            if (body) opts.body = JSON.stringify(body);
            const res = await fetch(url, opts);
            if (res.status === 401) { this.accessToken = null; this.updateUI(); throw new Error('再サインインが必要です'); }
            if (!res.ok) throw new Error(`API error ${res.status}`);
            if (res.status === 204) return null;
            return res.json();
        },

        taskToGEvent(task) {
            const cats = (task.categories || []).map(getCategoryById).filter(Boolean).map(c => c.name);
            const pad = n => String(n).padStart(2, '0');
            let start, end;
            if (task.time && task.scheduleDate) {
                // Timed event: both start and end must be dateTime
                start = { dateTime: `${task.scheduleDate}T${task.time}:00`, timeZone: 'Asia/Tokyo' };
                const endDt = new Date(`${task.scheduleDate}T${task.time}:00`);
                endDt.setHours(endDt.getHours() + 1);
                end = { dateTime: `${endDt.getFullYear()}-${pad(endDt.getMonth()+1)}-${pad(endDt.getDate())}T${pad(endDt.getHours())}:${pad(endDt.getMinutes())}:00`, timeZone: 'Asia/Tokyo' };
            } else {
                // All-day: both start and end must be date; end must be after start (exclusive)
                const startDate = task.scheduleDate || today();
                const endDate = task.deadline && task.deadline >= startDate ? task.deadline : startDate;
                const endExclusive = new Date(endDate); endExclusive.setDate(endExclusive.getDate() + 1);
                start = { date: startDate };
                end = { date: `${endExclusive.getFullYear()}-${pad(endExclusive.getMonth()+1)}-${pad(endExclusive.getDate())}` };
            }

            const reminders = (task.alarm && task.alarm !== 'none' && task.time)
                ? { useDefault: false, overrides: [{ method: 'popup', minutes: { ontime:0,'5min':5,'15min':15,'30min':30,'1hour':60,'1day':1440 }[task.alarm] || 0 }] }
                : { useDefault: false, overrides: [] };

            return {
                summary: `[TF]${task.completed ? '✅' : ''} ${task.title}`,
                description: [task.memo, task.deadline ? `期限: ${task.deadline}` : '', cats.length ? `カテゴリー: ${cats.join(', ')}` : ''].filter(Boolean).join('\n'),
                start, end, reminders,
                extendedProperties: { private: { taskflowId: task.id, type: 'task' } },
            };
        },

        eventToGEvent(ev) {
            const start = ev.time ? { dateTime: `${ev.date}T${ev.time}:00`, timeZone: 'Asia/Tokyo' } : { date: ev.date };
            const end = ev.time ? { dateTime: `${ev.date}T${ev.time}:00`, timeZone: 'Asia/Tokyo' } : { date: ev.date };
            return {
                summary: `[TF] ${ev.title}`,
                description: ev.memo || '',
                start, end,
                reminders: { useDefault: false, overrides: [] },
                extendedProperties: { private: { taskflowId: ev.id, type: 'event' } },
            };
        },

        async syncAll(filterCategoryIds, syncTasks, syncEvents) {
            if (this.syncing) return;
            if (!this.isSignedIn()) {
                const ok = await this.signIn();
                if (!ok) return;
            }
            this.syncing = true;
            this.setStatus('同期中…', 'sync-connecting');
            try {
                const map = this.getSyncMap();
                const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

                // 1. Fetch existing TF events from Google
                const now = new Date();
                const tMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
                const tMax = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString();
                const existing = await this.apiFetch(`${BASE}?timeMin=${tMin}&timeMax=${tMax}&privateExtendedProperty=taskflowId&singleEvents=true&maxResults=500`);
                const gEvents = existing.items || [];

                // 2. Pull: Google → TaskFlow (new events from Google not in TaskFlow)
                const knownTfIds = new Set([...state.tasks.map(t=>t.id), ...state.events.map(e=>e.id)]);
                let pulled = 0;
                gEvents.forEach(gev => {
                    const tfId = gev.extendedProperties?.private?.taskflowId;
                    if (tfId && knownTfIds.has(tfId)) return; // already in TaskFlow
                    if (gev.status === 'cancelled') return;
                    if (tfId) return; // managed by us but deleted locally — skip
                    // Pure Google event → add as TaskFlow event
                    const date = gev.start?.date || (gev.start?.dateTime || '').slice(0, 10);
                    const time = gev.start?.dateTime ? gev.start.dateTime.slice(11, 16) : '';
                    if (!date) return;
                    state.events.push({ id: genId(), title: gev.summary || '(無題)', date, time, memo: gev.description || '', createdAt: new Date().toISOString() });
                    pulled++;
                });
                if (pulled > 0) { saveStateLocal(); renderCurrentView(); }

                // 3. Push: TaskFlow → Google
                const gEventById = {};
                gEvents.forEach(g => { if (g.extendedProperties?.private?.taskflowId) gEventById[g.extendedProperties.private.taskflowId] = g; });

                const pushItem = async (tfId, gevBody) => {
                    const existing = gEventById[tfId];
                    if (existing && existing.status !== 'cancelled') {
                        await this.apiFetch(`${BASE}/${existing.id}`, 'PUT', gevBody);
                        map[tfId] = existing.id;
                    } else {
                        const created = await this.apiFetch(BASE, 'POST', gevBody);
                        if (created) map[tfId] = created.id;
                    }
                };

                const promises = [];
                if (syncTasks) {
                    state.tasks.filter(t => {
                        if (!filterCategoryIds || filterCategoryIds.length === 0) return true;
                        return (t.categories || []).some(c => filterCategoryIds.includes(c));
                    }).forEach(t => promises.push(pushItem(t.id, this.taskToGEvent(t))));
                }
                if (syncEvents) {
                    state.events.forEach(ev => promises.push(pushItem(ev.id, this.eventToGEvent(ev))));
                }

                await Promise.allSettled(promises);
                this.saveSyncMap(map);

                const timeStr = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
                this.setStatus(`同期済み (${timeStr})`, 'sync-on');
                showToast('Googleカレンダーと同期しました');
            } catch (e) {
                this.setStatus('エラー: ' + e.message, 'sync-error');
                showToast('同期エラー: ' + e.message);
            } finally {
                this.syncing = false;
            }
        },

        setStatus(text, cls) {
            const el = document.getElementById('gcal-status');
            if (el) { el.textContent = text; el.className = 'sync-status ' + cls; }
        },

        updateUI() {
            const clientId = this.loadClientId();
            const cidInput = document.getElementById('gcal-client-id');
            if (cidInput && !cidInput.value) cidInput.value = clientId;

            const signinBtn = document.getElementById('gcal-signin-btn');
            const syncBtn = document.getElementById('gcal-sync-btn');
            const signoutBtn = document.getElementById('gcal-signout-btn');
            if (!signinBtn) return;

            if (this.isSignedIn()) {
                signinBtn.style.display = 'none';
                syncBtn.style.display = '';
                signoutBtn.style.display = '';
                this.setStatus('接続済み', 'sync-on');
            } else {
                signinBtn.style.display = '';
                syncBtn.style.display = 'none';
                signoutBtn.style.display = 'none';
                this.setStatus(clientId ? '未サインイン' : '未設定', 'sync-off');
            }
        },
    };

    function buildCalCategoryFilter() {
        const container = document.getElementById('cal-category-filter');
        if (!container) return;
        const saved = JSON.parse(localStorage.getItem('taskflow_cal_categories') || '[]');
        container.innerHTML = '';
        if (state.categories.length === 0) {
            container.textContent = 'カテゴリーがありません';
            return;
        }
        state.categories.forEach(cat => {
            const checked = saved.length === 0 || saved.includes(cat.id);
            const label = document.createElement('label');
            label.className = 'cal-check-label';
            label.innerHTML = `<input type="checkbox" class="cal-cat-check" data-id="${cat.id}" ${checked ? 'checked' : ''}>
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${cat.color};margin-right:4px;"></span>
                ${cat.name}`;
            container.appendChild(label);
        });
    }

    function getCalFilterSettings() {
        const checks = document.querySelectorAll('.cal-cat-check');
        const selectedIds = [...checks].filter(c => c.checked).map(c => c.dataset.id);
        localStorage.setItem('taskflow_cal_categories', JSON.stringify(selectedIds));
        const syncTasks = document.getElementById('cal-sync-tasks')?.checked !== false;
        const syncEvents = document.getElementById('cal-sync-events')?.checked !== false;
        return { filterCategoryIds: selectedIds, syncTasks, syncEvents };
    }

    // ===== Init =====
    function init() {
        requestNotificationPermission();

        // Nav
        $$('.nav-item').forEach(item => {
            item.addEventListener('click', () => switchView(item.dataset.view));
        });

        // Sidebar toggle
        const overlay = el('div', { className:'sidebar-overlay', onClick:() => { $('#sidebar').classList.remove('open'); document.querySelector('.sidebar-overlay').classList.remove('active'); }});
        document.body.appendChild(overlay);
        $('#sidebar-toggle').addEventListener('click', () => {
            $('#sidebar').classList.toggle('open');
            document.querySelector('.sidebar-overlay').classList.toggle('active');
        });

        // Week nav
        $('#prev-week').addEventListener('click', () => { currentWeekOffset--; renderWeeklyView(); });
        $('#next-week').addEventListener('click', () => { currentWeekOffset++; renderWeeklyView(); });
        $('#this-week').addEventListener('click', () => { currentWeekOffset=0; renderWeeklyView(); });

        // Month nav (main calendar)
        $('#prev-month').addEventListener('click', () => { currentMonthOffset--; renderCalendarView(); });
        $('#next-month').addEventListener('click', () => { currentMonthOffset++; renderCalendarView(); });
        $('#this-month').addEventListener('click', () => { currentMonthOffset=0; renderCalendarView(); });

        // Mini calendar nav
        $('#mini-prev-month').addEventListener('click', () => { miniMonthOffset--; renderMiniCalendar(); });
        $('#mini-next-month').addEventListener('click', () => { miniMonthOffset++; renderMiniCalendar(); });

        // Calendar mode toggles (main)
        $('#cal-deadline').addEventListener('click', () => { calendarMode='deadline'; $('#cal-deadline').classList.add('active'); $('#cal-schedule').classList.remove('active'); renderCalendarView(); });
        $('#cal-schedule').addEventListener('click', () => { calendarMode='schedule'; $('#cal-schedule').classList.add('active'); $('#cal-deadline').classList.remove('active'); renderCalendarView(); });

        // Mini calendar mode toggles
        $('#mini-cal-schedule').addEventListener('click', () => { miniCalMode='schedule'; $('#mini-cal-schedule').classList.add('active'); $('#mini-cal-deadline').classList.remove('active'); renderMiniCalendar(); });
        $('#mini-cal-deadline').addEventListener('click', () => { miniCalMode='deadline'; $('#mini-cal-deadline').classList.add('active'); $('#mini-cal-schedule').classList.remove('active'); renderMiniCalendar(); });

        // Add button (header) + FAB (mobile)
        $('#add-task-btn').addEventListener('click', () => openAddModal());
        const fab = $('#fab-add');
        if (fab) fab.addEventListener('click', () => openAddModal());

        // Add category
        $('#add-category-btn').addEventListener('click', openAddCategory);

        // Type selector in modal
        $$('.type-option').forEach(opt => {
            opt.addEventListener('click', () => setItemType(opt.dataset.type));
        });

        // Task form submit
        $('#task-form').addEventListener('submit', e => {
            e.preventDefault();
            const title = $('#task-title').value.trim();
            if (!title) return;

            if (currentItemType === 'task') {
                const data = {
                    title,
                    scheduleDate: $('#task-schedule-date').value,
                    deadline: $('#task-deadline').value,
                    time: $('#task-time').value,
                    priority: $('#task-priority').value,
                    alarm: $('#task-alarm').value,
                    memo: $('#task-memo').value.trim(),
                    categories: [...selectedCategories],
                };
                // If adding from category and no schedule date, use deadline as schedule date
                if (addFromCategory && !data.scheduleDate && data.deadline) {
                    data.scheduleDate = data.deadline;
                }
                if (editingItemId) updateTask(editingItemId, data);
                else addTask(data);
            } else {
                const data = {
                    title,
                    date: $('#event-date').value,
                    time: $('#event-time').value,
                    memo: $('#task-memo').value.trim(),
                };
                if (editingItemId) updateEvent(editingItemId, data);
                else addEvent(data);
            }
            closeModal('#task-modal');
        });

        // Delete
        $('#delete-task-btn').addEventListener('click', () => {
            if (!editingItemId) return;
            if (!confirm('削除しますか？')) return;
            if (currentItemType === 'task') deleteTask(editingItemId);
            else deleteEvent(editingItemId);
            closeModal('#task-modal');
        });

        // Close buttons
        $('#modal-close').addEventListener('click', () => closeModal('#task-modal'));
        $('#modal-cancel').addEventListener('click', () => closeModal('#task-modal'));
        $('#category-modal-close').addEventListener('click', () => closeModal('#category-modal'));
        $('#category-modal-cancel').addEventListener('click', () => closeModal('#category-modal'));
        $('#move-modal-close').addEventListener('click', () => closeModal('#move-modal'));
        $('#move-modal-cancel').addEventListener('click', () => closeModal('#move-modal'));

        // Backdrop click
        $$('.modal').forEach(modal => {
            modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('active'); });
        });

        // Category input
        const catInput = $('#task-category-input');
        catInput.addEventListener('input', () => {
            if (catInput.value.length > 0) showCategorySuggestions(catInput.value);
            else $('#category-suggestions').classList.remove('active');
        });
        catInput.addEventListener('focus', () => { if (catInput.value.length > 0) showCategorySuggestions(catInput.value); });
        catInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = catInput.value.replace(/^#/,'').trim();
                if (!val) return;
                const existing = state.categories.find(c=>c.name.toLowerCase()===val.toLowerCase());
                if (existing && !selectedCategories.includes(existing.id)) {
                    selectedCategories.push(existing.id);
                } else if (!existing) {
                    const newCat = addCategoryToState(val, '#7C8CF8');
                    if (newCat) selectedCategories.push(newCat.id);
                }
                renderSelectedCategories();
                catInput.value = '';
                $('#category-suggestions').classList.remove('active');
            }
        });
        document.addEventListener('click', e => {
            if (!e.target.closest('.category-input-wrapper')) $('#category-suggestions').classList.remove('active');
        });

        // Category form
        $('#category-form').addEventListener('submit', e => {
            e.preventDefault();
            const name = $('#category-name').value.trim();
            const colorEl = $('#color-picker .color-option.selected');
            const color = colorEl ? colorEl.dataset.color : '#7C8CF8';
            if (!name) return;
            if (editingCategoryId) {
                updateCategory(editingCategoryId, name, color);
            } else {
                addCategoryToState(name, color);
            }
            closeModal('#category-modal');
        });

        // Color picker
        $$('.color-option').forEach(opt => {
            opt.addEventListener('click', () => {
                $$('.color-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
            });
        });

        // Move confirm
        $('#move-confirm').addEventListener('click', () => {
            const date = $('#move-date').value;
            if (!editingItemId || !date) return;
            if (currentItemType === 'task') {
                const t = state.tasks.find(t=>t.id===editingItemId);
                if (t) { t.scheduleDate = date; saveState(); renderCurrentView(); }
            } else {
                const ev = state.events.find(e=>e.id===editingItemId);
                if (ev) { ev.date = date; saveState(); renderCurrentView(); }
            }
            closeModal('#move-modal');
        });

        // Keyboard
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') $$('.modal.active').forEach(m => m.classList.remove('active'));
            if ((e.ctrlKey||e.metaKey) && e.key === 'n') { e.preventDefault(); openAddModal(); }
        });

        // ===== Settings / Sync =====
        const settingsModal = $('#settings-modal');
        const openSettings = () => {
            Sync.updateUI();
            updateNotifStatusUI();
            GoogleCal.updateUI();
            buildCalCategoryFilter();
            const cfgInput = $('#sync-config-input');
            const cfg = Sync.loadConfig();
            cfgInput.value = cfg ? JSON.stringify(cfg, null, 2) : '';
            $('#sync-code-input').value = '';
            settingsModal.classList.add('active');
        };
        $('#settings-btn') && $('#settings-btn').addEventListener('click', openSettings);
        $('#settings-modal-close') && $('#settings-modal-close').addEventListener('click', () => settingsModal.classList.remove('active'));

        $('#sync-apply') && $('#sync-apply').addEventListener('click', () => {
            const raw = $('#sync-config-input').value.trim();
            if (!raw) { alert('Firebase設定コードを貼り付けてください'); return; }
            let cfg;
            try {
                // Remove import / export lines (they contain braces that confuse extraction)
                let src = raw
                    .split('\n')
                    .filter(l => !/^\s*(import|export)\b/.test(l))
                    .join('\n');
                // Find first { after first = sign (skips import braces etc.)
                const eqIdx = src.indexOf('=');
                const searchFrom = eqIdx >= 0 ? eqIdx : 0;
                const start = src.indexOf('{', searchFrom);
                if (start === -1) throw new Error('{ が見つかりません');
                // Balance-match the brace, respecting strings
                let depth = 0, end = -1, inStr = false, strCh = '';
                for (let i = start; i < src.length; i++) {
                    const c = src[i];
                    if (inStr) {
                        if (c === '\\') { i++; continue; }
                        if (c === strCh) inStr = false;
                        continue;
                    }
                    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
                    if (c === '/' && src[i+1] === '/') { // line comment
                        while (i < src.length && src[i] !== '\n') i++;
                        continue;
                    }
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end === -1) throw new Error('} が見つかりません (括弧が閉じていない)');
                let clean = src.slice(start, end + 1);
                // Remove line comments inside
                clean = clean.replace(/\/\/[^\n]*/g, '');
                // Quote unquoted keys
                clean = clean.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
                // Replace single quotes with double
                clean = clean.replace(/'/g, '"');
                // Remove trailing commas
                clean = clean.replace(/,(\s*[}\]])/g, '$1');
                cfg = JSON.parse(clean);
            } catch (e) {
                alert('設定コードの解析失敗: ' + e.message + '\n\nfirebaseConfig = { ... } の行を含む塊を貼り付けてください');
                return;
            }
            if (!cfg.apiKey || !cfg.projectId) {
                alert('apiKey / projectId が見つかりません');
                return;
            }
            const existingCode = $('#sync-code-input').value.trim();
            Sync.configure(cfg, existingCode || null);
            if (typeof showToast === 'function') showToast('Firebaseに接続中…');
        });

        $('#sync-disconnect') && $('#sync-disconnect').addEventListener('click', () => {
            if (!confirm('同期を解除しますか? (クラウドのデータは残ります)')) return;
            Sync.disconnect();
            $('#sync-config-input').value = '';
            $('#sync-code-input').value = '';
            if (typeof showToast === 'function') showToast('同期を解除しました');
        });

        $('#sync-code-copy') && $('#sync-code-copy').addEventListener('click', () => {
            const c = $('#sync-code-display').value;
            if (!c) return;
            navigator.clipboard.writeText(c).then(() => {
                if (typeof showToast === 'function') showToast('同期コードをコピーしました');
            });
        });

        // Notification enable button
        $('#notif-enable-btn') && $('#notif-enable-btn').addEventListener('click', enableNotifications);

        // ===== Calendar Sync Handlers =====
        // Save client ID on blur/input
        $('#gcal-client-id') && $('#gcal-client-id').addEventListener('blur', () => {
            const val = $('#gcal-client-id').value.trim();
            if (val) GoogleCal.saveClientId(val);
        });

        // Google sign-in
        $('#gcal-signin-btn') && $('#gcal-signin-btn').addEventListener('click', async () => {
            const cidInput = $('#gcal-client-id');
            if (cidInput && cidInput.value.trim()) GoogleCal.saveClientId(cidInput.value.trim());
            const ok = await GoogleCal.signIn();
            if (ok) {
                const { filterCategoryIds, syncTasks, syncEvents } = getCalFilterSettings();
                await GoogleCal.syncAll(filterCategoryIds, syncTasks, syncEvents);
            }
        });

        // Manual sync
        $('#gcal-sync-btn') && $('#gcal-sync-btn').addEventListener('click', async () => {
            const { filterCategoryIds, syncTasks, syncEvents } = getCalFilterSettings();
            await GoogleCal.syncAll(filterCategoryIds, syncTasks, syncEvents);
        });

        // Disconnect Google
        $('#gcal-signout-btn') && $('#gcal-signout-btn').addEventListener('click', () => {
            if (!confirm('Googleカレンダーとの接続を切断しますか？')) return;
            GoogleCal.signOut();
        });

        // ICS export
        $('#ics-export-btn') && $('#ics-export-btn').addEventListener('click', () => {
            const { filterCategoryIds, syncTasks, syncEvents } = getCalFilterSettings();
            exportICS(filterCategoryIds, syncTasks, syncEvents);
        });

        // Setup guide for Google Cloud Console
        $('#gcal-setup-guide') && $('#gcal-setup-guide').addEventListener('click', e => {
            e.preventDefault();
            alert(
                '【Google Cloud Console 設定手順】\n\n' +
                '1. https://console.cloud.google.com/ を開く\n' +
                '2. 新しいプロジェクトを作成（例: "taskflow"）\n' +
                '3. 「APIとサービス」→「ライブラリ」→\n' +
                '   「Google Calendar API」を有効化\n' +
                '4. 「APIとサービス」→「認証情報」→\n' +
                '   「認証情報を作成」→「OAuthクライアントID」\n' +
                '5. アプリの種類: 「ウェブアプリケーション」\n' +
                '6. 承認済みJavaScriptオリジン:\n' +
                '   https://maeno8778-sudo.github.io\n' +
                '   を追加\n' +
                '7. 作成 → クライアントIDをコピー\n\n' +
                '取得したクライアントIDを上の入力欄に貼り付けてください。'
            );
        });

        // Data export/import
        $('#data-export') && $('#data-export').addEventListener('click', () => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `taskflow_${today()}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });
        $('#data-import') && $('#data-import').addEventListener('click', () => $('#data-import-file').click());
        $('#data-import-file') && $('#data-import-file').addEventListener('change', e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const data = JSON.parse(ev.target.result);
                    if (!data.tasks || !data.categories) throw new Error('不正な形式');
                    if (!confirm('現在のデータを上書きしてインポートしますか?')) return;
                    state.tasks = data.tasks;
                    state.events = data.events || [];
                    state.categories = data.categories;
                    saveState();
                    renderCurrentView();
                    scheduleAlarms();
                    if (typeof showToast === 'function') showToast('インポート完了');
                } catch (err) {
                    alert('インポート失敗: ' + err.message);
                }
                e.target.value = '';
            };
            reader.readAsText(file);
        });

        // Prevent iOS Safari from restoring scroll position
        if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

        // Init sync if already configured
        Sync.init();

        // Auto update every minute
        setInterval(() => renderCurrentView(), 60000);

        // Initial render
        renderCurrentView();
        scheduleAlarms();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
