
const SUPABASE_URL      = 'https://cjcfdomatauvolruvjqb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNqY2Zkb21hdGF1dm9scnV2anFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwNzMwNzAsImV4cCI6MjA5NDY0OTA3MH0.CFgj_yy98LWV0ggEfRCyNveiS5bxw6lLiNYH1qmZXag';
const STORAGE_BUCKET    = 'pair-check-images'; 

const USE_SUPABASE = SUPABASE_URL !== 'https://YOUR_PROJECT.supabase.co';

/* ─── 전역 상태 ──────────────────────────────────────────────────── */
const TRAITS_DEFAULT = ["활동성", "감수성", "애교", "집착", "전기지짐이력", "서방력"];
let traits = [...TRAITS_DEFAULT];

/* 컬러 상태 */
let state = { c1: '#3b82f6', c2: '#ef4444', bg: '#ffffff', txt: '#000000' };

/* 스티커 카운터 */
let stickerCount    = 0;
let imgStickerCount = 0;

/* Storage에 업로드된 현재 이미지 경로 (삭제용) */
let currentImgPath = null;

/* 이미지 스티커 Storage 경로 추적 (id → path) */
const imgStickerPaths = {};

/* ─── 필드별 타임스탬프 ───────────────────────────────────────────
   내가 마지막으로 조작한 시각을 필드별로 기록
   수신한 값의 타임스탬프가 내 것보다 최신일 때만 프리뷰에 반영
─────────────────────────────────────────────────────────────────── */
const fieldTs = {
    n1: 0, n2: 0, src: 0,
    c1: 0, c2: 0, bg: 0, txt: 0, unLink: 0,
    sliderVals: Array(6).fill(null).map(() => [0, 0]), // [항목][위/아래] 2차원
    traitLabels: Array(6).fill(0),                     // 성향 이름 항목별
};

/* 필드 타임스탬프 갱신
   sliderVals: touchField('sliderVals', [i, p])
   traitLabels: touchField('traitLabels', i)
   그 외: touchField('fieldName')
*/
function touchField(field, idx) {
    const now = Date.now();
    if (field === 'sliderVals' && Array.isArray(idx)) {
        fieldTs.sliderVals[idx[0]][idx[1]] = now;
    } else if (idx !== undefined) {
        fieldTs[field][idx] = now;
    } else {
        fieldTs[field] = now;
    }
}

/* 공유 링크로 진입한 뷰어 여부 (true면 공유 버튼 비활성화) */
let isViewer = false;

/* 실시간 공유 상태 */
let currentRoom     = null;   // 현재 연결된 room ID
let supabaseClient  = null;   // Supabase 클라이언트
let realtimeChannel = null;   // Supabase 채널
let bcChannel       = null;   // BroadcastChannel (폴백)
let broadcastTimer  = null;   // debounce 타이머

/* Supabase 클라이언트를 앱 시작 시 바로 초기화 (Storage 업로드를 room 연결 전에도 사용하기 위해) */
if (USE_SUPABASE) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/* ─── 비밀번호 인증 ──────────────────────────────────────────────── */
/**
 * SHA-256 해시 변환
 * crypto.subtle은 HTTPS 전용이라 js-sha256 라이브러리 사용 (HTTP 환경 대응)
 * 함수명 충돌 방지 — 내부에서 jsSHA256으로 참조
 */
async function hashPassword(text) {
    return window.sha256(text); // js-sha256 CDN 라이브러리 (window.sha256)
}

/**
 * 비밀번호 모달 초기화
 * - room 파라미터가 있으면 (공유 링크 진입) → 비밀번호 없이 바로 입장 + 공유 버튼 비활성화
 * - room 파라미터가 없으면 → 비밀번호 모달 표시
 * - 세션 동안 한 번 인증하면 재입력 불필요 (sessionStorage 활용)
 */
async function initPassword() {
    const urlRoom = new URLSearchParams(location.search).get('room');

    /* 공유 링크로 진입한 경우 — 뷰어 모드 */
    if (urlRoom) {
        isViewer = true;
        disableShareBtn();
        return; // 비밀번호 체크 없이 바로 입장
    }

    /* 이미 이 세션에서 인증한 경우 */
    if (sessionStorage.getItem('auth') === 'ok') return;

    /* 비밀번호 모달 표시 */
    document.getElementById('passwordModal').style.display = 'flex';

    /* 포커스 */
    setTimeout(() => document.getElementById('passwordInput').focus(), 100);
}

async function checkPassword() {
    const input = document.getElementById('passwordInput').value;
    if (!input) return;

    const inputHash = await hashPassword(input);

    try {
        /* Supabase DB에서 해시값 조회 */
        const { data, error } = await supabaseClient
            .from('app_config')
            .select('value')
            .eq('key', 'password_hash')
            .single();

        if (error) throw error;

        if (inputHash === data.value) {
            /* 인증 성공 */
            sessionStorage.setItem('auth', 'ok');
            document.getElementById('passwordModal').style.display = 'none';
        } else {
            /* 인증 실패 — 흔들림 애니메이션 */
            const inp = document.getElementById('passwordInput');
            const err = document.getElementById('passwordError');
            err.classList.remove('hidden');
            inp.value = '';
            inp.classList.add('shake');
            inp.addEventListener('animationend', () => inp.classList.remove('shake'), { once: true });
            inp.focus();
        }
    } catch (e) {
        console.error('비밀번호 확인 오류:', e);
        alert('서버 연결 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    }
}

/* 공유 버튼 완전 제거 (뷰어 전용 — disabled는 F12로 우회 가능하므로 DOM에서 제거) */
function disableShareBtn() {
    const btn = document.getElementById('shareBtn');
    if (!btn) return;
    btn.remove();
}

/* ─── 온보딩 모달 ─────────────────────────────────────────────────── */
function initOnboarding() {
    const modal   = document.getElementById('onboardingModal');
    const confirmBtn = document.getElementById('onboardingConfirmBtn');
    const stored  = localStorage.getItem('hideOnboarding');

    /* 24시간 이내 '보지 않기' 선택한 경우 즉시 닫음 */
    if (stored && Date.now() < Number(stored)) {
        modal.style.display = 'none';
        return;
    }

    confirmBtn.addEventListener('click', () => {
        if (document.getElementById('hideToday').checked) {
            localStorage.setItem('hideOnboarding', Date.now() + 86400000); // +24h
        }
        modal.style.display = 'none';
    });

    /* 오버레이 클릭 닫기 */
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.style.display = 'none';
    });
}

/* ─── Room ID 자동 생성 ─────────────────────────────────────────── */
/**
 * 규칙: YYYYMMDD-XXXXX
 * 날짜 8자리 + 하이픈 + 영숫자 5자리 랜덤
 * 예: 20250518-x7k2p
 */
function generateRoomId() {
    const now   = new Date();
    const yyyy  = now.getFullYear();
    const mm    = String(now.getMonth() + 1).padStart(2, '0');
    const dd    = String(now.getDate()).padStart(2, '0');
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const rand  = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `${yyyy}${mm}${dd}-${rand}`;
}

/* 현재 모달에 표시 중인 Room ID (아직 연결 전) */
let pendingRoomId = null;

function regenerateRoomId() {
    pendingRoomId = generateRoomId();
    document.getElementById('roomIdDisplay').textContent = pendingRoomId;
    updateShareLink(pendingRoomId);
}

/* ─── 실시간 공유 모달 ───────────────────────────────────────────── */
function openShareModal() {
    const modal = document.getElementById('shareModal');
    modal.style.display = 'flex';

    /* URL에 이미 room 파라미터가 있으면 그대로 표시 */
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (urlRoom) {
        pendingRoomId = urlRoom;
        document.getElementById('roomIdDisplay').textContent = urlRoom;
        document.getElementById('startShareBtn').textContent =
            currentRoom === urlRoom ? '연결됨 ✓' : '공유 시작';
    } else {
        /* 새 Room ID 자동 생성 */
        regenerateRoomId();
        document.getElementById('startShareBtn').textContent = '공유 시작';
    }

    updateShareLink(pendingRoomId);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeShareModal();
    }, { once: true });
}

