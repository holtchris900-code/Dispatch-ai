/*
 * Dispatch AI embeddable website chat widget.
 *
 * A client pastes one line into their own site:
 *   <script src="https://YOUR-DISPATCH-AI-URL/widget.js"
 *           data-client-id="THEIR_CLIENT_ID"
 *           data-company-name="Their Company Name"></script>
 *
 * Deliberately plain, dependency-free JavaScript -- this runs on someone
 * else's website, alongside whatever else is already there, so it can't
 * assume any framework or CSS is available, and its own styles are scoped
 * under a "dai-w-" prefix to avoid colliding with the host site's CSS.
 */
(function () {
  var d = document;

  var currentScript = d.currentScript;
  if (!currentScript) {
    var allScripts = d.getElementsByTagName('script');
    currentScript = allScripts[allScripts.length - 1];
  }

  var clientId = currentScript.getAttribute('data-client-id');
  if (!clientId) {
    console.error('Dispatch AI widget: add data-client-id="..." to your <script> tag.');
    return;
  }

  var headerTitle = currentScript.getAttribute('data-company-name') || 'Chat with us';
  var buttonLabel = currentScript.getAttribute('data-label') || 'Chat with us';

  var scriptSrc = currentScript.src || '';
  var apiBase = scriptSrc.replace(/\/widget\.js(\?.*)?$/, '');

  function escapeHtml(str) {
    var div = d.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function init() {
    var style = d.createElement('style');
    style.textContent =
      '.dai-w-toggle{position:fixed;right:20px;bottom:20px;z-index:2147483000;' +
      'background:#146856;color:#fff;border:none;border-radius:999px;padding:14px 18px;' +
      'font:600 14px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'cursor:pointer;box-shadow:0 20px 40px -12px rgba(15,23,32,0.28);}' +
      '.dai-w-toggle:hover{filter:brightness(1.06);}' +
      '.dai-w-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:320px;' +
      'max-width:calc(100vw - 40px);background:#fff;border:1px solid #e6e8ec;border-radius:18px;' +
      'box-shadow:0 20px 40px -12px rgba(15,23,32,0.28);overflow:hidden;display:none;' +
      'flex-direction:column;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}' +
      '.dai-w-panel.dai-open{display:flex;}' +
      '.dai-w-header{display:flex;align-items:flex-start;justify-content:space-between;' +
      'padding:14px 16px;border-bottom:1px solid #e6e8ec;background:#f6f7f9;}' +
      '.dai-w-title{font-weight:700;font-size:14px;color:#0f1720;}' +
      '.dai-w-badge{font-size:11px;color:#55606e;margin-top:2px;}' +
      '.dai-w-close{background:none;border:none;font-size:20px;color:#8892a0;cursor:pointer;line-height:1;padding:0;}' +
      '.dai-w-log{padding:14px;height:260px;overflow-y:auto;font-size:13.5px;}' +
      '.dai-w-msg{margin-bottom:10px;display:flex;}' +
      '.dai-w-msg.dai-ai{justify-content:flex-start;}' +
      '.dai-w-msg.dai-user{justify-content:flex-end;}' +
      '.dai-w-bubble{max-width:82%;padding:9px 13px;border-radius:14px;font-size:13.5px;white-space:pre-wrap;}' +
      '.dai-w-msg.dai-ai .dai-w-bubble{background:#e5f2ee;color:#0d4a3d;border-bottom-left-radius:4px;}' +
      '.dai-w-msg.dai-user .dai-w-bubble{background:#0f1720;color:#fff;border-bottom-right-radius:4px;}' +
      '.dai-w-inputrow{display:flex;gap:8px;padding:0 14px 14px;}' +
      '.dai-w-inputrow input{flex:1;padding:10px 12px;border-radius:10px;border:1px solid #e6e8ec;' +
      'font-size:14px;font-family:inherit;min-width:0;}' +
      '.dai-w-inputrow button{background:#146856;color:#fff;border:none;border-radius:10px;' +
      'padding:10px 14px;font-weight:600;font-size:13.5px;cursor:pointer;flex-shrink:0;}' +
      '.dai-w-footer{padding:6px 14px 12px;font-size:10.5px;color:#8892a0;text-align:center;}';
    d.head.appendChild(style);

    var toggle = d.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dai-w-toggle';
    toggle.textContent = buttonLabel;

    var panel = d.createElement('div');
    panel.className = 'dai-w-panel';
    panel.innerHTML =
      '<div class="dai-w-header">' +
        '<div><div class="dai-w-title">' + escapeHtml(headerTitle) + '</div><div class="dai-w-badge">AI assistant</div></div>' +
        '<button type="button" class="dai-w-close" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="dai-w-log"><div class="dai-w-msg dai-ai"><div class="dai-w-bubble">Hi! How can I help today?</div></div></div>' +
      '<div class="dai-w-inputrow"><input type="text" placeholder="Type a message..." /><button type="button">Send</button></div>' +
      '<div class="dai-w-footer">Powered by Dispatch AI</div>';

    d.body.appendChild(toggle);
    d.body.appendChild(panel);

    var log = panel.querySelector('.dai-w-log');
    var input = panel.querySelector('input');
    var sendBtn = panel.querySelector('.dai-w-inputrow button');
    var closeBtn = panel.querySelector('.dai-w-close');

    var history = [{ role: 'assistant', content: 'Hi! How can I help today?' }];

    function addBubble(role, text) {
      var msg = d.createElement('div');
      msg.className = 'dai-w-msg ' + (role === 'user' ? 'dai-user' : 'dai-ai');
      var bubble = d.createElement('div');
      bubble.className = 'dai-w-bubble';
      bubble.textContent = text;
      msg.appendChild(bubble);
      log.appendChild(msg);
      log.scrollTop = log.scrollHeight;
    }

    function send() {
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      addBubble('user', text);
      history.push({ role: 'user', content: text });
      addBubble('ai', '…');
      var placeholder = log.lastElementChild;

      fetch(apiBase + '/api/widget-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: clientId, messages: history })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          placeholder.remove();
          addBubble('ai', data.text || 'Sorry, something went wrong.');
          history.push({ role: 'assistant', content: data.text || '' });
        })
        .catch(function () {
          placeholder.remove();
          addBubble('ai', 'Sorry, something went wrong reaching the AI.');
        });
    }

    toggle.addEventListener('click', function () {
      panel.classList.toggle('dai-open');
      if (panel.classList.contains('dai-open')) input.focus();
    });
    closeBtn.addEventListener('click', function () { panel.classList.remove('dai-open'); });
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  }

  if (d.body) {
    init();
  } else {
    d.addEventListener('DOMContentLoaded', init);
  }
})();

