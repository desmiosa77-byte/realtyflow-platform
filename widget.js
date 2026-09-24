(function () {
  const scriptTag = document.currentScript;
  const tenantId = scriptTag.getAttribute('data-tenant');
  const apiBase = new URL(scriptTag.src).origin;

  if (!tenantId) {
    console.error('RealtyFlow widget: missing data-tenant attribute on the script tag.');
    return;
  }

  const storageKey = `realtyflow_lead_${tenantId}`;
  let leadId = localStorage.getItem(storageKey) || null;

  // ---------- STYLES ----------
  const style = document.createElement('style');
  style.textContent = `
    #rf-bubble { position: fixed; bottom: 20px; right: 20px; width: 56px; height: 56px;
      border-radius: 50%; background: #1a7f5a; color: #fff; display: flex; align-items: center;
      justify-content: center; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.2); z-index: 999998; font-size: 24px; }
    #rf-window { position: fixed; bottom: 88px; right: 20px; width: 320px; max-width: 90vw; height: 440px;
      background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); display: none;
      flex-direction: column; overflow: hidden; z-index: 999999; font-family: system-ui, sans-serif; }
    #rf-header { background: #1a7f5a; color: #fff; padding: 12px 16px; font-weight: 600; font-size: 14px; }
    #rf-messages { flex: 1; overflow-y: auto; padding: 12px; font-size: 14px; }
    #rf-messages .rf-msg { margin-bottom: 10px; padding: 8px 12px; border-radius: 10px; max-width: 80%; line-height: 1.4; }
    #rf-messages .rf-user { background: #e6f4ee; margin-left: auto; }
    #rf-messages .rf-assistant { background: #f1f1f1; }
    #rf-input-row { display: flex; border-top: 1px solid #eee; }
    #rf-input { flex: 1; border: none; padding: 10px 12px; font-size: 14px; outline: none; }
    #rf-send { border: none; background: #1a7f5a; color: #fff; padding: 0 16px; cursor: pointer; }
  `;
  document.head.appendChild(style);

  // ---------- DOM ----------
  const bubble = document.createElement('div');
  bubble.id = 'rf-bubble';
  bubble.innerText = '💬';

  const win = document.createElement('div');
  win.id = 'rf-window';
  win.innerHTML = `
    <div id="rf-header">Chat with us</div>
    <div id="rf-messages"></div>
    <div id="rf-input-row">
      <input id="rf-input" type="text" placeholder="Type a message..." />
      <button id="rf-send">Send</button>
    </div>
  `;

  document.body.appendChild(bubble);
  document.body.appendChild(win);

  const messagesEl = win.querySelector('#rf-messages');
  const inputEl = win.querySelector('#rf-input');
  const sendBtn = win.querySelector('#rf-send');

  bubble.addEventListener('click', () => {
    win.style.display = win.style.display === 'flex' ? 'none' : 'flex';
    if (messagesEl.children.length === 0) {
      addMessage('assistant', "Hey! What are you looking for — buy, rent, or just browsing?");
    }
  });

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `rf-msg rf-${role}`;
    div.innerText = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addMessage('user', text);

    try {
      const res = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, leadId, message: text })
      });
      const data = await res.json();

      if (data.leadId && data.leadId !== leadId) {
        leadId = data.leadId;
        localStorage.setItem(storageKey, leadId);
      }

      addMessage('assistant', data.reply);
      if (data.handoffMessage) {
        addMessage('assistant', data.handoffMessage);
      }
    } catch (err) {
      addMessage('assistant', "Sorry, something went wrong. Please try again.");
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });
})();