function closeShareModal() {
    document.getElementById('shareModal').style.display = 'none';
}

function updateShareLink(roomId) {
    const base = location.origin + location.pathname.replace('index.html', 'app.html');
    const link = roomId ? `${base}?room=${roomId}` : base;
    document.getElementById('shareLinkInput').value = link;
}

async function copyShareLink() {
    const val = document.getElementById('shareLinkInput').value;
    try {
        await navigator.clipboard.writeText(val);
        const btn = document.getElementById('copyLinkBtn');
        const orig = btn.textContent;
        btn.textContent = '복사됨 ✓';
        setTimeout(() => btn.textContent = orig, 1500);
    } catch { /* 구형 브라우저 무시 */ }
}

/* ─── Room 연결 ──────────────────────────────────────────────────── */
async function connectRoom() {
    const id = pendingRoomId;
    if (!id) return;

    /* 이미 같은 room에 연결 중이면 모달만 닫기 */
    if (currentRoom === id) { closeShareModal(); return; }

    /* 이전 연결 해제 */
    disconnectRoom(false);

    currentRoom = id;
    setRoomStatus('connecting', '연결 중...');

    /* URL 파라미터 갱신 */
    const url = new URL(location.href);
    url.searchParams.set('room', id);
    history.replaceState(null, '', url.toString());

    if (USE_SUPABASE) {
        await connectSupabase(id);
    } else {
        connectBroadcastChannel(id);
    }
}

/* Supabase Realtime Broadcast + Presence 연결 */
async function connectSupabase(roomId) {
    if (!supabaseClient) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    realtimeChannel = supabaseClient.channel(`pair-check:${roomId}`, {
        config: {
            broadcast: { self: false },
            presence:  { key: MY_USER_ID }, // Presence 활성화
        }
    });

    realtimeChannel
        .on('broadcast', { event: 'preview' }, ({ payload }) => {
            applyRemoteState(payload);
        })
        .on('broadcast', { event: 'overlay' }, ({ payload }) => {
            if (payload.show) {
                setImgOverlay(true, payload.text);
            } else if (!window._remoteImgStickerLoading) {
                setImgOverlay(false);
            }
        })
        .on('broadcast', { event: 'chat' }, ({ payload }) => {
            appendChatMessage(payload, false);
            if (!chatOpen) {
                unreadCount++;
                updateChatBadge();
            }
        })
        .on('broadcast', { event: 'join' }, () => {
            clearTimeout(broadcastTimer);
            const payload = collectPreviewState();
            realtimeChannel.send({ type: 'broadcast', event: 'preview', payload });
        })
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                /* Presence에 내 존재 등록 */
                await realtimeChannel.track({ userId: MY_USER_ID, joinedAt: Date.now() });

                setRoomStatus('connected', `Room: ${roomId} 연결됨`);
                updateShareBtn(true);
                closeShareModal();
                updateChatRoomLabel();
                realtimeChannel.send({ type: 'broadcast', event: 'join', payload: {} });
            } else if (status === 'CHANNEL_ERROR') {
                setRoomStatus('disconnected', '연결 실패');
            }
        });
}

/**
 * 뷰어(링크 진입자)용 — room에 나 말고 다른 사람이 있는지 확인
 * Presence로 현재 접속자 수를 체크
 * 아무도 없으면 만료된 링크로 판단
 */
async function checkRoomAlive(roomId) {
    return new Promise((resolve) => {
        const checkChannel = supabaseClient.channel(`pair-check:${roomId}`, {
            config: { presence: { key: MY_USER_ID } }
        });

        let resolved = false;

        checkChannel.on('presence', { event: 'sync' }, () => {
            if (resolved) return;
            const state   = checkChannel.presenceState();
            const members = Object.keys(state);
            /* 나 자신(MY_USER_ID) 외에 다른 사람이 있는지 확인 */
            const others  = members.filter(k => k !== MY_USER_ID);
            resolved = true;
            checkChannel.unsubscribe();
            resolve(others.length > 0);
        });

        checkChannel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await checkChannel.track({ userId: MY_USER_ID });
            }
        });

        /* 2초 내 응답 없으면 아무도 없다고 판단 */
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                checkChannel.unsubscribe();
                resolve(false);
            }
        }, 2000);
    });
}

/* BroadcastChannel 폴백 (같은 origin 다른 탭/창 동기화, Supabase 없이도 테스트 가능) */
function connectBroadcastChannel(roomId) {
    bcChannel = new BroadcastChannel(`pair-check:${roomId}`);
    bcChannel.onmessage = (e) => {
        if (e.data?.type === 'preview') applyRemoteState(e.data.payload);
        if (e.data?.type === 'overlay') {
            const p = e.data.payload;
            if (p.show) {
                setImgOverlay(true, p.text);
            } else if (!window._remoteImgStickerLoading) {
                setImgOverlay(false);
            }
        }
        if (e.data?.type === 'chat') {
            appendChatMessage(e.data.payload, false);
            if (!chatOpen) { unreadCount++; updateChatBadge(); }
        }
    };
    setRoomStatus('connected', `Room: ${roomId} (로컬 테스트 모드)`);
    updateShareBtn(true);
    closeShareModal();
}

function disconnectRoom(updateUI = true) {
    if (realtimeChannel) { realtimeChannel.unsubscribe(); realtimeChannel = null; }
    if (bcChannel)        { bcChannel.close(); bcChannel = null; }
    currentRoom = null;
    if (updateUI) {
        setRoomStatus('disconnected', '연결 안 됨');
        updateShareBtn(false);
    }
}

/* ─── 상태 표시 헬퍼 ─────────────────────────────────────────────── */
function setRoomStatus(type, text) {
    const wrap = document.getElementById('roomStatus');
    const dot  = document.getElementById('statusDot');
    const label = document.getElementById('statusText');

    wrap.className = 'flex items-center gap-2 text-xs text-gray-500 bg-gray-50 rounded-xl px-4 py-3';
    dot.className  = `w-2 h-2 rounded-full ${type}`;
    label.textContent = text;
}

function updateShareBtn(connected) {
    const indicator = document.getElementById('shareLiveIndicator');
    const label     = document.getElementById('shareBtnLabel');
    if (!indicator || !label) return; // 뷰어 모드에서 버튼 제거된 경우
    if (connected) {
        indicator.classList.remove('hidden');
        label.textContent = '공유 중';
    } else {
        indicator.classList.add('hidden');
        label.textContent = '공유';
    }
}

/* ─── previewState 수집 & broadcast ─────────────────────────────── */
/**
 * 현재 에디터 상태를 직렬화하여 반환
 * 이미지(blob URL)는 포함하지 않음 — 텍스트 상태만 sync
 */
