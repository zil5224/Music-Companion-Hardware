// ═══════════════════════════════════════════════════════════════
//  网易云扫码登录系统（防缓存 · 一键登出 · 无缝换绑）
// ═══════════════════════════════════════════════════════════════
let qrKey = null;
let qrTimer = null;
const qrOverlay = document.getElementById('qrOverlay');
const qrImage = document.getElementById('qrImage');
const qrStatus = document.getElementById('qrStatus');
const btnRefreshQr = document.getElementById('btnRefreshQr');
const btnLogin = document.getElementById('btnLogin');

function updateLoginStatusUI(){
  const cookie = localStorage.getItem('netease_cookie');
  if(cookie){
    btnLogin.textContent = '🚪 退出/切换账号';
    btnLogin.className = 'btn-login logged-in';
  } else {
    btnLogin.textContent = '🔑 绑定网易云';
    btnLogin.className = 'btn-login guest';
  }
}

function handleLoginClick(){
  const cookie = localStorage.getItem('netease_cookie');
  if(cookie){
    handleLogout();
  } else {
    openQrModal();
  }
}

function handleLogout(){
  // 1. 清除本地 Cookie
  localStorage.removeItem('netease_cookie');
  // 2. 强制停止轮询
  stopQrPolling();
  // 3. 暂停播放器，回归游客模式
  audio.pause();
  // 4. 登录切换提示
  addAIMsg('已退出旧账号。子夜正在生成新的登录二维码。');
  // 5. 更新按钮状态
  updateLoginStatusUI();
  // 6. 自动立即拉起全新二维码
  openQrModal();
}

async function openQrModal(){
  stopQrPolling();
  qrKey = null;
  qrImage.src = '';
  qrStatus.textContent = '正在生成新鲜二维码…';
  btnRefreshQr.style.display = 'none';
  qrOverlay.classList.add('open');

  try {
    // 第一步：获取唯一 key（防缓存：timestamp + 随机数）
    const antiCache = 'timestamp=' + Date.now() + '&_r=' + Math.random().toString(36).substring(2);
    const keyResp = await fetch(NE_API + '/login/qr/key?' + antiCache);
    if(!keyResp.ok) throw new Error('key 接口 HTTP ' + keyResp.status);
    const keyData = await keyResp.json();
    if(!keyData.data || !keyData.data.unikey){
      qrStatus.textContent = '❌ 获取登录密钥失败，请重试';
      btnRefreshQr.style.display = 'inline-block';
      return;
    }
    qrKey = keyData.data.unikey;

    // 第二步：生成二维码图片（防缓存）
    const createUrl = NE_API + '/login/qr/create?key=' + qrKey + '&qrimg=true&' + antiCache;
    const createResp = await fetch(createUrl);
    if(!createResp.ok) throw new Error('create 接口 HTTP ' + createResp.status);
    const createData = await createResp.json();
    if(!createData.data || !createData.data.qrimg){
      qrStatus.textContent = '❌ 生成二维码失败，请重试';
      btnRefreshQr.style.display = 'inline-block';
      return;
    }
    qrImage.src = createData.data.qrimg;
    qrStatus.textContent = '📱 请使用网易云音乐 App 扫码';
    btnRefreshQr.style.display = 'inline-block';

    // 第三步：启动 3 秒轮询
    startQrPolling(qrKey);
  } catch(e){
    console.error('[QR] 二维码请求失败');
    qrStatus.textContent = '❌ 二维码请求失败，请稍后重试';
    btnRefreshQr.style.display = 'inline-block';
  }
}

function closeQrModal(){
  stopQrPolling();
  qrKey = null;
  qrOverlay.classList.remove('open');
}

function stopQrPolling(){
  if(qrTimer){ clearInterval(qrTimer); qrTimer = null; }
}

function startQrPolling(key){
  stopQrPolling();
  let pollCount = 0;
  const MAX_POLLS = 200; // 最多轮询 10 分钟
  qrTimer = setInterval(async () => {
    pollCount++;
    if(pollCount > MAX_POLLS){
      stopQrPolling();
      qrStatus.textContent = '⏰ 二维码已超时，请点击刷新';
      return;
    }
    try {
      const antiCache = 'timestamp=' + Date.now() + '&_r=' + Math.random().toString(36).substring(2);
      const checkResp = await fetch(NE_API + '/login/qr/check?key=' + key + '&' + antiCache);
      if(!checkResp.ok) return;
      const checkData = await checkResp.json();
      const code = checkData.code || (checkData.data && checkData.data.code);

      if(code === 803){
        // 登录成功！保存完整 cookie 字符串
        stopQrPolling();
        qrStatus.textContent = '✅ 登录成功！';
        const cookieStr = (checkData.cookie || '')
          || (checkData.data && checkData.data.cookie || '');
        if(cookieStr){
          localStorage.setItem('netease_cookie', cookieStr);
        }
        updateLoginStatusUI();
        addAIMsg('网易云账号已登录。可播放的音源仍取决于账号和曲目的权限。');
        setTimeout(() => closeQrModal(), 1200);
      } else if(code === 800){
        qrStatus.textContent = '⏳ 二维码已过期，请点击刷新';
        stopQrPolling();
      } else if(code === 801){
        qrStatus.textContent = '📱 请在手机上确认登录…';
      } else if(code === 802){
        qrStatus.textContent = '✅ 已扫码，请在手机上确认授权';
      } else {
        // 继续等待
        if(pollCount % 10 === 0){
          qrStatus.textContent = '📱 请使用网易云音乐 App 扫码 (' + Math.floor(pollCount/20) + ' 分钟)';
        }
      }
    } catch(e){
      // 轮询失败不中断
    }
  }, 3000);
}
