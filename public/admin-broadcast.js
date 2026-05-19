/* eslint-disable no-var */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // 0. init data + DOM refs
  // ------------------------------------------------------------------
  var initEl = document.getElementById('broadcast-init-data');
  var INIT = {};
  try {
    INIT = initEl ? JSON.parse(initEl.textContent || '{}') : {};
  } catch (e) {
    INIT = {};
  }
  var CHUNK_SIZE = Number(INIT.chunkSize) > 0 ? Number(INIT.chunkSize) : 50;

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // form state
  var state = {
    mode: 'template',
    heroMediaId: null,
    heroUrl: null,
    audiencePreviewedTotal: null,
    messagePreviewed: false,
    currentBroadcastId: null,
    sending: false
  };

  // ------------------------------------------------------------------
  // 1. tabs
  // ------------------------------------------------------------------
  $$('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode');
      state.mode = mode;
      $$('.tab-btn').forEach(function (b) { b.classList.toggle('active', b === btn); });
      $('pane-template').hidden = (mode !== 'template');
      $('pane-flex-json').hidden = (mode !== 'flex_json');
      state.messagePreviewed = false;
      updateSendButton();
      saveDraft();
    });
  });

  // ------------------------------------------------------------------
  // 2. condition collection
  // ------------------------------------------------------------------
  function collectConditions() {
    var prizeNames = $$('input[name="prize_name"]:checked').map(function (el) { return el.value; });
    var prizeFilter = null;
    if (prizeNames.length > 0) {
      prizeFilter = {
        mode: $('prize-mode').value || 'any',
        prizeNames: prizeNames
      };
    }
    var inviteMinRaw = $('invite-min').value.trim();
    var inviteCompletedMin = null;
    if (inviteMinRaw !== '') {
      var n = parseInt(inviteMinRaw, 10);
      if (Number.isInteger(n) && n > 0) inviteCompletedMin = n;
    }
    var drewRaw = $('drew-in-campaign').value;
    var drewInCampaign = null;
    if (drewRaw === 'true') drewInCampaign = true;
    else if (drewRaw === 'false') drewInCampaign = false;
    return { prizeFilter: prizeFilter, inviteCompletedMin: inviteCompletedMin, drewInCampaign: drewInCampaign };
  }

  // ------------------------------------------------------------------
  // 3. audience preview
  // ------------------------------------------------------------------
  $('btn-preview-audience').addEventListener('click', function () {
    var statusEl = $('audience-status');
    var sampleEl = $('audience-sample');
    statusEl.textContent = '查詢中…';
    sampleEl.hidden = true;
    sampleEl.innerHTML = '';
    fetch('/admin/broadcast/audience/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions: collectConditions() })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { statusEl.textContent = '查詢失敗：' + (data.error || ''); return; }
        if (data.error) {
          statusEl.textContent = data.error;
          state.audiencePreviewedTotal = null;
          updateSendButton();
          return;
        }
        state.audiencePreviewedTotal = data.total;
        statusEl.innerHTML = '預計送 <strong>' + data.total + '</strong> 人';
        if (data.total > (INIT.maxRecipients || 5000)) {
          statusEl.innerHTML += ' <span style="color:#b45309">（將自動 cap 至 ' + INIT.maxRecipients + ' 人）</span>';
        }
        if (data.sample && data.sample.length > 0) {
          var rows = data.sample.map(function (s) {
            return '<tr><td>' + s.id + '</td><td>' + escapeHtml(s.line_display_name || '') +
              '</td><td><code style="font-size:11px">' + escapeHtml(s.line_user_id || '') + '</code></td></tr>';
          }).join('');
          sampleEl.innerHTML = '<div style="margin-bottom:4px;font-weight:500;">前 ' + data.sample.length + ' 筆樣本</div>' +
            '<table><thead><tr><th>ID</th><th>顯示名</th><th>line_user_id</th></tr></thead><tbody>' + rows + '</tbody></table>';
          sampleEl.hidden = false;
        }
        updateSendButton();
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤：' + e.message; });
  });

  // ------------------------------------------------------------------
  // 4. hero upload
  // ------------------------------------------------------------------
  $('btn-hero-upload').addEventListener('click', function () {
    var fileInput = $('hero-file');
    var statusEl = $('hero-status');
    if (!fileInput.files || fileInput.files.length === 0) {
      statusEl.textContent = '請先選擇圖片';
      return;
    }
    var file = fileInput.files[0];
    if (file.size > 2 * 1024 * 1024) {
      statusEl.textContent = '檔案 > 2MB';
      return;
    }
    statusEl.textContent = '上傳中…';
    var fd = new FormData();
    fd.append('hero', file);
    fetch('/admin/broadcast/hero/upload', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { statusEl.textContent = '失敗：' + (data.error || ''); return; }
        state.heroMediaId = data.mediaId;
        state.heroUrl = data.url;
        statusEl.innerHTML = '已上傳 ✓ <a href="' + data.url + '" target="_blank" rel="noopener">查看</a>';
        state.messagePreviewed = false;
        updateSendButton();
        saveDraft();
      })
      .catch(function (e) { statusEl.textContent = '錯誤：' + e.message; });
  });

  // ------------------------------------------------------------------
  // 5. collect message config
  // ------------------------------------------------------------------
  function collectMessageConfig() {
    if (state.mode === 'flex_json') {
      var raw = $('flex-json').value;
      try {
        var parsed = JSON.parse(raw);
        return { mode: 'flex_json', flex: parsed };
      } catch (e) {
        return { mode: 'flex_json', flex: null, _parseError: e.message };
      }
    }
    return {
      mode: 'template',
      template: {
        heroMediaId: state.heroMediaId || null,
        title: $('tpl-title').value.trim(),
        subtitle: $('tpl-subtitle').value.trim(),
        couponCode: $('tpl-coupon-code').value.trim(),
        disclaimer: $('tpl-disclaimer').value.trim(),
        ctaLabel: $('tpl-cta-label').value.trim(),
        ctaUrl: $('tpl-cta-url').value.trim(),
        altText: $('tpl-alt').value.trim()
      }
    };
  }

  // ------------------------------------------------------------------
  // 6. message preview
  // ------------------------------------------------------------------
  $('btn-preview-msg').addEventListener('click', function () {
    var statusEl = $('msg-status');
    var previewEl = $('msg-preview');
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    statusEl.textContent = '預覽中…';
    fetch('/admin/broadcast/preview-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_config: cfg })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          statusEl.textContent = '錯誤：' + (data.error || '');
          state.messagePreviewed = false;
          previewEl.classList.add('empty');
          previewEl.innerHTML = '預覽失敗：' + escapeHtml(data.error || '');
          updateSendButton();
          return;
        }
        renderFlexMock(data.messages[0], previewEl);
        state.messagePreviewed = true;
        statusEl.textContent = '預覽 OK ✓';
        updateSendButton();
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤：' + e.message; });
  });

  // ------------------------------------------------------------------
  // 7. render Flex mock (簡化版客戶端 mock，僅針對我們的模板結構)
  // ------------------------------------------------------------------
  function renderFlexMock(flexMsg, container) {
    container.classList.remove('empty');
    container.innerHTML = '';
    if (!flexMsg || flexMsg.type !== 'flex' || !flexMsg.contents) {
      container.classList.add('empty');
      container.textContent = '無法預覽（非 Flex 訊息）';
      return;
    }
    var bubble = flexMsg.contents;
    if (bubble.hero && bubble.hero.url) {
      var heroDiv = document.createElement('div');
      heroDiv.className = 'lm-hero';
      var img = document.createElement('img');
      img.src = bubble.hero.url;
      img.alt = '';
      heroDiv.appendChild(img);
      container.appendChild(heroDiv);
    }
    var body = bubble.body;
    if (body && Array.isArray(body.contents)) {
      var bodyDiv = document.createElement('div');
      bodyDiv.className = 'lm-body';
      body.contents.forEach(function (c) {
        renderFlexComponent(c, bodyDiv);
      });
      container.appendChild(bodyDiv);
    }
  }

  function renderFlexComponent(c, parent) {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'text') {
      var t = document.createElement('div');
      var isTitle = (c.weight === 'bold' && c.size === 'xl');
      t.className = isTitle ? 'lm-title' : 'lm-subtitle';
      if (c.color) t.style.color = c.color;
      if (c.size && !isTitle) t.style.fontSize = mapFlexSize(c.size);
      if (c.weight === 'bold' && !isTitle) t.style.fontWeight = '700';
      if (c.align === 'center') t.style.textAlign = 'center';
      if (c.margin) t.style.marginTop = mapFlexSpacing(c.margin);
      if (c.lineSpacing) t.style.lineHeight = '1.55';
      t.textContent = String(c.text || '');
      parent.appendChild(t);
      return;
    }
    if (c.type === 'separator') {
      var s = document.createElement('div');
      s.className = 'lm-separator';
      if (c.color) s.style.background = c.color;
      if (c.margin) s.style.marginTop = mapFlexSpacing(c.margin);
      parent.appendChild(s);
      return;
    }
    if (c.type === 'box' && c.action && c.action.type === 'uri') {
      // CTA 模擬：黃底深字
      var a = document.createElement('a');
      a.className = 'lm-cta';
      a.href = c.action.uri || '#';
      a.target = '_blank';
      a.rel = 'noopener';
      if (c.backgroundColor) a.style.background = c.backgroundColor;
      if (c.margin) a.style.marginTop = mapFlexSpacing(c.margin);
      // 取第一個 text content 作為 label
      var label = '';
      if (Array.isArray(c.contents)) {
        for (var i = 0; i < c.contents.length; i++) {
          if (c.contents[i] && c.contents[i].type === 'text' && c.contents[i].text) {
            label = c.contents[i].text;
            if (c.contents[i].color) a.style.color = c.contents[i].color;
            break;
          }
        }
      }
      a.textContent = label || (c.action.label || 'OPEN');
      parent.appendChild(a);
      return;
    }
    if (c.type === 'button' && c.action) {
      var b = document.createElement('a');
      b.className = 'lm-cta';
      b.href = (c.action && c.action.uri) || '#';
      b.target = '_blank';
      b.rel = 'noopener';
      b.textContent = (c.action && c.action.label) || 'OPEN';
      if (c.color) b.style.background = c.color;
      if (c.margin) b.style.marginTop = mapFlexSpacing(c.margin);
      parent.appendChild(b);
      return;
    }
    if (c.type === 'box' && Array.isArray(c.contents)) {
      var sub = document.createElement('div');
      sub.className = 'lm-box';
      if (c.backgroundColor) sub.style.background = c.backgroundColor;
      if (c.borderWidth && c.borderColor) sub.style.border = c.borderWidth + ' solid ' + c.borderColor;
      else if (c.borderColor) sub.style.border = '1px solid ' + c.borderColor;
      if (c.cornerRadius) {
        sub.style.borderRadius =
          typeof c.cornerRadius === 'string' && /px$/.test(c.cornerRadius) ? c.cornerRadius : '8px';
      }
      if (c.paddingTop) sub.style.paddingTop = mapFlexSpacing(c.paddingTop);
      if (c.paddingBottom) sub.style.paddingBottom = mapFlexSpacing(c.paddingBottom);
      if (c.paddingStart) sub.style.paddingLeft = mapFlexSpacing(c.paddingStart);
      if (c.paddingEnd) sub.style.paddingRight = mapFlexSpacing(c.paddingEnd);
      if (c.paddingAll) {
        var pad = mapFlexSpacing(c.paddingAll);
        sub.style.padding = pad;
      }
      if (c.margin) sub.style.marginTop = mapFlexSpacing(c.margin);
      c.contents.forEach(function (cc) { renderFlexComponent(cc, sub); });
      parent.appendChild(sub);
    }
  }

  function mapFlexSize(s) {
    var m = { xs: '11px', sm: '13px', md: '14px', lg: '17px', xl: '19px', xxl: '24px', '3xl': '28px' };
    return m[s] || '14px';
  }

  function mapFlexSpacing(s) {
    if (typeof s === 'string' && /px$/.test(s)) return s;
    var m = { none: '0', xs: '4px', sm: '8px', md: '12px', lg: '18px', xl: '24px', xxl: '32px' };
    return m[s] || '0';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ------------------------------------------------------------------
  // 7b. test push（單筆，真的打 LINE API）
  // ------------------------------------------------------------------
  $('btn-test-push').addEventListener('click', function () {
    if (!INIT.hasLineToken) {
      alert('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法送出。');
      return;
    }
    var statusEl = $('test-push-status');
    var recipient = $('test-recipient').value.trim();
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    statusEl.textContent = '送出中…';
    var body = { message_config: cfg };
    if (recipient) {
      if (/^U[0-9a-f]{32}$/i.test(recipient)) {
        body.test_line_user_id = recipient;
      } else {
        body.test_member_name = recipient;
      }
    }
    fetch('/admin/broadcast/test-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          statusEl.innerHTML = '✓ 已送出到 <code style="font-size:12px">' + escapeHtml(data.sentTo || '') + '</code>';
        } else {
          var msg = errorMap(data.error);
          if (data.detail) msg += '｜' + data.detail;
          statusEl.textContent = '失敗：' + msg;
        }
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤：' + e.message; });
  });

  function errorMap(code) {
    var map = {
      no_line_channel_access_token: '未設定 LINE token',
      invalid_line_user_id: 'LINE userId 格式錯（需 U + 32 hex）',
      name_not_found: '找不到該會員顯示名稱或帳號',
      name_ambiguous: '有多人符合，請改填 LINE userId',
      no_recipient: '送給自己時你的帳號未綁定 LINE，請填入收件人',
      push_failed: 'LINE push 失敗（請至 line_push_logs 查 detail）'
    };
    return map[code] || code || 'unknown';
  }

  // ------------------------------------------------------------------
  // 8. send / process-chunk loop
  // ------------------------------------------------------------------
  function updateSendButton() {
    var btn = $('btn-send');
    var ready =
      INIT.hasLineToken &&
      state.audiencePreviewedTotal !== null &&
      state.audiencePreviewedTotal > 0 &&
      state.messagePreviewed &&
      !state.sending;
    btn.disabled = !ready;
  }

  $('btn-send').addEventListener('click', function () {
    if (!confirm('確定要送出？這將呼叫 LINE Push API，發出後無法回收。')) return;
    state.sending = true;
    updateSendButton();
    var progressWrap = $('send-progress');
    var bar = $('progress-bar-inner');
    var meta = $('progress-meta');
    var cancelBtn = $('btn-cancel');
    progressWrap.hidden = false;
    meta.textContent = '建立批次中…';
    bar.style.width = '0%';

    fetch('/admin/broadcast/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conditions: collectConditions(),
        message_config: collectMessageConfig(),
        send_mode: 'immediate'
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          meta.textContent = '建立失敗：' + (data.error || '');
          state.sending = false;
          updateSendButton();
          return;
        }
        state.currentBroadcastId = data.broadcastId;
        cancelBtn.hidden = false;
        meta.textContent = '批次 #' + data.broadcastId + ' 已建立，共 ' + data.total + ' 人。正在送出…';
        processChunkLoop(data.broadcastId, data.total, 0);
      })
      .catch(function (e) {
        meta.textContent = '網路錯誤：' + e.message;
        state.sending = false;
        updateSendButton();
      });
  });

  function processChunkLoop(broadcastId, total, processedSoFar) {
    var bar = $('progress-bar-inner');
    var meta = $('progress-meta');

    fetch('/admin/broadcast/' + broadcastId + '/process-chunk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chunkSize: CHUNK_SIZE })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          meta.textContent = '失敗：' + (data.error || '');
          state.sending = false;
          updateSendButton();
          return;
        }
        var newProcessed = processedSoFar + (data.processed || 0);
        var pct = total > 0 ? Math.round((newProcessed / total) * 100) : 100;
        bar.style.width = Math.min(100, pct) + '%';
        meta.textContent = '進度 ' + newProcessed + ' / ' + total +
          '（成功 ' + (data.ok_count !== undefined ? '+' + data.ok_count : '') +
          '、失敗 +' + (data.fail || 0) + '、跳過 +' + (data.skip || 0) +
          '）；剩餘 ' + (data.remaining || 0);

        if (data.done || data.status === 'cancelled') {
          if (data.status === 'cancelled') {
            meta.textContent += '。已取消。';
          } else {
            meta.textContent = '完成 ✓ 共處理 ' + newProcessed + ' 人。請至「近期批次」查看詳細。';
          }
          state.sending = false;
          $('btn-cancel').hidden = true;
          updateSendButton();
          return;
        }
        // 繼續下一輪
        setTimeout(function () { processChunkLoop(broadcastId, total, newProcessed); }, 300);
      })
      .catch(function (e) {
        meta.textContent = '網路錯誤：' + e.message + '，3 秒後重試…';
        setTimeout(function () { processChunkLoop(broadcastId, total, processedSoFar); }, 3000);
      });
  }

  $('btn-cancel').addEventListener('click', function () {
    if (!state.currentBroadcastId) return;
    if (!confirm('確定要取消這個批次？已送出的訊息無法回收，僅停止剩下未送的部分。')) return;
    fetch('/admin/broadcast/' + state.currentBroadcastId + '/cancel', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) alert('取消失敗：' + (data.error || ''));
        // chunk loop 下一輪會偵測到 cancelled status 自動停下
      });
  });

  // ------------------------------------------------------------------
  // 9. draft（localStorage 自動草稿）
  //    存：模板各欄位 + flex JSON + 測試收件人 + hero media id/url + tab mode
  //    不存：file binary、audience 條件、訊息預覽結果
  // ------------------------------------------------------------------
  var DRAFT_KEY = 'broadcast_draft_v1';
  var DRAFT_FIELDS = [
    'tpl-title', 'tpl-subtitle', 'tpl-coupon-code', 'tpl-disclaimer',
    'tpl-cta-label', 'tpl-cta-url', 'tpl-alt', 'flex-json', 'test-recipient'
  ];
  var draftSaveTimer = null;

  function saveDraft() {
    try {
      var d = {
        mode: state.mode,
        hero: { mediaId: state.heroMediaId || null, url: state.heroUrl || null },
        template: {
          title: $('tpl-title').value,
          subtitle: $('tpl-subtitle').value,
          couponCode: $('tpl-coupon-code').value,
          disclaimer: $('tpl-disclaimer').value,
          ctaLabel: $('tpl-cta-label').value,
          ctaUrl: $('tpl-cta-url').value,
          altText: $('tpl-alt').value
        },
        flexJson: $('flex-json').value,
        testRecipient: $('test-recipient').value,
        _t: Date.now()
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      var ds = $('draft-status-time');
      if (ds) ds.textContent = '已自動儲存 ' + new Date(d._t).toLocaleTimeString('zh-TW');
    } catch (e) { /* quota / denied: silent */ }
  }

  function scheduleSave() {
    if (draftSaveTimer) clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(saveDraft, 300);
  }

  function loadDraft() {
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return false;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return false;
      var tpl = d.template || {};
      if (tpl.title != null) $('tpl-title').value = tpl.title;
      if (tpl.subtitle != null) $('tpl-subtitle').value = tpl.subtitle;
      if (tpl.couponCode != null) $('tpl-coupon-code').value = tpl.couponCode;
      if (tpl.disclaimer != null) $('tpl-disclaimer').value = tpl.disclaimer;
      if (tpl.ctaLabel != null) $('tpl-cta-label').value = tpl.ctaLabel;
      if (tpl.ctaUrl != null) $('tpl-cta-url').value = tpl.ctaUrl;
      if (tpl.altText != null) $('tpl-alt').value = tpl.altText;
      if (d.flexJson != null) $('flex-json').value = d.flexJson;
      if (d.testRecipient != null) $('test-recipient').value = d.testRecipient;
      if (d.hero && d.hero.mediaId) {
        state.heroMediaId = d.hero.mediaId;
        state.heroUrl = d.hero.url || null;
        var hs = $('hero-status');
        if (hs) {
          if (d.hero.url) {
            hs.innerHTML = '已上傳（草稿）✓ <a href="' + d.hero.url +
              '" target="_blank" rel="noopener">查看</a>';
          } else {
            hs.textContent = '已存草稿 (mediaId: ' + d.hero.mediaId.slice(0, 8) + '…)';
          }
        }
      }
      if (d.mode === 'flex_json') {
        var jsonBtn = document.querySelector('.tab-btn[data-mode="flex_json"]');
        if (jsonBtn) jsonBtn.click();
      }
      var ds = $('draft-status-time');
      if (ds && d._t) {
        ds.textContent = '已從草稿載入（' + new Date(d._t).toLocaleString('zh-TW') + '）';
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearDraft() {
    if (!confirm('確定清除草稿？這會把目前填的所有欄位清空。')) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    DRAFT_FIELDS.forEach(function (id) {
      var el = $(id);
      if (el) el.value = '';
    });
    state.heroMediaId = null;
    state.heroUrl = null;
    var hs = $('hero-status');
    if (hs) hs.textContent = '未上傳';
    var ds = $('draft-status-time');
    if (ds) ds.textContent = '已清除草稿';
  }

  DRAFT_FIELDS.forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', scheduleSave);
  });
  var btnClearDraft = $('btn-clear-draft');
  if (btnClearDraft) btnClearDraft.addEventListener('click', clearDraft);

  // 啟動：嘗試 restore 上次的草稿
  loadDraft();
})();