function collectPreviewState() {
    const traitLabels = [];
    const sliderVals  = [];

    traits.forEach((_, i) => {
        traitLabels.push(document.getElementById(`trait-in-${i}`)?.value ?? traits[i]);
        sliderVals.push([
            document.getElementById(`range-${i}-1`)?.value ?? 50,
            document.getElementById(`range-${i}-2`)?.value ?? 50,
        ]);
    });

    /* 현재 프리뷰 이미지의 Storage public URL + transform 값 */
    const imgEl  = document.getElementById('targetImg');
    const imgVisible = imgEl && !imgEl.classList.contains('hidden');
    const imgUrl = imgVisible ? imgEl.getAttribute('data-storage-url') : null;
    const imgTransform = imgVisible ? {
        x:     parseFloat(imgEl.getAttribute('data-x'))     || 0,
        y:     parseFloat(imgEl.getAttribute('data-y'))     || 0,
        scale: parseFloat(imgEl.getAttribute('data-scale')) || 1,
    } : null;

    /* 텍스트 스티커 전체 수집 */
    const stickers = [];
    document.querySelectorAll('[id^="stickerel"]').forEach(el => {
        const id    = el.id.replace('stickerel', '');
        const span  = el.querySelector('span');
        const text  = span ? span.innerText : el.innerText;
        const shape = el.getAttribute('data-shape') || 'none';
        const opEl  = document.getElementById(`sopacity${id}`);
        stickers.push({
            id,
            text,
            x:       parseFloat(el.getAttribute('data-x'))     || 0,
            y:       parseFloat(el.getAttribute('data-y'))     || 0,
            angle:   parseFloat(el.getAttribute('data-angle')) || 0,
            shape,
            bg:      document.getElementById(`scbg${id}`)?.value  ?? '#ffffff',
            bd:      document.getElementById(`scbd${id}`)?.value  ?? '#e5e7eb',
            tx:      document.getElementById(`sctx${id}`)?.value  ?? '#111111',
            opacity: opEl ? parseInt(opEl.value) : 50,
        });
    });

    /* 이미지 스티커 전체 수집 */
    const imgStickers = [];
    document.querySelectorAll('[id^="imgstickerel"]').forEach(el => {
        const id  = el.id.replace('imgstickerel', '');
        const url = el.getAttribute('data-storage-url');
        if (!url) return; // Storage URL 없으면 공유 불가 (로컬 blob)
        const sizeEl = document.getElementById(`issize${id}`);
        imgStickers.push({
            id,
            url,
            x:     parseFloat(el.getAttribute('data-x'))     || 0,
            y:     parseFloat(el.getAttribute('data-y'))     || 0,
            angle: parseFloat(el.getAttribute('data-angle')) || 0,
            size:  sizeEl ? parseInt(sizeEl.value) : 80,
        });
    });

    return {
        n1:          document.getElementById('n1')?.value ?? '',
        n2:          document.getElementById('n2')?.value ?? '',
        src:         document.getElementById('srcIn')?.value ?? '',
        unLink:      document.getElementById('unLinkColor')?.checked ?? false,
        c1:          state.c1,
        c2:          state.c2,
        bg:          state.bg,
        txt:         state.txt,
        traitLabels,
        sliderVals,
        imgUrl,
        imgTransform,
        stickers,
        imgStickers,
        isUploading: window._isUploading ?? false,
        /* 필드별 타임스탬프 — 수신 측에서 최신값만 반영하는 데 사용 */
        ts: {
            n1:          fieldTs.n1,
            n2:          fieldTs.n2,
            src:         fieldTs.src,
            c1:          fieldTs.c1,
            c2:          fieldTs.c2,
            bg:          fieldTs.bg,
            txt:         fieldTs.txt,
            unLink:      fieldTs.unLink,
            sliderVals:  fieldTs.sliderVals.map(pair => [...pair]), // 2차원 복사
            traitLabels: [...fieldTs.traitLabels],
        },
    };
}

/**
 * debounce 적용 broadcast
 * syncAll() 호출마다 실행되지만 300ms 뒤 한 번만 전송
 */
function broadcastState() {
    if (!currentRoom || _applyingRemote) return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
        const payload = collectPreviewState();
        if (USE_SUPABASE && realtimeChannel) {
            realtimeChannel.send({ type: 'broadcast', event: 'preview', payload });
        } else if (bcChannel) {
            bcChannel.postMessage({ type: 'preview', payload });
        }
    }, 300);
}

/* 오버레이 전용 즉시 broadcast — debounce 없이 바로 전송 */
function broadcastOverlay(show, text) {
    if (!currentRoom) return;
    const payload = { show, text: text || '' };
    if (USE_SUPABASE && realtimeChannel) {
        realtimeChannel.send({ type: 'broadcast', event: 'overlay', payload });
    } else if (bcChannel) {
        bcChannel.postMessage({ type: 'overlay', payload });
    }
}

/* 업로드 오버레이 표시/숨김 */
function setImgOverlay(show, text) {
    const el = document.getElementById('imgUploadOverlay');
    if (!el) return;
    el.classList.toggle('hidden', !show);
    const textEl = document.getElementById('imgOverlayText');
    if (textEl && text) textEl.textContent = text;
    else if (textEl && !text) textEl.textContent = '이미지를 수정 중입니다.';
}

/* 이미지 transform 적용 헬퍼 */
function applyImgTransform(img, t) {
    if (!t) { img.style.transform = 'translate(0px, 0px) scale(1)'; return; }
    img.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
    img.setAttribute('data-x',     t.x);
    img.setAttribute('data-y',     t.y);
    img.setAttribute('data-scale', t.scale);
}

/**
 * 수신한 remote state를 프리뷰에 반영
 * (에디터 UI는 건드리지 않음 — preview only)
 */
let _applyingRemote = false;

function applyRemoteState(ps) {
    if (_applyingRemote) return;
    _applyingRemote = true;
    try {
        /* 업로드 오버레이 */
        if (ps.isUploading) {
            /* 상대방이 업로드 중 — 나도 오버레이 ON */
            setImgOverlay(true, '이미지를 수정 중입니다.');
        }
        /* isUploading false 처리는 이미지 onload 또는 imgUrl 없음에서 처리 */

        /* 타임스탬프 헬퍼 — 상대방 ts가 내 ts보다 최신이면 true */
        const newer = (field, idx) => {
            if (!ps.ts) return true; // ts 없으면 항상 반영 (하위 호환)
            let remote, mine;
            if (field === 'sliderVals' && Array.isArray(idx)) {
                remote = ps.ts.sliderVals?.[idx[0]]?.[idx[1]];
                mine   = fieldTs.sliderVals[idx[0]][idx[1]];
            } else if (idx !== undefined) {
                remote = ps.ts[field]?.[idx];
                mine   = fieldTs[field][idx];
            } else {
                remote = ps.ts[field];
                mine   = fieldTs[field];
            }
            return (remote ?? 0) >= mine;
        };

        /* 이름·출처 */
        if (newer('n1'))  document.getElementById('display-name1').innerText = ps.n1;
        if (newer('n2'))  document.getElementById('display-name2').innerText = ps.n2;
        if (newer('src')) document.getElementById('display-source').innerText = ps.src;

        /* 이미지 — Storage URL이 있으면 프리뷰에 적용 */
        if (ps.imgUrl) {
            const img = document.getElementById('targetImg');
            if (img.getAttribute('data-storage-url') !== ps.imgUrl) {
                /* 새 이미지 — URL 바뀐 경우만 재로드 */
                img.setAttribute('crossorigin', 'anonymous');
                img.src = ps.imgUrl;
                img.setAttribute('data-storage-url', ps.imgUrl);
                img.onload = () => {
                    const ratio = img.naturalWidth / img.naturalHeight;
                    img.style.height = ratio > 1 ? '100%' : 'auto';
                    img.style.width  = ratio > 1 ? 'auto' : '100%';
                    applyImgTransform(img, ps.imgTransform);
                    img.classList.remove('hidden');
                    /* B: 이미지 로드 완료 시 오버레이 OFF */
                    setImgOverlay(false);
                };
            } else if (ps.imgTransform) {
                /* 같은 이미지 — transform만 업데이트, 오버레이 불필요 */
                applyImgTransform(img, ps.imgTransform);
                if (!ps.isUploading) setImgOverlay(false);
            }
        } else if (!ps.isUploading) {
            /* imgUrl 없고 업로드 중도 아님 = 이미지 삭제됨 */
            const img = document.getElementById('targetImg');
            img.src = '';
            img.classList.add('hidden');
            img.removeAttribute('data-storage-url');
            setImgOverlay(false);
        }

        /* 색상 */
        const applyC1  = newer('c1');
        const applyC2  = newer('c2');
        const applyTxt = newer('txt');
        const applyBg  = newer('bg');
        const applyUnLink = newer('unLink');

        if (applyC1)  state.c1  = ps.c1;
        if (applyC2)  state.c2  = ps.c2;
        if (applyTxt) state.txt = ps.txt;
        if (applyBg)  state.bg  = ps.bg;

        const useUnLink   = applyUnLink ? ps.unLink : document.getElementById('unLinkColor').checked;
        const useC1       = applyC1  ? ps.c1  : state.c1;
        const useC2       = applyC2  ? ps.c2  : state.c2;
        const useTxt      = applyTxt ? ps.txt : state.txt;

        document.getElementById('display-name1').style.color = useUnLink ? useTxt : useC1;
        document.getElementById('display-name2').style.color = useUnLink ? useTxt : useC2;
        if (applyC1)  document.documentElement.style.setProperty('--thumb-a', ps.c1);
        if (applyC2)  document.documentElement.style.setProperty('--thumb-b', ps.c2);

        /* 배경 */
        if (applyBg) document.getElementById('captureArea').style.backgroundColor = ps.bg;

        /* 슬라이더 프리뷰 바 */
        traits.forEach((_, i) => {
            const titleEl = document.getElementById(`t-title-${i}`);
            if (titleEl && newer('traitLabels', i)) {
                titleEl.innerText = ps.traitLabels?.[i] ?? traits[i];
                titleEl.style.color = useTxt;
            }
            for (let p = 1; p <= 2; p++) {
                if (!newer('sliderVals', [i, p-1])) continue; // 위/아래 슬라이더 개별 비교
                const val   = ps.sliderVals?.[i]?.[p-1] ?? 50;
                const color = p === 1 ? (applyC1 ? ps.c1 : state.c1) : (applyC2 ? ps.c2 : state.c2);
                const bar   = document.getElementById(`t-bar-${i}-${p}`);
                const thumb = document.getElementById(`t-thumb-${i}-${p}`);
                if (bar)   { bar.style.width = `${val}%`; bar.style.backgroundColor = color; }
                if (thumb) { thumb.style.left = `${val}%`; thumb.style.backgroundColor = color; }
            }
        });

        /* 텍스트 스티커 sync */
        if (ps.stickers) applyRemoteStickers(ps.stickers);

        /* 이미지 스티커 sync */
        if (ps.imgStickers) applyRemoteImgStickers(ps.imgStickers);

    } finally {
        _applyingRemote = false;
    }
}

