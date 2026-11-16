// Dispatch AI's own 24/7 support chat bubble ("Need help?").
// Shown on pages listed in server.js (serveStaticFile). Talks to
// /api/help-chat (see lib/supportChat.js). Inside the client portal it also
// sends the client's private portal token, so the assistant can see a safe
// summary of their account and troubleshoot their real situation.
(function () {
  if (window.__dispatchSupportChat) return;
  window.__dispatchSupportChat = true;
  // The sign-up form already has its own help bubble (same brain) -- don't
  // show two.
  if (document.getElementById('helpChatWidget')) return;

  var STORAGE_KEY = 'dispatchSupportChat.v1';
  var GREETING = "Hi! I'm Dispatch AI's support assistant. Ask me anything about Dispatch AI, or tell me what's going wrong and I'll help you fix it.";

  var params = new URLSearchParams(window.location.search);
  var portalToken = /client-portal/.test(window.location.pathname) ? params.get('token') : null;

  var history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]') || []; } catch (e) { history = []; }
  function save() { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-30))); } catch (e) {} }

  var css =
    '.dsc-root{position:fixed;right:18px;bottom:18px;z-index:9000;font-family:Inter,system-ui,-apple-system,sans-serif;}' +
    '.dsc-toggle{display:flex;align-items:center;gap:8px;background:#e3a855;color:#0b0d10;border:none;border-radius:999px;padding:13px 18px;font-weight:600;font-size:14px;cursor:pointer;box-shadow:0 10px 24px -10px rgba(0,0,0,.6);font-family:inherit;}' +
    '.dsc-toggle:hover{background:#f0c178;}' +
    '.dsc-dot{width:8px;height:8px;border-radius:50%;background:#2f9e5b;box-shadow:0 0 0 3px rgba(47,158,91,.25);}' +
    '.dsc-panel{position:fixed;right:18px;bottom:18px;width:370px;height:540px;max-height:calc(100vh - 36px);background:#15181d;border:1px solid #262b32;border-radius:18px;box-shadow:0 20px 40px -16px rgba(0,0,0,.7);display:none;flex-direction:column;overflow:hidden;color:#efe9dd;}' +
    '.dsc-open .dsc-panel{display:flex;}.dsc-open .dsc-toggle{display:none;}' +
    '.dsc-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #262b32;background:#1b1f25;}' +
    '.dsc-title{font-weight:600;font-size:14.5px;}.dsc-sub{font-size:12px;color:#9aa0ab;margin-top:2px;display:flex;align-items:center;gap:6px;}' +
    '.dsc-close{background:none;border:none;color:#9aa0ab;font-size:24px;line-height:1;cursor:pointer;padding:0 0 0 12px;}' +
    '.dsc-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}' +
    '.dsc-msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}' +
    '.dsc-ai{background:#1f242b;border:1px solid #262b32;align-self:flex-start;border-bottom-left-radius:4px;}' +
    '.dsc-user{background:#e3a855;color:#0b0d10;align-self:flex-end;border-bottom-right-radius:4px;}' +
    '.dsc-msg a{color:#f0c178;text-decoration:underline;}.dsc-user a{color:#0b0d10;}' +
    '.dsc-typing{color:#9aa0ab;font-style:italic;}' +
    '.dsc-form{display:flex;gap:8px;padding:12px;border-top:1px solid #262b32;}' +
    '.dsc-input{flex:1;resize:none;background:#0b0d10;color:#efe9dd;border:1px solid #262b32;border-radius:10px;padding:10px 12px;font-size:16px;font-family:inherit;max-height:110px;}' +
    '.dsc-input:focus{outline:none;border-color:#4a3a20;}' +
    '.dsc-send{background:#e3a855;color:#0b0d10;border:none;border-radius:10px;padding:0 16px;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;}' +
    '.dsc-send:disabled{opacity:.5;cursor:default;}' +
    '.dsc-foot{font-size:11px;color:#6f7680;text-align:center;padding:0 12px 10px;}' +
    '@media (max-width:520px){.dsc-root{right:14px;bottom:14px;}.dsc-label{display:none;}.dsc-toggle{padding:14px;}' +
    '.dsc-panel{right:0;bottom:0;left:0;width:auto;height:85vh;max-height:85vh;border-radius:18px 18px 0 0;}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'dsc-root';
  root.innerHTML =
    '<button class="dsc-toggle" type="button" aria-label="Open support chat"><span class="dsc-dot"></span><span class="dsc-label">Need help?</span>' +
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
    '<div class="dsc-panel" role="dialog" aria-label="Dispatch AI support chat">' +
    '<div class="dsc-head"><div><div class="dsc-title">Dispatch AI Support</div><div class="dsc-sub"><span class="dsc-dot"></span>AI assistant - online 24/7</div></div>' +
    '<button class="dsc-close" type="button" aria-label="Close">&times;</button></div>' +
    '<div class="dsc-log" aria-live="polite"></div>' +
    '<form class="dsc-form"><textarea class="dsc-input" rows="1" placeholder="Type your question..." aria-label="Your message"></textarea><button class="dsc-send" type="submit">Send</button></form>' +
    '<div class="dsc-foot">AI assistant -- can pass anything it can\'t solve to the team.</div>' +
    '</div>';
  document.body.appendChild(root);

  var log = root.querySelector('.dsc-log');
  var input = root.querySelector('.dsc-input');
  var sendBtn = root.querySelector('.dsc-send');

  // Turns emails and site paths like /client-login into links, safely
  // (text is never inserted as HTML).
  function addText(el, text) {
    var re = /([\w.+-]+@[\w-]+\.[\w.]+|https?:\/\/[^\s)]+|\/(?:client-login|onboard|widget-guide|privacy|terms)\b)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      var t = m[0].replace(/[.,]+$/, '');
      // Only link a bare path like /onboard when it starts a word.
      if (t.charAt(0) === '/' && m.index > 0 && !/[\s(]/.test(text.charAt(m.index - 1))) continue;
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement('a');
      a.textContent = t;
      a.href = t.indexOf('@') > 0 && t.indexOf('http') !== 0 ? 'mailto:' + t : t;
      if (/^https?:/.test(t)) { a.target = '_blank'; a.rel = 'noopener'; }
      el.appendChild(a);
      last = m.index + t.length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  function bubble(role, text, extraClass) {
    var div = document.createElement('div');
    div.className = 'dsc-msg ' + (role === 'user' ? 'dsc-user' : 'dsc-ai') + (extraClass ? ' ' + extraClass : '');
    addText(div, text);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function renderAll() {
    log.innerHTML = '';
    bubble('ai', GREETING);
    history.forEach(function (m) { bubble(m.role, m.content); });
  }

  var rendered = false;
  function open() {
    if (!rendered) { renderAll(); rendered = true; }
    root.classList.add('dsc-open');
    setTimeout(function () { input.focus(); }, 50);
  }
  function close() { root.classList.remove('dsc-open'); }

  root.querySelector('.dsc-toggle').addEventListener('click', open);
  root.querySelector('.dsc-close').addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 110) + 'px'; });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); root.querySelector('.dsc-form').requestSubmit(); }
  });

  var busy = false;
  root.querySelector('.dsc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    input.value = ''; input.style.height = 'auto';
    history.push({ role: 'user', content: text });
    save();
    bubble('user', text);
    var typing = bubble('ai', 'Typing...', 'dsc-typing');

    fetch('/api/help-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: history, portalToken: portalToken, page: window.location.pathname })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        typing.remove();
        var reply = (data && data.text) || 'Sorry, something went wrong on my side. You can email dispatchai.uk@gmail.com and the team will help.';
        bubble('ai', reply);
        if (data && data.text && !data.rateLimited) { history.push({ role: 'assistant', content: data.text }); save(); }
      })
      .catch(function () {
        typing.remove();
        bubble('ai', "Sorry, I couldn't connect just now. Check your internet and try again, or email dispatchai.uk@gmail.com.");
      })
      .then(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  });

  // Lets any page open the chat from its own button: <a href="#support">
  if (window.location.hash === '#support') open();
  window.openDispatchSupport = open;
})();