/* 수신한 스티커 목록을 프리뷰에 반영 */
function applyRemoteStickers(stickers) {
    const area = document.getElementById('captureArea');

    /* 기존 remote 스티커 제거 */
    area.querySelectorAll('[data-remote-sticker]').forEach(el => el.remove());

    stickers.forEach(s => {
        const el = document.createElement('div');
        el.setAttribute('data-remote-sticker', s.id);
        el.style.cssText = `
            position:absolute;
            left:${s.x}px; top:${s.y}px;
            font-size:12px; font-weight:400;
            color:${s.tx};
            white-space:nowrap;
            z-index:50;
            transform:rotate(${s.angle}deg);
            transform-origin:center center;
            font-family:var(--font-default);
            line-height:normal;
            padding:6px 12px;
            border:2px solid ${s.bd};
            pointer-events:none;`;

        if (s.shape === 'round') {
            el.style.background   = s.bg;
            el.style.borderRadius = '999px';
        } else if (s.shape === 'rect') {
            el.style.background   = s.bg;
            el.style.borderRadius = '6px';
        } else if (s.shape === 'semi') {
            const r = parseInt(s.bg.slice(1,3), 16);
            const g = parseInt(s.bg.slice(3,5), 16);
            const b = parseInt(s.bg.slice(5,7), 16);
            el.style.background   = `rgba(${r},${g},${b},${s.opacity/100})`;
            el.style.borderRadius = '10px';
        } else {
            el.style.background   = 'transparent';
            el.style.borderColor  = 'transparent';
            el.style.borderRadius = '0';
        }

        const span = document.createElement('span');
        span.style.cssText = 'display:inline-block; vertical-align:middle; line-height:normal;';
        span.innerText = s.text || ' ';
        el.appendChild(span);
        area.appendChild(el);
    });
}

/* 수신한 이미지 스티커 목록을 프리뷰에 반영 */
function applyRemoteImgStickers(imgStickers) {
    const area = document.getElementById('captureArea');

    /* 기존 remote 이미지 스티커의 URL 목록 (캐시 판별용) */
    const existingUrls = new Set(
        [...area.querySelectorAll('[data-remote-img-sticker]')].map(el => el.getAttribute('src'))
    );

    /* 기존 remote 이미지 스티커 제거 */
    area.querySelectorAll('[data-remote-img-sticker]').forEach(el => el.remove());

    if (imgStickers.length === 0) return;

    /* 새로 추가된 URL만 로딩 대상으로 카운트 */
    const newUrls = imgStickers.filter(s => !existingUrls.has(s.url));
    const total   = newUrls.length;
    let loadCount = 0;

    /* 새 스티커 없으면 오버레이 건드리지 않음 (위치/크기 변경만인 경우) */
    if (total > 0) {
        window._remoteImgStickerLoading = true;
    }

    imgStickers.forEach(s => {
        const el = document.createElement('img');
        el.setAttribute('data-remote-img-sticker', s.id);
        el.setAttribute('crossorigin', 'anonymous');
        el.style.cssText = `
            position:absolute;
            left:${s.x}px; top:${s.y}px;
            width:${s.size}px; height:auto;
            z-index:51;
            transform:rotate(${s.angle}deg);
            transform-origin:center center;
            pointer-events:none;
            border-radius:0;`;

        const isNew = !existingUrls.has(s.url);
        if (isNew) {
            /* 새 이미지 — onload 완료 시 카운트 */
            el.onload = el.onerror = () => {
                loadCount++;
                if (loadCount >= total) {
                    window._remoteImgStickerLoading = false;
                    setImgOverlay(false);
                }
            };
        }
        el.src = s.url;
        area.appendChild(el);
    });
}

/* ─── URL 자동 Room 연결 ─────────────────────────────────────────── */
async function autoConnectFromURL() {
    const urlRoom = new URLSearchParams(location.search).get('room');
    if (!urlRoom) return;

    pendingRoomId = urlRoom;
    updateShareLink(urlRoom);

    /* 링크 진입자(뷰어)는 room에 다른 사람이 있는지 먼저 확인 */
    if (USE_SUPABASE) {
        showExpiredOverlay('링크를 확인하는 중입니다...');
        const alive = await checkRoomAlive(urlRoom);
        hideExpiredOverlay();

        if (!alive) {
            /* 아무도 없음 — 만료된 링크 */
            showExpiredOverlay('만료된 링크입니다.<br>초대자가 접속 중일 때만 입장할 수 있습니다.');
            return;
        }
    }

    connectRoom();
}

/* 만료 안내 오버레이 */
function showExpiredOverlay(msg) {
    let el = document.getElementById('expiredOverlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'expiredOverlay';
        el.style.cssText = `
            position:fixed; inset:0; z-index:99998;
            background:rgba(0,0,0,0.8); backdrop-filter:blur(6px);
            display:flex; flex-direction:column;
            align-items:center; justify-content:center; gap:12px;
            font-family:var(--font-default); color:white; text-align:center;`;
        document.body.appendChild(el);
    }
    el.innerHTML = `
        <div style="font-size:36px;">🔒</div>
        <p style="font-size:15px; font-weight:700; line-height:1.6;">${msg}</p>`;
    el.style.display = 'flex';
}

function hideExpiredOverlay() {
    const el = document.getElementById('expiredOverlay');
    if (el) el.style.display = 'none';
}

/* ─── 기본 색상 업데이트 ────────────────────────────────────────── */
function updateBaseColor(type, val) {
    state[type] = val;
    touchField(type);
    if (type === 'bg') {
        document.getElementById('cpBg').style.backgroundColor = val;
        document.getElementById('captureArea').style.backgroundColor = val;
    } else {
        document.getElementById('cpText').style.backgroundColor = val;
    }
    syncAll();
}

/* ─── 컬러 피커 ──────────────────────────────────────────────────── */
const openCP = (id) => document.getElementById(id).click();

function updateColor(p, val) {
    state[`c${p}`] = val;
    document.getElementById(`cp${p}`).style.backgroundColor = val;
    touchField(`c${p}`);
    syncAll();
}

/* ─── syncAll: 에디터 → 프리뷰 동기화 + broadcast ──────────────── */
function syncAll() {
    const unLink = document.getElementById('unLinkColor').checked;

    document.documentElement.style.setProperty('--thumb-a', state.c1);
    document.documentElement.style.setProperty('--thumb-b', state.c2);

    document.getElementById('display-name1').innerText = document.getElementById('n1').value;
    document.getElementById('display-name2').innerText = document.getElementById('n2').value;

    document.getElementById('display-name1').style.color = unLink ? state.txt : state.c1;
    document.getElementById('display-name2').style.color = unLink ? state.txt : state.c2;

    document.getElementById('display-source').innerText = document.getElementById('srcIn').value;

    traits.forEach((_, i) => {
        const titleEl = document.getElementById(`t-title-${i}`);
        if (!titleEl) return;
        titleEl.innerText = document.getElementById(`trait-in-${i}`).value;
        titleEl.style.color = state.txt;

        for (let p = 1; p <= 2; p++) {
            const val   = document.getElementById(`range-${i}-${p}`).value;
            const slider = document.getElementById(`range-${i}-${p}`);
            const color  = state[`c${p}`];

            slider.style.background = `linear-gradient(to right, ${color} ${val}%, #eee ${val}%)`;

            const bar   = document.getElementById(`t-bar-${i}-${p}`);
            const thumb = document.getElementById(`t-thumb-${i}-${p}`);
            bar.style.width           = `${val}%`;
            bar.style.backgroundColor = color;
            thumb.style.left          = `${val}%`;
            thumb.style.backgroundColor = color;
        }
    });

    /* 실시간 broadcast */
    broadcastState();
}

/* ─── 성향 체크 편집 ─────────────────────────────────────────────── */
function enableEdit(i) {
    const el   = document.getElementById(`trait-in-${i}`);
    const icon = document.getElementById(`icon-${i}`);
    const btn  = document.getElementById(`btn-${i}`);
    el.readOnly = false;
    el.focus();
    el.style.borderBottom = '1px solid #ddd';
    icon.style.backgroundColor = '#4ADE80';
    btn.style.display = 'none';
}

function disableEdit(i) {
    const el   = document.getElementById(`trait-in-${i}`);
    const icon = document.getElementById(`icon-${i}`);
    const btn  = document.getElementById(`btn-${i}`);
    el.readOnly = true;
    el.style.borderBottom = 'none';
    icon.style.backgroundColor = '#E5E7EB';
    btn.style.display = 'inline';
    syncAll();
}

/* ─── 텍스트 스티커 ──────────────────────────────────────────────── */
function addSticker() {
    stickerCount++;
    const id   = stickerCount;
    const list = document.getElementById('stickerList');

    const row = document.createElement('div');
    row.id        = `stickerrow${id}`;
    row.className = 'bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2';
    row.innerHTML = `
<div class="flex gap-2 items-center">
    <input type="text" id="stickerin${id}" placeholder="스티커 텍스트"
           class="flex-1 border rounded-lg px-2 py-1 text-sm outline-none bg-white min-w-0">
    <button onclick="removeSticker(${id})"
            class="shrink-0 text-red-400 hover:text-red-600 font-bold text-sm px-1">✕</button>
</div>
<div class="flex gap-2 items-center">
    <!-- 배경색 -->
    <div style="position:relative; width:24px; height:24px; flex-shrink:0;">
        <div id="scpbg${id}" class="w-6 h-6 rounded-lg border-2 border-white shadow"
             style="background:#ffffff; position:absolute; top:0; left:0;"></div>
        <input type="color" id="scbg${id}" value="#ffffff" oninput="updateStickerStyle(${id})"
               style="position:absolute; top:0; left:0; width:24px; height:24px; opacity:0; cursor:pointer; padding:0; border:none; z-index:2;">
    </div>
    <!-- 테두리색 -->
    <div style="position:relative; width:24px; height:24px; flex-shrink:0;">
        <div id="scpbd${id}" class="w-6 h-6 rounded-lg border-2 border-white shadow"
             style="background:#e5e7eb; position:absolute; top:0; left:0;"></div>
        <input type="color" id="scbd${id}" value="#e5e7eb" oninput="updateStickerStyle(${id})"
               style="position:absolute; top:0; left:0; width:24px; height:24px; opacity:0; cursor:pointer; padding:0; border:none; z-index:2;">
    </div>
    <!-- 텍스트색 -->
    <div style="position:relative; width:24px; height:24px; flex-shrink:0;">
        <div id="scptx${id}" class="w-6 h-6 rounded-lg border-2 border-white shadow"
             style="background:#111111; position:absolute; top:0; left:0;"></div>
        <input type="color" id="sctx${id}" value="#111111" oninput="updateStickerStyle(${id})"
               style="position:absolute; top:0; left:0; width:24px; height:24px; opacity:0; cursor:pointer; padding:0; border:none; z-index:2;">
    </div>
    <div class="w-px h-5 bg-gray-200 mx-1"></div>
    <button onclick="setStickerShape(${id},'round')" id="sshaperound${id}"
            class="sticker-shape-btn flex-1 text-[11px] py-1 rounded-lg border font-bold bg-white border-gray-200 text-gray-500">🔵</button>
    <button onclick="setStickerShape(${id},'rect')"  id="sshaperect${id}"
            class="sticker-shape-btn flex-1 text-[11px] py-1 rounded-lg border font-bold bg-white border-gray-200 text-gray-500">⬜</button>
    <button onclick="setStickerShape(${id},'semi')"  id="sshapesemi${id}"
            class="sticker-shape-btn flex-1 text-[11px] py-1 rounded-lg border font-bold bg-white border-gray-200 text-gray-500">🌫️</button>
    <button onclick="resetStickerAngle(${id})" title="회전 초기화"
            class="flex-1 text-[11px] py-1 rounded-lg border font-bold bg-white border-gray-200 text-gray-500">↺</button>
</div>
<div id="sopacityrow${id}" class="hidden items-center gap-2">
    <input type="range" id="sopacity${id}" min="10" max="90" value="50"
           oninput="updateStickerStyle(${id})"
           class="flex-1" style="height:6px">
    <span id="sopacityval${id}" class="text-[10px] text-gray-400 w-6 text-right">50%</span>
</div>`;
    list.appendChild(row);

    /* 캡처 영역에 스티커 엘리먼트 추가 */
    const area = document.getElementById('captureArea');
    area.style.position = 'relative';

    const el = document.createElement('div');
    el.id = `stickerel${id}`;
    el.setAttribute('data-x', 80);
    el.setAttribute('data-y', 80);
    el.setAttribute('data-angle', 0);
    el.setAttribute('data-shape', 'none');
    el.style.cssText = `
        position:absolute; left:80px; top:80px;
        font-size:12px; font-weight:400; color:#111;
        cursor:grab; user-select:none; white-space:nowrap;
        z-index:50; transform:rotate(0deg); transform-origin:center center;
        touch-action:none; font-family:var(--font-default);
        line-height:normal; padding:5px 12px;
        background:transparent; border:2px solid transparent; border-radius:0;`;
    el.innerHTML = '<span style="display:inline-block; vertical-align:middle; line-height:normal;">스티커</span>';
    area.appendChild(el);

    setupStickerInteract(id);
    setStickerShape(id, 'round');
    document.getElementById(`stickerin${id}`).focus();
    broadcastState();
}

function setStickerShape(id, shape) {
    const el         = document.getElementById(`stickerel${id}`);
    const opacityRow = document.getElementById(`sopacityrow${id}`);

    ['round', 'rect', 'semi'].forEach(s => {
        const btn = document.getElementById(`sshape${s}${id}`);
        if (s === shape) {
            btn.classList.add('border-blue-400', 'text-blue-600', 'bg-blue-50');
            btn.classList.remove('border-gray-200', 'text-gray-500', 'bg-white');
        } else {
            btn.classList.remove('border-blue-400', 'text-blue-600', 'bg-blue-50');
            btn.classList.add('border-gray-200', 'text-gray-500', 'bg-white');
        }
    });

    el.setAttribute('data-shape', shape);
    opacityRow.classList.toggle('hidden', shape !== 'semi');
    opacityRow.classList.toggle('flex',   shape === 'semi');
    updateStickerStyle(id);
}

function updateStickerStyle(id) {
    const el    = document.getElementById(`stickerel${id}`);
    if (!el) return;
    const shape = el.getAttribute('data-shape') || 'none';
    const bg    = document.getElementById(`scbg${id}`).value;
    const bd    = document.getElementById(`scbd${id}`).value;
    const tx    = document.getElementById(`sctx${id}`).value;
    const opIn  = document.getElementById(`sopacity${id}`);
    const opVal = document.getElementById(`sopacityval${id}`);

    document.getElementById(`scpbg${id}`).style.background = bg;
    document.getElementById(`scpbd${id}`).style.background = bd;
    document.getElementById(`scptx${id}`).style.background = tx;

    el.style.color        = tx;
    el.style.borderWidth  = '2px';
    el.style.borderStyle  = 'solid';
    el.style.borderColor  = bd;
    el.style.padding      = '6px 12px';

    if (shape === 'round') {
        el.style.background   = bg;
        el.style.borderRadius = '999px';
        el.style.opacity      = '1';
    } else if (shape === 'rect') {
        el.style.background   = bg;
        el.style.borderRadius = '6px';
        el.style.opacity      = '1';
    } else if (shape === 'semi') {
        const pct = opIn.value;
        opVal.innerText = pct + '%';
        const r = parseInt(bg.slice(1,3), 16);
        const g = parseInt(bg.slice(3,5), 16);
        const b = parseInt(bg.slice(5,7), 16);
        el.style.background   = `rgba(${r},${g},${b},${pct/100})`;
        el.style.borderRadius = '10px';
        el.style.opacity      = '1';
    } else {
        el.style.background   = 'transparent';
        el.style.borderColor  = 'transparent';
        el.style.borderRadius = '0';
    }
    broadcastState();
}

function updateSticker(id) {
    const val = document.getElementById(`stickerin${id}`).value;
    const el  = document.getElementById(`stickerel${id}`);
    if (!el) return;
    const span = el.querySelector('span');
    if (span) span.innerText = val || ' ';
    else      el.innerText   = val || ' ';
    broadcastState();
}

function removeSticker(id) {
    document.getElementById(`stickerrow${id}`)?.remove();
    document.getElementById(`stickerel${id}`)?.remove();
    broadcastState();
}

function resetStickerAngle(id) {
    const el = document.getElementById(`stickerel${id}`);
    if (!el) return;
    el.setAttribute('data-angle', 0);
    el.style.transform = 'rotate(0deg)';
    broadcastState();
}

function setupStickerInteract(id) {
    const input = document.getElementById(`stickerin${id}`);
    let isComposing = false;
    input.addEventListener('compositionstart', () => isComposing = true);
    input.addEventListener('compositionend',   () => { isComposing = false; updateSticker(id); });
    input.addEventListener('input',            () => { if (!isComposing) updateSticker(id); });

    const el = document.getElementById(`stickerel${id}`);

    interact(el).draggable({
        listeners: {
            move(e) {
                const x     = (parseFloat(el.getAttribute('data-x')) || 0) + e.dx;
                const y     = (parseFloat(el.getAttribute('data-y')) || 0) + e.dy;
                const angle = parseFloat(el.getAttribute('data-angle')) || 0;
                el.style.left      = x + 'px';
                el.style.top       = y + 'px';
                el.style.transform = `rotate(${angle}deg)`;
                el.setAttribute('data-x', x);
                el.setAttribute('data-y', y);
                broadcastState();
            }
        }
    });

    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let angle = (parseFloat(el.getAttribute('data-angle')) || 0) + e.deltaY * 0.3;
        el.style.transform = `rotate(${angle}deg)`;
        el.setAttribute('data-angle', angle);
        broadcastState();
    }, { passive: false });
}

/* ─── 이미지 스티커 ──────────────────────────────────────────────── */
function addImgSticker() {
    imgStickerCount++;
    const id   = imgStickerCount;
    const list = document.getElementById('imgStickerList');

    const row = document.createElement('div');
    row.id        = `imgstickerrow${id}`;
    row.className = 'bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-2';
    row.innerHTML = `
<div class="flex gap-2 items-center">
    <div id="ispreviewwrap${id}" class="imgsticker-placeholder">🖼️</div>
    <label for="isfilein${id}"
           class="flex-1 cursor-pointer border rounded-lg px-2 py-1 text-xs text-gray-400 bg-white hover:bg-gray-50 text-center"
           style="line-height:2.2;">이미지 선택</label>
    <input type="file" id="isfilein${id}" accept="image/*" class="hidden" onchange="loadImgSticker(${id}, this)">
    <button onclick="removeImgSticker(${id})"
            class="shrink-0 text-red-400 hover:text-red-600 font-bold text-sm px-1">✕</button>
</div>
<div class="flex gap-2 items-center">
    <span class="text-[10px] text-gray-400 shrink-0">크기</span>
    <input type="range" id="issize${id}" min="20" max="300" value="80"
           oninput="updateImgStickerStyle(${id})"
           class="flex-1" style="height:6px; -webkit-appearance:none; background:#eee; border-radius:999px;">
    <button onclick="resetImgStickerAngle(${id})" title="회전 초기화"
            class="shrink-0 text-[11px] py-1 px-2 rounded-lg border font-bold bg-white border-gray-200 text-gray-500">↺</button>
</div>`;
    list.appendChild(row);

    const area = document.getElementById('captureArea');
    area.style.position = 'relative';

    const el = document.createElement('img');
    el.id = `imgstickerel${id}`;
    el.src = '';
    el.setAttribute('data-x', 100);
    el.setAttribute('data-y', 100);
    el.setAttribute('data-angle', 0);
    el.style.cssText = `
        position:absolute; left:100px; top:100px;
        width:80px; height:auto;
        cursor:grab; user-select:none; z-index:51;
        transform:rotate(0deg); transform-origin:center center;
        touch-action:none; border-radius:0; opacity:1; display:none;`;
    area.appendChild(el);

    setupImgStickerInteract(id);
}

async function loadImgSticker(id, input) {
    const file = input.files[0];
    if (!file) return;

    /* 로컬 blob으로 즉시 프리뷰 */
    const localUrl = URL.createObjectURL(file);
    const wrap = document.getElementById(`ispreviewwrap${id}`);
    wrap.innerHTML = '';
    wrap.className = '';
    wrap.style.cssText = 'width:48px; height:48px; flex-shrink:0;';
    const preview = document.createElement('img');
    preview.src       = localUrl;
    preview.className = 'imgsticker-preview';
    wrap.appendChild(preview);

    const el = document.getElementById(`imgstickerel${id}`);
    el.src           = localUrl;
    el.style.display = 'block';
    updateImgStickerStyle(id);

    /* Storage 업로드 */
    if (!USE_SUPABASE || !supabaseClient) return;

    /* ── 업로드 시작: A B 모두 오버레이 즉시 ON ── */
    window._isUploading = true;
    setImgOverlay(true, '스티커 업로드 중입니다.');
    broadcastOverlay(true, '스티커 업로드 중입니다.');

    try {
        const ext  = file.name.split('.').pop() || 'png';
        const path = `stickers/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

        if (imgStickerPaths[id]) {
            supabaseClient.storage.from(STORAGE_BUCKET).remove([imgStickerPaths[id]]);
        }
        imgStickerPaths[id] = path;

        const { error } = await supabaseClient.storage
            .from(STORAGE_BUCKET)
            .upload(path, file, { upsert: true, contentType: file.type });

        if (error) {
            console.error('[ImgSticker] 업로드 실패:', error);
            window._isUploading = false;
            setImgOverlay(false);
            broadcastOverlay(false);
            return;
        }

        const { data } = supabaseClient.storage.from(STORAGE_BUCKET).getPublicUrl(path);
        const publicUrl = data.publicUrl;

        el.setAttribute('crossorigin', 'anonymous');
        el.setAttribute('data-storage-url', publicUrl);

        /* ── A: 이미지 로드 완료 시 오버레이 OFF → B도 로드 시작 ── */
        el.onload = () => {
            window._isUploading = false;
            setImgOverlay(false);
            broadcastOverlay(false);
            broadcastState();
        };
        el.src = publicUrl;

    } catch (err) {
        console.error('[ImgSticker] 업로드 오류:', err);
        window._isUploading = false;
        setImgOverlay(false);
        broadcastOverlay(false);
    }
}

function updateImgStickerStyle(id) {
    const el = document.getElementById(`imgstickerel${id}`);
    if (!el) return;
    const size = document.getElementById(`issize${id}`).value;
    el.style.width  = size + 'px';
    el.style.height = 'auto';
    broadcastState();
}

function resetImgStickerAngle(id) {
    const el = document.getElementById(`imgstickerel${id}`);
    if (!el) return;
    el.setAttribute('data-angle', 0);
    el.style.transform = 'rotate(0deg)';
    broadcastState();
}

function removeImgSticker(id) {
    /* Storage 파일 삭제 */
    if (USE_SUPABASE && supabaseClient && imgStickerPaths[id]) {
        supabaseClient.storage.from(STORAGE_BUCKET).remove([imgStickerPaths[id]]);
        delete imgStickerPaths[id];
    }
    document.getElementById(`imgstickerrow${id}`)?.remove();
    document.getElementById(`imgstickerel${id}`)?.remove();
    broadcastState();
}

function setupImgStickerInteract(id) {
    const el = document.getElementById(`imgstickerel${id}`);

    interact(el).draggable({
        listeners: {
            move(e) {
                const x     = (parseFloat(el.getAttribute('data-x')) || 0) + e.dx;
                const y     = (parseFloat(el.getAttribute('data-y')) || 0) + e.dy;
                const angle = parseFloat(el.getAttribute('data-angle')) || 0;
                el.style.left      = x + 'px';
                el.style.top       = y + 'px';
                el.style.transform = `rotate(${angle}deg)`;
                el.setAttribute('data-x', x);
                el.setAttribute('data-y', y);
                broadcastState();
            }
        }
    });

    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        let angle = (parseFloat(el.getAttribute('data-angle')) || 0) + e.deltaY * 0.3;
        el.style.transform = `rotate(${angle}deg)`;
        el.setAttribute('data-angle', angle);
        broadcastState();
    }, { passive: false });
}

/* ─── 메인 이미지 로드 & 인터랙션 ───────────────────────────────── */
/**
 * 이미지 업로드 흐름:
 * 1. 파일 선택 → 로컬 blob URL로 즉시 프리뷰 표시 (UX 빠르게)
 * 2. Supabase Storage 업로드 (비동기)
 * 3. 업로드 완료 → img.src를 public URL로 교체 + data-storage-url 저장
 * 4. syncAll() → broadcast 시 imgUrl 포함되어 상대방에게 전달
 */
async function loadImg(e) {
    const img    = document.getElementById('targetImg');
    const delBtn = document.getElementById('delBtn');
    const file   = e.target.files[0];
    if (!file) return;

    /* 즉시 로컬 프리뷰 */
    const localUrl = URL.createObjectURL(file);
    img.src = localUrl;
    img.removeAttribute('data-storage-url');
    img.onload = () => {
        const ratio = img.naturalWidth / img.naturalHeight;
        img.style.height = ratio > 1 ? '100%' : 'auto';
        img.style.width  = ratio > 1 ? 'auto' : '100%';
        img.style.transform = 'translate(0px, 0px) scale(1)';
        img.setAttribute('data-x', 0);
        img.setAttribute('data-y', 0);
        img.setAttribute('data-scale', 1);
        img.classList.remove('hidden');
        delBtn.classList.remove('hidden');
    };

    /* Supabase Storage 업로드 (미설정 시 로컬 blob만 사용 — 공유는 안 됨) */
    if (!USE_SUPABASE || !supabaseClient) return;

    /* ── 업로드 시작: A도 오버레이 ON, broadcastOverlay로 B도 즉시 ON ── */
    window._isUploading = true;
    setImgOverlay(true, '이미지를 수정 중입니다.');
    broadcastOverlay(true, '이미지를 수정 중입니다.');

    try {
        /* 이전 파일 삭제 */
        if (currentImgPath) {
            supabaseClient.storage.from(STORAGE_BUCKET).remove([currentImgPath]);
            currentImgPath = null;
        }

        const ext  = file.name.split('.').pop() || 'png';
        const path = `uploads/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        currentImgPath = path;

        console.log('[Storage] 업로드 시작:', path);

        const { error: uploadError } = await supabaseClient.storage
            .from(STORAGE_BUCKET)
            .upload(path, file, { upsert: true, contentType: file.type });

        if (uploadError) {
            console.error('[Storage] 업로드 실패:', uploadError);
            window._isUploading = false;
            setImgOverlay(false);
            broadcastOverlay(false);
            return;
        }

        const { data } = supabaseClient.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(path);

        const publicUrl = data.publicUrl;
        console.log('[Storage] 업로드 완료:', publicUrl);

        img.setAttribute('crossorigin', 'anonymous');
        img.setAttribute('data-storage-url', publicUrl);

        /* ── A: public URL onload 완료 시 오버레이 OFF ── */
        img.onload = () => {
            window._isUploading = false;
            setImgOverlay(false);
            broadcastOverlay(false);
            syncAll(); // imgUrl 포함 broadcast → B도 이미지 로드 시작
        };
        img.src = publicUrl;

    } catch (err) {
        console.error('[Storage] 업로드 오류:', err);
        window._isUploading = false;
        setImgOverlay(false);
        broadcastOverlay(false);
    }
}

async function resetImg() {
    const img       = document.getElementById('targetImg');
    const fileInput = document.getElementById('fileInput');
    const delBtn    = document.getElementById('delBtn');

    /* Storage 파일 삭제 */
    if (USE_SUPABASE && currentImgPath && supabaseClient) {
        await supabaseClient.storage.from(STORAGE_BUCKET).remove([currentImgPath]);
        currentImgPath = null;
    }

    img.src = '';
    img.removeAttribute('data-storage-url');
    img.classList.add('hidden');
    fileInput.value = '';
    delBtn.classList.add('hidden');

    /* 슬라이더 숨김 */
    const wrap = document.getElementById('imgScaleWrap');
    if (wrap) { wrap.classList.add('hidden'); wrap.classList.remove('flex'); }

    syncAll();
}

function setupImgInteract() {
    interact('#targetImg').draggable({
        listeners: {
            move(e) {
                const img   = e.target;
                const dataX = (parseFloat(img.getAttribute('data-x')) || 0) + e.dx;
                const dataY = (parseFloat(img.getAttribute('data-y')) || 0) + e.dy;
                const scale = parseFloat(img.getAttribute('data-scale')) || 1;
                img.style.transform = `translate(${dataX}px, ${dataY}px) scale(${scale})`;
                img.setAttribute('data-x', dataX);
                img.setAttribute('data-y', dataY);
                broadcastState(); // 드래그 위치 실시간 sync
            }
        }
    });

    document.getElementById('imgContainer').addEventListener('wheel', (e) => {
        e.preventDefault();
        const img   = document.getElementById('targetImg');
        let scale   = parseFloat(img.getAttribute('data-scale')) || 1;
        const dataX = parseFloat(img.getAttribute('data-x')) || 0;
        const dataY = parseFloat(img.getAttribute('data-y')) || 0;
        /* 음수 방지 — 최소 0.1 */
        scale = Math.min(Math.max(0.1, scale + e.deltaY * -0.001), 4);
        img.style.transform = `translate(${dataX}px, ${dataY}px) scale(${scale})`;
        img.setAttribute('data-scale', scale);

        /* 슬라이더 양방향 연동 */
        const slider = document.getElementById('imgScaleSlider');
        if (slider) slider.value = Math.round(scale * 100);

        broadcastState(); // 휠 확대/축소 실시간 sync
    }, { passive: false });
}

/* ─── 확대/축소 슬라이더 핸들러 ─────────────────────────────────── */
function onScaleSlider(val) {
    const img   = document.getElementById('targetImg');
    if (!img || img.classList.contains('hidden')) return;
    const scale = val / 100;
    const dataX = parseFloat(img.getAttribute('data-x')) || 0;
    const dataY = parseFloat(img.getAttribute('data-y')) || 0;
    img.style.transform = `translate(${dataX}px, ${dataY}px) scale(${scale})`;
    img.setAttribute('data-scale', scale);
    broadcastState();
}

/* ─── 이미지 저장 ────────────────────────────────────────────────── */
async function saveImg() {
    const area    = document.getElementById('captureArea');
    const loading = document.getElementById('loadingOverlay');
    loading.style.display = 'flex';

    const scrollY = window.scrollY;
    window.scrollTo(0, 0);

    try {
        const canvas = await html2canvas(area, {
            scale:           2,
            useCORS:         true,
            allowTaint:      true,
            backgroundColor: state.bg,
            logging:         false,
            width:           area.offsetWidth,
            height:          area.offsetHeight,
            onclone: (clonedDoc) => {
                /* 텍스트 세로 보정 */
                clonedDoc.querySelectorAll('.truncate-text').forEach(el => {
                    el.style.transform  = 'translateY(-10px)';
                    el.style.lineHeight = '1';
                });
                /* 텍스트 스티커 보정 */
                clonedDoc.querySelectorAll('[id^="stickerel"]').forEach(st => {
                    st.style.display         = 'flex';
                    st.style.alignItems      = 'center';
                    st.style.justifyContent  = 'center';
                    st.style.overflow        = 'hidden';
                    st.style.fontSize        = '10px';
                    const span = st.querySelector('span');
                    if (span) {
                        span.style.display     = 'inline-block';
                        span.style.lineHeight  = '1';
                        span.style.transform   = 'translateY(-6px)';
                    }
                });
            }
        });

        const link      = document.createElement('a');
        link.download   = '성향 체크표.png';
        link.href       = canvas.toDataURL('image/png', 1.0);
        link.click();

    } catch (err) {
        console.error('저장 오류:', err);
    } finally {
        loading.style.display = 'none';
        window.scrollTo(0, scrollY);
    }
}

/* ─── 초기화 ─────────────────────────────────────────────────────── */
function init() {
    const group   = document.getElementById('traitsGroup');
    const display = document.getElementById('slidersDisplay');

    traits.forEach((t, i) => {
        /* 에디터 슬라이더 행 */
        group.innerHTML += `
<div class="space-y-3">
    <div class="flex items-center gap-2">
        <div id="icon-${i}" class="head-icon bg-gray-200 shrink-0"></div>
        <input type="text" id="trait-in-${i}" value="${t}" readonly
               onblur="disableEdit(${i})" oninput="touchField('traitLabels',${i});syncAll()"
               class="text-[13px] font-bold bg-transparent outline-none flex-1 border-none cursor-default">
        <span id="btn-${i}" onclick="enableEdit(${i})" class="edit-btn text-xs">✏️</span>
    </div>
    <div class="space-y-3 px-1">
        <input type="range" id="range-${i}-1" value="50" oninput="touchField('sliderVals',[${i},0]);syncAll()" class="slider-a">
        <input type="range" id="range-${i}-2" value="50" oninput="touchField('sliderVals',[${i},1]);syncAll()" class="slider-b">
    </div>
</div>`;

        /* 프리뷰 슬라이더 카드 */
        display.innerHTML += `
<div class="bg-black/[0.03] p-6 rounded-[16px] flex flex-col justify-center border border-black/[0.02] h-[130px]">
    <div class="mb-4 w-full" style="overflow:visible; min-height:1.8em;">
        <p id="t-title-${i}" class="text-[14px] font-bold opacity-100 tracking-tight truncate-text"></p>
    </div>
    <div class="space-y-4">
        <div class="relative h-2 w-full bg-black/5 rounded-full">
            <div id="t-bar-${i}-1" class="h-full rounded-full"></div>
            <div id="t-thumb-${i}-1" class="fake-thumb"></div>
        </div>
        <div class="relative h-2 w-full bg-black/5 rounded-full">
            <div id="t-bar-${i}-2" class="h-full rounded-full"></div>
            <div id="t-thumb-${i}-2" class="fake-thumb"></div>
        </div>
    </div>
</div>`;
    });

    syncAll();
    setupImgInteract();
    initOnboarding();
    autoConnectFromURL(); // URL room 파라미터 자동 연결
}

/* ─── 채팅 ───────────────────────────────────────────────────────── */
/* 세션 고유 userId 생성 (내 메시지 판별용) */
const MY_USER_ID = (() => {
    let id = sessionStorage.getItem('chatUserId');
    if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('chatUserId', id);
    }
    return id;
})();

let chatOpen      = false;
let unreadCount   = 0;

function toggleChat() {
    chatOpen = !chatOpen;
    const modal    = document.getElementById('chatModal');
    const iconOpen  = document.getElementById('chatIconOpen');
    const iconClose = document.getElementById('chatIconClose');

    if (chatOpen) {
        modal.classList.remove('hidden');
        iconOpen.classList.add('hidden');
        iconClose.classList.remove('hidden');
        /* 읽지 않은 메시지 초기화 */
        unreadCount = 0;
        updateChatBadge();
        /* 스크롤 맨 아래 */
        scrollChatToBottom();
        document.getElementById('chatInput').focus();
    } else {
        modal.classList.add('hidden');
        iconOpen.classList.remove('hidden');
        iconClose.classList.add('hidden');
    }
}

function sendChat() {
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;
    if (!currentRoom) {
        alert('room에 연결한 후 채팅을 사용할 수 있습니다.');
        return;
    }

    const msg = { userId: MY_USER_ID, text, time: Date.now() };

    /* 내 화면에 즉시 표시 */
    appendChatMessage(msg, true);

    /* 상대방에게 전송 */
    if (USE_SUPABASE && realtimeChannel) {
        realtimeChannel.send({ type: 'broadcast', event: 'chat', payload: msg });
    } else if (bcChannel) {
        bcChannel.postMessage({ type: 'chat', payload: msg });
    }

    input.value = '';
    input.focus();
}

function appendChatMessage(msg, isMine) {
    const container = document.getElementById('chatMessages');
    const wrap = document.createElement('div');
    wrap.className = `flex ${isMine ? 'justify-end' : 'justify-start'}`;

    const time = new Date(msg.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

    wrap.innerHTML = `
        <div class="max-w-[80%] flex flex-col ${isMine ? 'items-end' : 'items-start'} gap-0.5">
            <div class="px-3 py-2 rounded-2xl text-xs leading-relaxed break-words
                ${isMine
                    ? 'bg-black text-white rounded-tr-sm'
                    : 'bg-gray-100 text-gray-800 rounded-tl-sm'}"
            >${escapeHtml(msg.text)}</div>
            <span class="text-[9px] text-gray-400">${time}</span>
        </div>`;

    container.appendChild(wrap);
    scrollChatToBottom();
}

function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function scrollChatToBottom() {
    const el = document.getElementById('chatMessages');
    if (el) el.scrollTop = el.scrollHeight;
}

function updateChatBadge() {
    const badge = document.getElementById('chatBadge');
    if (!badge) return;
    if (unreadCount > 0 && !chatOpen) {
        badge.classList.remove('hidden');
        badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
    } else {
        badge.classList.add('hidden');
    }
}

function updateChatRoomLabel() {
    const label = document.getElementById('chatRoomLabel');
    if (!label) return;
    label.textContent = currentRoom ? `#${currentRoom}` : 'room 연결 후 사용 가능';
}

/* ─── 브라우저 종료 시 Storage 파일 전체 삭제 ───────────────────── */
window.addEventListener('beforeunload', () => {
    if (!USE_SUPABASE || !supabaseClient) return;

    const paths = [];

    /* 메인 이미지 */
    if (currentImgPath) paths.push(currentImgPath);

    /* 이미지 스티커 */
    Object.values(imgStickerPaths).forEach(p => paths.push(p));

    if (paths.length === 0) return;

    /* sendBeacon으로 비동기 삭제 요청 (브라우저 종료 시에도 전송 보장) */
    const url = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`;
    navigator.sendBeacon(
        `${SUPABASE_URL}/functions/v1/cleanup`, // 없으면 아래 fetch로 대체
        JSON.stringify({ paths })
    );

    /* sendBeacon 미지원 대비 — 동기 fetch (best effort) */
    try {
        supabaseClient.storage.from(STORAGE_BUCKET).remove(paths);
    } catch (_) {}
});

/* DOM 준비 후 실행 */
document.addEventListener('DOMContentLoaded', init);