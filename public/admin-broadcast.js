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
    bHeroMediaId: null,
    bHeroUrl: null,
    audienceSource: 'conditions',  // 'conditions' | 'saved_list' | 'upload'
    audiencePreviewedTotal: null,
    messagePreviewed: false,
    currentBroadcastId: null,
    sending: false,
    sendMode: 'immediate',  // 'immediate' | 'scheduled'
    abTestEnabled: false,
    themeColor: null        // 主題底色：目前被當作「深色主題」的 backgroundColor 值
  };

  // ------------------------------------------------------------------
  // 0b. 個人化變數提示：在標題 / 副標題欄位旁加「插入 {暱稱}」鈕
  //     送出時系統會自動把 {暱稱} 換成每位收件人的 LINE 名稱（沒名稱時用「饕客」）。
  // ------------------------------------------------------------------
  function insertTokenAtCursor(input, token) {
    if (!input) return;
    var start = input.selectionStart;
    var end = input.selectionEnd;
    if (typeof start === 'number' && typeof end === 'number') {
      input.value = input.value.slice(0, start) + token + input.value.slice(end);
      var pos = start + token.length;
      input.setSelectionRange(pos, pos);
    } else {
      input.value = input.value + token;
    }
    input.focus();
    // 觸發既有的 input 監聽（草稿儲存 + 即時預覽）
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function addPersonalizationHint(inputId, withButton) {
    var input = $(inputId);
    if (!input || input.dataset.personalizeHinted === '1') return;
    input.dataset.personalizeHinted = '1';
    var hint = document.createElement('div');
    hint.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:#6B6B70;';
    if (withButton) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '插入 {暱稱}';
      btn.style.cssText = 'padding:3px 10px;border:1px solid #FCC726;background:#FFFBEB;color:#1f2937;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;';
      btn.addEventListener('click', function () { insertTokenAtCursor(input, '{暱稱}'); });
      hint.appendChild(btn);
    }
    var txt = document.createElement('span');
    txt.textContent = '可用 {暱稱}，送出時自動換成每個人的名稱（沒名稱用「饕客」），預覽顯示「饕客」。';
    hint.appendChild(txt);
    if (input.parentNode) input.parentNode.insertBefore(hint, input.nextSibling);
  }

  // 標題、副標題加按鈕；其他文字欄只加文字提示（避免畫面太擠）
  addPersonalizationHint('tpl-title', true);
  addPersonalizationHint('tpl-subtitle', true);
  addPersonalizationHint('b-tpl-title', true);
  addPersonalizationHint('b-tpl-subtitle', true);

  // ------------------------------------------------------------------
  // 1. tabs
  // ------------------------------------------------------------------
  // 模式切換：details 展開 = flex_json mode；折疊 = template mode
  var advancedJsonBlock = document.getElementById('advanced-json-block');
  if (advancedJsonBlock) {
    advancedJsonBlock.addEventListener('toggle', function () {
      var open = advancedJsonBlock.open;
      state.mode = open ? 'flex_json' : 'template';
      // 黃色模板區跟 JSON 區互斥（一次只顯示一種）
      $('pane-template').hidden = open;
      $('pane-b-template').hidden = open;
      $('pane-b-flex-json').hidden = !open;
      state.messagePreviewed = false;
      updateSendButton();
      saveDraft();
      renderColorPalette();
      schedulePreview();
    });
  }

  // A/B test toggle
  $('ab-test-enable').addEventListener('change', function () {
    state.abTestEnabled = $('ab-test-enable').checked;
    $('variant-b-pane').hidden = !state.abTestEnabled;
    $('variant-a-label').hidden = !state.abTestEnabled;
    state.messagePreviewed = false;
    updateSendButton();
    saveDraft();
    schedulePreview();
  });

  // ------------------------------------------------------------------
  // 1a. channel tabs (LINE / Email) — task #7
  // ------------------------------------------------------------------
  function getActiveChannel() {
    var active = document.querySelector('.tab-btn[data-channel].active');
    return (active && active.getAttribute('data-channel') === 'email') ? 'email' : 'line';
  }
  function applyChannelUI(channel) {
    // 切 email 時隱藏 conditions / upload tabs，強制走 saved_list
    var emailMode = channel === 'email';
    document.querySelectorAll('.email-only-fields').forEach(function (el) { el.hidden = !emailMode; });
    document.querySelectorAll('.channel-line-only').forEach(function (el) { el.hidden = emailMode; });
    document.querySelectorAll('.tab-btn[data-audience]').forEach(function (b) {
      var aud = b.getAttribute('data-audience');
      if (aud === 'conditions' || aud === 'upload') {
        b.style.display = emailMode ? 'none' : '';
      }
    });
    // 切換 hint 文字
    var hintLine = document.querySelector('.channel-hint-line');
    var hintEmail = document.querySelector('.channel-hint-email');
    if (hintLine) hintLine.hidden = emailMode;
    if (hintEmail) hintEmail.hidden = !emailMode;
    // 進 email mode：自動切到 saved_list tab
    if (emailMode && state.audienceSource !== 'saved_list') {
      var savedTab = document.querySelector('.tab-btn[data-audience="saved_list"]');
      if (savedTab) savedTab.click();
    }
    // 測試人員區：email 時改顯示 email 輸入框
    var testEmailWrap = document.getElementById('test-email-wrap');
    if (testEmailWrap) testEmailWrap.hidden = !emailMode;
    var testLineWrap = document.getElementById('test-line-wrap');
    if (testLineWrap) testLineWrap.hidden = emailMode;
  }
  $$('.tab-btn[data-channel]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var ch = btn.getAttribute('data-channel');
      $$('.tab-btn[data-channel]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      applyChannelUI(ch);
      state.messagePreviewed = false;
      updateSendButton();
      schedulePreview();
    });
  });

  // ------------------------------------------------------------------
  // 1b. audience tabs（條件 / 已儲存名單 / 上傳）
  // ------------------------------------------------------------------
  $$('.tab-btn[data-audience]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.getAttribute('data-audience');
      state.audienceSource = src;
      $$('.tab-btn[data-audience]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      $('audience-pane-conditions').hidden = (src !== 'conditions');
      $('audience-pane-saved_list').hidden = (src !== 'saved_list');
      $('audience-pane-upload').hidden = (src !== 'upload');
      state.audiencePreviewedTotal = null;
      $('audience-status').textContent = '尚未預覽';
      $('audience-sample').hidden = true;
      updateSendButton();
      if (src === 'saved_list') loadSavedLists();
    });
  });

  // ------------------------------------------------------------------
  // 2. condition collection
  // ------------------------------------------------------------------
  function collectConditions() {
    if (state.audienceSource === 'saved_list') {
      var sel = $('saved-list-select').value;
      var listId = parseInt(sel, 10);
      return Number.isInteger(listId) && listId > 0 ? { savedListId: listId } : {};
    }
    // 加入時間（不限/1/7/30/90）
    var joinedWithinDays = null;
    var jw = $('joined-within') ? $('joined-within').value : '';
    if (jw) { var jwn = parseInt(jw, 10); if (Number.isInteger(jwn) && jwn > 0) joinedWithinDays = jwn; }

    // 全部會員：忽略行為條件，但保留加入時間
    if ($('all-members') && $('all-members').checked) {
      return { allMembers: true, joinedWithinDays: joinedWithinDays };
    }

    // conditions（預設）
    // 生命週期階段（多選）：全選 4 個或全不選都視為不限（後端會把全選正規化掉）
    var lifecycleStages = $$('input[name="lifecycle_stage"]:checked').map(function (el) { return el.value; });

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
    return { joinedWithinDays: joinedWithinDays, lifecycleStages: lifecycleStages, prizeFilter: prizeFilter, inviteCompletedMin: inviteCompletedMin, drewInCampaign: drewInCampaign };
  }

  // 全部會員 toggle：勾選時把行為條件變灰、重置預覽
  (function wireAllMembers() {
    var amEl = $('all-members');
    var jwEl = $('joined-within');
    function refresh() {
      var on = amEl && amEl.checked;
      var bc = $('behavior-conditions');
      if (bc) { bc.style.opacity = on ? '0.4' : '1'; bc.style.pointerEvents = on ? 'none' : 'auto'; }
      state.audiencePreviewedTotal = null;
      var st = $('audience-status'); if (st) st.textContent = '尚未預覽';
      updateSendButton();
    }
    if (amEl) amEl.addEventListener('change', refresh);
    if (jwEl) jwEl.addEventListener('change', function () {
      state.audiencePreviewedTotal = null;
      var st = $('audience-status'); if (st) st.textContent = '尚未預覽';
      updateSendButton();
    });
  })();

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
      body: JSON.stringify({ conditions: collectConditions(), channel: getActiveChannel() })
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
  // 4. hero upload (A 跟 B 兩組共用 handler)
  // ------------------------------------------------------------------
  function makeHeroUploadHandler(opts) {
    return function () {
      var fileInput = $(opts.fileInputId);
      var statusEl = $(opts.statusElId);
      if (!fileInput.files || fileInput.files.length === 0) {
        statusEl.textContent = '請先選擇圖片';
        return;
      }
      var file = fileInput.files[0];
      if (file.size > 2 * 1024 * 1024) { statusEl.textContent = '檔案 > 2MB'; return; }
      statusEl.textContent = '上傳中…';
      var fd = new FormData();
      fd.append('hero', file);
      fetch('/admin/broadcast/hero/upload', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) { statusEl.textContent = '失敗：' + (data.error || ''); return; }
          if (opts.variant === 'b') {
            state.bHeroMediaId = data.mediaId;
            state.bHeroUrl = data.url;
            renderBHeroStatus(false);
          } else {
            state.heroMediaId = data.mediaId;
            state.heroUrl = data.url;
            renderHeroStatus(false);
          }
          state.messagePreviewed = false;
          updateSendButton();
          saveDraft();
          schedulePreview();
        })
        .catch(function (e) { statusEl.textContent = '錯誤：' + e.message; });
    };
  }

  $('btn-hero-upload').addEventListener('click', makeHeroUploadHandler({
    fileInputId: 'hero-file', statusElId: 'hero-status', variant: 'a'
  }));
  $('btn-b-hero-upload').addEventListener('click', makeHeroUploadHandler({
    fileInputId: 'b-hero-file', statusElId: 'b-hero-status', variant: 'b'
  }));

  function renderBHeroStatus(isFromDraft) {
    var hs = $('b-hero-status');
    if (!hs) return;
    if (state.bHeroMediaId && state.bHeroUrl) {
      hs.innerHTML =
        (isFromDraft ? '已上傳（草稿）' : '已上傳') +
        ' <a href="' + state.bHeroUrl + '" target="_blank" rel="noopener">查看</a>' +
        ' <button type="button" class="link-btn btn-b-hero-remove" style="color:#dc2626;margin-left:8px;">移除</button>';
      var rmBtn = hs.querySelector('.btn-b-hero-remove');
      if (rmBtn) rmBtn.addEventListener('click', clearBHero);
    } else if (state.bHeroMediaId) {
      hs.innerHTML = '已存草稿 (mediaId: ' + state.bHeroMediaId.slice(0, 8) + '…) <button type="button" class="link-btn btn-b-hero-remove" style="color:#dc2626;margin-left:8px;">移除</button>';
      var rmBtn2 = hs.querySelector('.btn-b-hero-remove');
      if (rmBtn2) rmBtn2.addEventListener('click', clearBHero);
    } else {
      hs.textContent = '未上傳';
    }
  }
  function clearBHero() {
    state.bHeroMediaId = null;
    state.bHeroUrl = null;
    state.messagePreviewed = false;
    var fi = $('b-hero-file');
    if (fi) fi.value = '';
    renderBHeroStatus(false);
    updateSendButton();
    saveDraft();
    schedulePreview();
  }

  // ------------------------------------------------------------------
  // 5. collect message config
  // ------------------------------------------------------------------
  function getTopAltText() {
    var el = document.getElementById('msg-alt-text');
    return (el && el.value ? el.value.trim() : '');
  }
  function collectMessageConfig() {
    var topAlt = getTopAltText();
    if (state.mode === 'flex_json') {
      var raw = $('flex-json').value;
      try {
        var parsed = JSON.parse(raw);
        // 用上方 altText 欄位覆寫 JSON 內的（若使用者有填）
        if (topAlt && parsed && typeof parsed === 'object') {
          parsed.altText = topAlt;
        }
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
        altText: topAlt || $('tpl-alt').value.trim()
      }
    };
  }

  function collectVariantBMessageConfig() {
    if (state.mode === 'flex_json') {
      var raw = $('b-flex-json').value;
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
        heroMediaId: state.bHeroMediaId || null,
        title: $('b-tpl-title').value.trim(),
        subtitle: $('b-tpl-subtitle').value.trim(),
        couponCode: $('b-tpl-coupon-code').value.trim(),
        disclaimer: $('b-tpl-disclaimer').value.trim(),
        ctaLabel: $('b-tpl-cta-label').value.trim(),
        ctaUrl: $('b-tpl-cta-url').value.trim(),
        altText: $('b-tpl-alt').value.trim()
      }
    };
  }

  // ------------------------------------------------------------------
  // 6. message preview
  // ------------------------------------------------------------------
  // 自動預覽（debounce 500ms）— user 編欄位、切 mode、上傳、套用 URL 都觸發
  var previewTimer = null;
  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 500);
  }

  function runPreview() {
    var statusEl = $('msg-status');
    var previewEl = $('msg-preview');
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    var cfgB = state.abTestEnabled ? collectVariantBMessageConfig() : null;
    if (state.abTestEnabled && cfgB.mode === 'flex_json' && cfgB.flex === null) {
      statusEl.textContent = '版本 B JSON 格式錯誤：' + cfgB._parseError;
      return;
    }

    var channel = getActiveChannel();
    var emailSubject = '';
    if (channel === 'email') {
      emailSubject = ($('email-subject') && $('email-subject').value || '').trim();
    }
    var fetches = [
      fetch('/admin/broadcast/preview-message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_config: cfg, channel: channel, email_subject: emailSubject })
      }).then(function (r) { return r.json(); })
    ];
    if (state.abTestEnabled) {
      fetches.push(
        fetch('/admin/broadcast/preview-message', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_config: cfgB, channel: channel, email_subject: emailSubject })
        }).then(function (r) { return r.json(); })
      );
    }
    Promise.all(fetches)
      .then(function (results) {
        var dataA = results[0];
        var dataB = results[1];
        if (!dataA.ok || (state.abTestEnabled && !dataB.ok)) {
          var err = !dataA.ok ? dataA.error : dataB.error;
          // 訊息還沒填夠 → 不顯示為 error，只 keep 預覽空白
          if (/請至少填|altText/.test(err || '')) {
            statusEl.textContent = '預覽會在你填內容時自動更新';
            previewEl.classList.add('empty');
            previewEl.innerHTML = '請從上方「訊息模板」選一個 / 或開始編輯訊息';
          } else {
            statusEl.textContent = '錯誤：' + (err || '');
            previewEl.classList.add('empty');
            previewEl.innerHTML = '預覽失敗：' + escapeHtml(err || '');
          }
          state.messagePreviewed = false;
          updateSendButton();
          return;
        }
        if (dataA.channel === 'email') {
          // Email preview：用 iframe 顯示 HTML
          previewEl.classList.remove('empty');
          if (state.abTestEnabled) {
            previewEl.innerHTML =
              '<div style="margin-bottom:6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 A · 主旨：' + escapeHtml(dataA.subject || '') + '</div>' +
              '<iframe id="email-preview-a" style="width:100%;height:520px;border:1px solid #e5e7eb;border-radius:10px;background:#F9FAFB;"></iframe>' +
              '<div style="margin:14px 0 6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 B · 主旨：' + escapeHtml((dataB && dataB.subject) || '') + '</div>' +
              '<iframe id="email-preview-b" style="width:100%;height:520px;border:1px solid #e5e7eb;border-radius:10px;background:#F9FAFB;"></iframe>';
            try { $('email-preview-a').contentDocument.write(dataA.html || ''); $('email-preview-a').contentDocument.close(); } catch (_) {}
            if (dataB) { try { $('email-preview-b').contentDocument.write(dataB.html || ''); $('email-preview-b').contentDocument.close(); } catch (_) {} }
          } else {
            previewEl.innerHTML =
              '<div style="margin-bottom:6px;font-size:12px;color:#6B7280;">主旨：<strong style="color:#1F2937;">' + escapeHtml(dataA.subject || '') + '</strong></div>' +
              '<iframe id="email-preview" style="width:100%;height:600px;border:1px solid #e5e7eb;border-radius:10px;background:#F9FAFB;"></iframe>';
            try { $('email-preview').contentDocument.write(dataA.html || ''); $('email-preview').contentDocument.close(); } catch (_) {}
          }
        } else if (state.abTestEnabled) {
          previewEl.classList.remove('empty');
          previewEl.innerHTML =
            '<div style="margin-bottom:6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 A</div>' +
            '<div class="ab-preview-card" id="ab-preview-a"></div>' +
            '<div style="margin:14px 0 6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 B</div>' +
            '<div class="ab-preview-card" id="ab-preview-b"></div>';
          renderFlexMock(dataA.messages[0], $('ab-preview-a'), true);
          renderFlexMock(dataB.messages[0], $('ab-preview-b'), false);
        } else {
          renderFlexMock(dataA.messages[0], previewEl);
        }
        state.messagePreviewed = true;
        statusEl.textContent = '預覽已更新（' + new Date().toLocaleTimeString('zh-TW') + '）';
        updateSendButton();
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤：' + e.message; });
  }

  // 所有訊息相關欄位變動 → schedulePreview
  [
    'tpl-title', 'tpl-subtitle', 'tpl-coupon-code', 'tpl-disclaimer',
    'tpl-cta-label', 'tpl-cta-url', 'tpl-alt', 'flex-json',
    'b-tpl-title', 'b-tpl-subtitle', 'b-tpl-coupon-code', 'b-tpl-disclaimer',
    'b-tpl-cta-label', 'b-tpl-cta-url', 'b-tpl-alt', 'b-flex-json',
    'email-subject', 'email-from-name', 'email-from-address',
    'msg-alt-text'
  ].forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', schedulePreview);
  });

  // 配色盤的色塊在 renderColorPalette() 內各自綁定 input 事件。
  // 另：手動編輯 #flex-json 時 debounce 重建配色盤（避免色塊殘留舊色 / 漏新色）。
  (function () {
    var fj = $('flex-json');
    if (!fj) return;
    var paletteTimer = null;
    fj.addEventListener('input', function () {
      clearTimeout(paletteTimer);
      paletteTimer = setTimeout(renderColorPalette, 600);
    });
  })();

  // ------------------------------------------------------------------
  // 7. render Flex mock (支援 bubble 跟 carousel，含 header/hero/body/footer)
  // ------------------------------------------------------------------
  // 渲染預覽時是否啟用 WYSIWYG 編輯。A/B 的版本 B 卡設 false，
  // 否則點 B 卡編輯會把改動寫進版本 A 的 #flex-json（靜默損壞 A）。
  var renderingEditable = true;
  function renderFlexMock(flexMsg, container, editable) {
    renderingEditable = (editable !== false);
    container.classList.remove('empty');
    container.innerHTML = '';
    if (!flexMsg || flexMsg.type !== 'flex' || !flexMsg.contents) {
      container.classList.add('empty');
      container.textContent = '無法預覽（非 Flex 訊息）';
      return;
    }
    var contents = flexMsg.contents;
    if (contents.type === 'carousel' && Array.isArray(contents.contents)) {
      var hint = document.createElement('div');
      hint.className = 'lm-carousel-hint';
      hint.textContent = 'Carousel · 共 ' + contents.contents.length +
        ' 張卡片（手機上是橫向滑動，這裡改為上下展示方便檢視）';
      container.appendChild(hint);
      var carouselDiv = document.createElement('div');
      carouselDiv.className = 'lm-carousel';
      contents.contents.forEach(function (bubble, idx) {
        var bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'lm-bubble-in-carousel';
        var label = document.createElement('div');
        label.className = 'lm-bubble-num';
        label.textContent = String(idx + 1);
        bubbleDiv.appendChild(label);
        // path relative to flexMsg.contents: ['contents', idx]
        renderBubble(bubble, bubbleDiv, ['contents', idx]);
        carouselDiv.appendChild(bubbleDiv);
      });
      container.appendChild(carouselDiv);
      return;
    }
    // single bubble：path 起點是 bubble 本身（相對於 flexMsg.contents）
    renderBubble(contents, container, []);
  }

  function renderBubble(bubble, container, path) {
    if (!bubble || typeof bubble !== 'object') return;
    path = path || [];
    // header
    if (bubble.header && Array.isArray(bubble.header.contents)) {
      var headerDiv = document.createElement('div');
      headerDiv.className = 'lm-header';
      applyBoxStyle(bubble.header, headerDiv);
      bubble.header.contents.forEach(function (c, idx) {
        renderFlexComponent(c, headerDiv, path.concat(['header', 'contents', idx]));
      });
      container.appendChild(headerDiv);
    }
    // hero — 跳過 url 含 REPLACE_* 的 placeholder（避免預覽留白佔位）
    if (bubble.hero && bubble.hero.url && !/REPLACE_[A-Z0-9_]+/i.test(bubble.hero.url)) {
      var heroDiv = document.createElement('div');
      heroDiv.className = 'lm-hero';
      var img = document.createElement('img');
      img.src = bubble.hero.url;
      img.alt = '';
      heroDiv.appendChild(img);
      container.appendChild(heroDiv);
    }
    // body
    if (bubble.body && Array.isArray(bubble.body.contents)) {
      var bodyDiv = document.createElement('div');
      bodyDiv.className = 'lm-body';
      applyBoxStyle(bubble.body, bodyDiv);
      bubble.body.contents.forEach(function (c, idx) {
        renderFlexComponent(c, bodyDiv, path.concat(['body', 'contents', idx]));
      });
      container.appendChild(bodyDiv);
    }
    // footer
    if (bubble.footer && Array.isArray(bubble.footer.contents)) {
      var footerDiv = document.createElement('div');
      footerDiv.className = 'lm-footer';
      applyBoxStyle(bubble.footer, footerDiv);
      bubble.footer.contents.forEach(function (c, idx) {
        renderFlexComponent(c, footerDiv, path.concat(['footer', 'contents', idx]));
      });
      container.appendChild(footerDiv);
    }
  }

  function applyBoxStyle(box, el) {
    if (!box) return;
    if (box.backgroundColor) el.style.background = box.backgroundColor;
    if (box.borderWidth && box.borderColor) {
      el.style.border = box.borderWidth + ' solid ' + box.borderColor;
    }
    if (box.cornerRadius) {
      el.style.borderRadius =
        typeof box.cornerRadius === 'string' && /px$/.test(box.cornerRadius)
          ? box.cornerRadius
          : '8px';
    }
    if (box.paddingAll != null) el.style.padding = mapFlexSpacing(box.paddingAll);
    if (box.paddingTop != null) el.style.paddingTop = mapFlexSpacing(box.paddingTop);
    if (box.paddingBottom != null) el.style.paddingBottom = mapFlexSpacing(box.paddingBottom);
    if (box.paddingStart != null) el.style.paddingLeft = mapFlexSpacing(box.paddingStart);
    if (box.paddingEnd != null) el.style.paddingRight = mapFlexSpacing(box.paddingEnd);
    if (box.layout === 'horizontal' || box.layout === 'baseline') {
      el.style.display = 'flex';
      el.style.flexDirection = 'row';
      if (box.layout === 'baseline') el.style.alignItems = 'baseline';
      if (box.spacing) el.style.gap = mapFlexSpacing(box.spacing);
    }
  }

  function renderFlexComponent(c, parent, path) {
    if (!c || typeof c !== 'object') return;
    path = path || [];
    if (c.type === 'text') {
      var t = document.createElement('div');
      var isTitle = (c.weight === 'bold' && (c.size === 'xl' || c.size === 'xxl'));
      t.className = isTitle ? 'lm-title' : 'lm-subtitle';
      if (c.color) t.style.color = c.color;
      if (c.size) t.style.fontSize = mapFlexSize(c.size);
      if (c.weight === 'bold') t.style.fontWeight = '700';
      if (c.align === 'center') t.style.textAlign = 'center';
      else if (c.align === 'end') t.style.textAlign = 'right';
      else if (c.align === 'start') t.style.textAlign = 'left';
      if (c.margin) t.style.marginTop = mapFlexSpacing(c.margin);
      if (c.lineSpacing) t.style.lineHeight = '1.55';
      if (c.wrap) t.style.whiteSpace = 'pre-wrap';
      if (c.flex !== undefined) t.style.flex = String(c.flex);
      t.textContent = String(c.text || '');
      // WYSIWYG：text 可直接編輯 + focus 顯示 floating toolbar（非編輯預覽則純顯示）
      if (renderingEditable) {
        t.contentEditable = 'true';
        t.dataset.editPath = JSON.stringify(path.concat(['text']));
        t.classList.add('lm-editable');
        t.addEventListener('input', onPreviewTextEdit);
        t.addEventListener('keydown', preventEditorEnter);
        t.addEventListener('focus', function () { showTextFormatToolbar(t); });
      }
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
    if (c.type === 'image' && c.url) {
      // 跳過 REPLACE_ placeholder URL（避免預覽留破圖）
      if (/REPLACE_[A-Z0-9_]+/i.test(c.url)) return;
      var imgWrap = document.createElement('div');
      imgWrap.className = 'lm-inline-image';
      if (c.margin) imgWrap.style.marginTop = mapFlexSpacing(c.margin);
      // aspectRatio 預設 20:13；aspectMode cover 不撐爆 layout
      var ar = (typeof c.aspectRatio === 'string' && /^\d+:\d+$/.test(c.aspectRatio))
        ? c.aspectRatio.replace(':', '/')
        : '20/13';
      imgWrap.style.aspectRatio = ar;
      var img = document.createElement('img');
      img.src = c.url;
      img.alt = '';
      if (c.aspectMode === 'fit') img.style.objectFit = 'contain';
      else img.style.objectFit = 'cover';
      imgWrap.appendChild(img);
      attachDeleteButton(imgWrap, path, '圖片');
      parent.appendChild(imgWrap);
      return;
    }
    if (c.type === 'box' && c.action && c.action.type === 'uri') {
      // CTA 模擬：黃底深字 — 改用 div 而非 a，避免 click 跳轉 + 支援 contenteditable
      var btn = document.createElement('div');
      btn.className = 'lm-cta' + (renderingEditable ? ' lm-editable' : '');
      btn.setAttribute('role', 'button');
      if (c.backgroundColor) btn.style.background = c.backgroundColor;
      if (c.margin) btn.style.marginTop = mapFlexSpacing(c.margin);
      // 找第一個 text child 的 index 跟 label
      var label = '';
      var labelIdx = -1;
      if (Array.isArray(c.contents)) {
        for (var i = 0; i < c.contents.length; i++) {
          if (c.contents[i] && c.contents[i].type === 'text' && c.contents[i].text) {
            label = c.contents[i].text;
            labelIdx = i;
            if (c.contents[i].color) btn.style.color = c.contents[i].color;
            break;
          }
        }
      }
      btn.textContent = label || (c.action.label || 'OPEN');
      // WYSIWYG：CTA 文字可直接編輯（改第一個 text child）
      if (labelIdx >= 0 && renderingEditable) {
        btn.contentEditable = 'true';
        btn.dataset.editPath = JSON.stringify(path.concat(['contents', labelIdx, 'text']));
        btn.addEventListener('input', onPreviewTextEdit);
        btn.addEventListener('keydown', preventEditorEnter);
        // 點按鈕也要叫出格式工具列：色＝按鈕文字、框＝按鈕底色
        btn.addEventListener('focus', function () { showTextFormatToolbar(btn); });
      }
      attachDeleteButton(btn, path, '按鈕');
      parent.appendChild(btn);
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
      applyBoxStyle(c, sub);
      if (c.margin) sub.style.marginTop = mapFlexSpacing(c.margin);
      if (c.flex !== undefined) sub.style.flex = String(c.flex);
      c.contents.forEach(function (cc, idx) {
        renderFlexComponent(cc, sub, path.concat(['contents', idx]));
      });
      attachDeleteButton(sub, path, '區塊');
      parent.appendChild(sub);
    }
  }

  // 元件控制列（↑ ↓ ✕）：給 image / CTA / 內嵌 box 加 hover-able 控制鈕組
  function attachDeleteButton(el, componentPath, label) {
    if (!renderingEditable) return; // 非編輯預覽（如 A/B 的 B 卡）不掛刪除/移動控制
    attachComponentControls(el, componentPath, label);
  }

  function attachComponentControls(el, componentPath, label) {
    if (!Array.isArray(componentPath) || componentPath.length < 1) return;
    if (window.getComputedStyle(el).position === 'static') {
      el.style.position = 'relative';
    }
    var wrap = document.createElement('div');
    wrap.className = 'lm-comp-ctrls';

    var stopMD = function (e) { e.preventDefault(); e.stopPropagation(); };

    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'lm-ctrl-btn';
    up.textContent = '↑';
    up.title = '上移此' + (label || '元件');
    up.setAttribute('aria-label', '上移');
    up.addEventListener('mousedown', stopMD);
    up.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      moveComponentAtPath(componentPath, 'up');
    });

    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'lm-ctrl-btn';
    down.textContent = '↓';
    down.title = '下移此' + (label || '元件');
    down.setAttribute('aria-label', '下移');
    down.addEventListener('mousedown', stopMD);
    down.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      moveComponentAtPath(componentPath, 'down');
    });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'lm-ctrl-btn lm-ctrl-del';
    del.textContent = '×';
    del.title = '刪除此' + (label || '元件');
    del.setAttribute('aria-label', '刪除' + (label || '元件'));
    del.addEventListener('mousedown', stopMD);
    del.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!confirm('確定刪除這個' + (label || '元件') + '？')) return;
      deleteComponentAtPath(componentPath);
    });

    wrap.appendChild(up);
    wrap.appendChild(down);
    wrap.appendChild(del);
    el.appendChild(wrap);
  }

  function moveComponentAtPath(componentPath, direction) {
    try {
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      if (!Array.isArray(componentPath) || componentPath.length < 1) return;
      var parentPath = componentPath.slice(0, -1);
      var idx = componentPath[componentPath.length - 1];
      var ref = parsed.contents;
      for (var i = 0; i < parentPath.length; i++) ref = ref[parentPath[i]];
      if (!Array.isArray(ref)) {
        alert('找不到容器陣列。');
        return;
      }
      var swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= ref.length) {
        alert(direction === 'up' ? '已經在最上面了。' : '已經在最下面了。');
        return;
      }
      var tmp = ref[swapIdx];
      ref[swapIdx] = ref[idx];
      ref[idx] = tmp;
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      hideTextFormatToolbar();
      schedulePreview();
    } catch (e) {
      console.warn('moveComponentAtPath failed:', e && e.message);
      alert('移動失敗：' + (e && e.message));
    }
  }

  function deleteComponentAtPath(componentPath) {
    try {
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      if (!Array.isArray(componentPath) || componentPath.length < 1) return;
      var parentPath = componentPath.slice(0, -1);
      var idx = componentPath[componentPath.length - 1];
      var ref = parsed.contents;
      for (var i = 0; i < parentPath.length; i++) ref = ref[parentPath[i]];
      if (!Array.isArray(ref)) {
        alert('找不到容器陣列，無法刪除。');
        return;
      }
      if (ref.length <= 1) {
        alert('這個區塊只剩一個元件，請先新增其他元件才能刪除（LINE Flex 規範：box.contents 不可為空）。');
        return;
      }
      ref.splice(idx, 1);
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      hideTextFormatToolbar();
      schedulePreview();
      try { scanJsonImagesAndUrls(); } catch (e) {}
    } catch (e) {
      console.warn('deleteComponentAtPath failed:', e && e.message);
      alert('刪除失敗：' + (e && e.message));
    }
  }

  // ----- WYSIWYG：preview 內 text 編輯時自動 sync 回 JSON textarea -----
  var previewEditTimer = null;
  function onPreviewTextEdit(e) {
    var el = e.currentTarget;
    if (previewEditTimer) clearTimeout(previewEditTimer);
    previewEditTimer = setTimeout(function () {
      try {
        var path = JSON.parse(el.dataset.editPath || '[]');
        var newText = el.textContent;
        var textarea = $('flex-json');
        var parsed = JSON.parse(textarea.value);
        if (parsed && parsed.contents) {
          setJsonAtPath(parsed.contents, path, newText);
          textarea.value = JSON.stringify(parsed, null, 2);
          saveDraft();
          // 不 re-render preview（保留 cursor）
        }
      } catch (err) {
        console.warn('preview edit sync failed:', err && err.message);
      }
    }, 350);
  }

  function preventEditorEnter(e) {
    // 阻止 Enter 在 contenteditable 內插入 <div>/<br>，改為 blur 結束編輯
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  function setJsonAtPath(root, path, value) {
    if (!Array.isArray(path) || path.length === 0) return;
    var ref = root;
    for (var i = 0; i < path.length - 1; i++) {
      if (ref == null) return;
      ref = ref[path[i]];
    }
    if (ref != null) ref[path[path.length - 1]] = value;
  }

  // ------------------------------------------------------------------
  // Floating text format toolbar
  // ------------------------------------------------------------------
  var currentEditingText = null;
  // 使用者手動拖過 toolbar 後，切換不同 text 不再 reset 位置；按 ✕ 關閉才會重置
  var toolbarUserPositioned = false;

  function showTextFormatToolbar(textEl) {
    currentEditingText = textEl;
    var tb = $('text-format-toolbar');
    if (!tb) return;
    tb.hidden = false;
    if (!toolbarUserPositioned) {
      // 先量 toolbar 實際尺寸（hidden=false 才有 offsetWidth/Height）
      var rect = textEl.getBoundingClientRect();
      var tbWidth = tb.offsetWidth || 0;
      var tbHeight = tb.offsetHeight || 44;
      var gap = 10;
      // 上方候選 vs 下方候選；確保都在 viewport 內
      var topAbove = rect.top + window.scrollY - tbHeight - gap;
      var topBelow = rect.bottom + window.scrollY + gap;
      var minTop = window.scrollY + 12;
      var maxTop = window.scrollY + window.innerHeight - tbHeight - 12;
      // 預設放上方；上方空間不夠（會超出 viewport 上邊）→ 改放下方
      var top = (topAbove < minTop) ? topBelow : topAbove;
      top = Math.max(minTop, Math.min(maxTop, top));
      tb.style.top = top + 'px';
      // left：跟文字左對齊，clamp 在 viewport [12, vw - tbW - 12]
      var maxLeft = window.scrollX + window.innerWidth - tbWidth - 12;
      var minLeft = window.scrollX + 12;
      var desiredLeft = rect.left + window.scrollX;
      var clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
      tb.style.left = clampedLeft + 'px';
    }
    syncToolbarFromText(textEl);
  }

  function syncToolbarFromText(textEl) {
    var tb = $('text-format-toolbar');
    if (!tb) return;
    try {
      var path = JSON.parse(textEl.dataset.editPath || '[]');
      if (path.length === 0) return;
      var parsed = JSON.parse($('flex-json').value);
      var nodePath = path.slice(0, -1); // 移除 'text' segment 到 text node 本身
      var ref = parsed.contents;
      for (var i = 0; i < nodePath.length; i++) ref = ref[nodePath[i]];
      if (!ref) return;
      tb.querySelector('.tft-size').value = ref.size || 'md';
      tb.querySelector('.tft-color').value = normalizeHexColor(ref.color);
      tb.querySelector('.tft-bold').classList.toggle('active', ref.weight === 'bold');
      ['start', 'center', 'end'].forEach(function (a) {
        var btn = tb.querySelector('[data-action="align-' + a + '"]');
        if (btn) btn.classList.toggle('active', ref.align === a);
      });
      // 框背景色：父 box 在 path.slice(0, -3) (剝掉 'text', idx, 'contents')
      var bgInput = tb.querySelector('.tft-box-bg');
      if (bgInput) {
        var parentBox = getParentBoxFromPath(parsed, path);
        bgInput.value = normalizeHexColor(parentBox && parentBox.backgroundColor, '#ffffff');
      }
    } catch (e) {}
  }

  // 找 path 對應 text 所在的 box（path = [..., 'contents', idx, 'text']）
  function getParentBoxFromPath(parsed, path) {
    if (!Array.isArray(path) || path.length < 3) return null;
    var boxPath = path.slice(0, -3); // 剝掉 'text', idx, 'contents'
    var ref = parsed.contents;
    for (var i = 0; i < boxPath.length; i++) {
      if (ref == null) return null;
      ref = ref[boxPath[i]];
    }
    return ref || null;
  }

  function handleBoxBgChange(val) {
    if (!currentEditingText) return;
    try {
      var path = JSON.parse(currentEditingText.dataset.editPath || '[]');
      if (path.length < 3) return;
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      var parentBox = getParentBoxFromPath(parsed, path);
      if (!parentBox || typeof parentBox !== 'object') return;
      if (!val) delete parentBox.backgroundColor;
      else parentBox.backgroundColor = val;
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      // DOM 即時 reflect：CTA 按鈕自己就是該 box，其餘抓父容器
      var boxEl = currentEditingText.classList && currentEditingText.classList.contains('lm-cta')
        ? currentEditingText
        : currentEditingText.parentNode;
      if (boxEl) boxEl.style.background = val || '';
    } catch (e) {
      console.warn('handleBoxBgChange failed:', e && e.message);
    }
  }

  function normalizeHexColor(c, fallback) {
    var fb = fallback || '#1f2937';
    if (typeof c !== 'string') return fb;
    var m = c.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
    if (!m) return fb;
    if (m[1].length === 3) {
      return '#' + m[1].split('').map(function (x) { return x + x; }).join('');
    }
    return c.toLowerCase();
  }

  // ===== 配色盤：列出整張卡用到的所有顏色，任一可改、全域套用 =====
  // 只接受 3 或 6 碼 HEX，統一展開成 6 碼小寫（#fff 與 #ffffff 視為同色，4/5/8 碼一律排除）
  function expandHex(hex) {
    if (typeof hex !== 'string') return '';
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!m) return '';
    var h = m[1];
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    return '#' + h.toLowerCase();
  }
  // 收集所有顏色：key = 展開後 6 碼 hex，value = { bg, text, border }
  function collectAllColors(node, acc) {
    if (Array.isArray(node)) { node.forEach(function (x) { collectAllColors(x, acc); }); return; }
    if (!node || typeof node !== 'object') return;
    function note(val, kind) {
      var k = expandHex(val);
      if (!k) return;
      acc[k] = acc[k] || { bg: 0, text: 0, border: 0 };
      acc[k][kind]++;
    }
    note(node.backgroundColor, 'bg');
    note(node.borderColor, 'border');
    // separator 的 color 視為框線色，其餘 color 視為文字色
    if (node.type === 'separator') note(node.color, 'border');
    else note(node.color, 'text');
    Object.keys(node).forEach(function (key) {
      if (node[key] && typeof node[key] === 'object') collectAllColors(node[key], acc);
    });
  }
  // 全域換色：所有等於 fromHex 的 backgroundColor / color / borderColor 換成 toHex
  function deepReplaceAnyColor(node, fromHex, toHex) {
    if (Array.isArray(node)) { node.forEach(function (x) { deepReplaceAnyColor(x, fromHex, toHex); }); return; }
    if (!node || typeof node !== 'object') return;
    var from6 = expandHex(fromHex);
    ['backgroundColor', 'color', 'borderColor'].forEach(function (prop) {
      // 用展開後的 6 碼比對，#fff 也能對到 #ffffff
      if (typeof node[prop] === 'string' && from6 && expandHex(node[prop]) === from6) {
        node[prop] = toHex;
      }
    });
    Object.keys(node).forEach(function (key) {
      if (node[key] && typeof node[key] === 'object') deepReplaceAnyColor(node[key], fromHex, toHex);
    });
  }
  function colorRoleLabel(roles) {
    var parts = [];
    if (roles.bg) parts.push('底色');
    if (roles.text) parts.push('文字');
    if (roles.border) parts.push('框線');
    return parts.join('＋') || '顏色';
  }
  // 重建配色盤（模板載入 / 切到 flex_json 時呼叫）
  function renderColorPalette() {
    var box = $('color-palette-box');
    var pal = $('color-palette');
    if (!box || !pal) return;
    var ta = $('flex-json');
    var acc = {};
    if (state.mode === 'flex_json' && ta) {
      try { collectAllColors(JSON.parse(ta.value), acc); } catch (e) {}
    }
    var hexes = Object.keys(acc);
    if (hexes.length === 0) { box.hidden = true; pal.innerHTML = ''; return; }
    hexes.sort(function (a, b) {
      return (acc[b].bg + acc[b].text + acc[b].border) - (acc[a].bg + acc[a].text + acc[a].border);
    });
    pal.innerHTML = '';
    hexes.forEach(function (hex) {
      var roles = acc[hex];
      var total = roles.bg + roles.text + roles.border;
      var sw = document.createElement('div');
      sw.className = 'cp-swatch';
      var inp = document.createElement('input');
      inp.type = 'color';
      inp.value = normalizeHexColor(hex, '#000000');
      inp.dataset.color = inp.value;
      var meta = document.createElement('div');
      meta.className = 'cp-meta';
      var role = document.createElement('span');
      role.className = 'cp-role';
      role.textContent = colorRoleLabel(roles);
      var use = document.createElement('span');
      use.className = 'cp-use';
      use.textContent = '用在 ' + total + ' 處';
      meta.appendChild(role);
      meta.appendChild(use);
      inp.addEventListener('input', function (e) {
        var from = inp.dataset.color;
        var to = e.target.value;
        if (!from || from.toLowerCase() === to.toLowerCase()) return;
        var flex;
        try { flex = JSON.parse(ta.value); } catch (err) { return; }
        deepReplaceAnyColor(flex, from, to);
        ta.value = JSON.stringify(flex, null, 2);
        inp.dataset.color = to;
        saveDraft();
        schedulePreview();
      });
      sw.appendChild(inp);
      sw.appendChild(meta);
      pal.appendChild(sw);
    });
    box.hidden = false;
  }

  function hideTextFormatToolbar() {
    var tb = $('text-format-toolbar');
    if (tb) tb.hidden = true;
    currentEditingText = null;
    // 關閉時重置「手動定位」狀態，下次打開回到「跟著文字」模式
    toolbarUserPositioned = false;
  }

  // 點外面 hide（但 toolbar 內部、預覽內 editable 點擊都不 hide）
  document.addEventListener('mousedown', function (e) {
    var tb = $('text-format-toolbar');
    if (!tb || tb.hidden) return;
    if (tb.contains(e.target)) return;
    if (e.target.classList && e.target.classList.contains('lm-editable')) return;
    hideTextFormatToolbar();
  });

  // toolbar 內部 mousedown 不要 blur text（保留 cursor）
  (function bindToolbar() {
    var tb = document.getElementById('text-format-toolbar');
    if (!tb) return;
    tb.addEventListener('mousedown', function (e) {
      // 排除 select / input — 它們要正常 focus
      var tag = e.target.tagName;
      if (tag === 'SELECT' || tag === 'INPUT') return;
      e.preventDefault();
    });
    // 字級
    tb.querySelector('.tft-size').addEventListener('change', function (e) {
      handleStyleChange('size', e.target.value);
    });
    // 顏色（input 事件即時 reflect）
    tb.querySelector('.tft-color').addEventListener('input', function (e) {
      handleStyleChange('color', e.target.value);
    });
    // 粗體 toggle
    tb.querySelector('.tft-bold').addEventListener('click', function () {
      var btn = tb.querySelector('.tft-bold');
      var bold = btn.classList.contains('active');
      handleStyleChange('weight', bold ? null : 'bold');
      btn.classList.toggle('active', !bold);
    });
    // 對齊
    ['start', 'center', 'end'].forEach(function (a) {
      var btn = tb.querySelector('[data-action="align-' + a + '"]');
      if (!btn) return;
      btn.addEventListener('click', function () {
        // 互斥 active 三選一
        ['start', 'center', 'end'].forEach(function (b) {
          var x = tb.querySelector('[data-action="align-' + b + '"]');
          if (x) x.classList.toggle('active', b === a);
        });
        handleStyleChange('align', a);
      });
    });
    // 加上方 / 加下方 / 加區塊 / 加圖片 / 上移 / 下移 / 刪除一列 / 關閉
    var rowActions = {
      'add-above': 1, 'add-below': 1, 'add-box': 1, 'add-image': 1,
      'move-up': 1, 'move-down': 1, 'delete-row': 1, 'close': 1
    };
    tb.querySelectorAll('.tft-btn[data-action]').forEach(function (btn) {
      var act = btn.getAttribute('data-action');
      if (!rowActions[act]) return;
      btn.addEventListener('click', function () {
        if (act === 'close') { hideTextFormatToolbar(); return; }
        if (act === 'add-image') { triggerImageUpload(); return; }
        handleRowAction(act);
      });
    });
    // 框背景色（input 即時 reflect 到所在 box 的 backgroundColor）
    var bgInput = tb.querySelector('.tft-box-bg');
    if (bgInput) {
      bgInput.addEventListener('input', function (e) {
        handleBoxBgChange(e.target.value);
      });
    }
    // ＋圖 觸發隱藏 file input
    var imgFile = document.getElementById('tft-image-file');
    if (imgFile) {
      imgFile.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) uploadAndInsertImage(f);
        e.target.value = ''; // 清空讓同檔可再選
      });
    }
    // 拖曳把手 — 按住 grip 自由移動 toolbar
    var grip = tb.querySelector('.tft-grip');
    if (grip) {
      var dragging = false;
      var dragOffsetX = 0;
      var dragOffsetY = 0;
      grip.addEventListener('mousedown', function (e) {
        dragging = true;
        // 計算 cursor 對 toolbar 左上角的偏移（拖拉時保持相對位置）
        var rect = tb.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        tb.classList.add('dragging');
        document.body.style.userSelect = 'none';
        e.preventDefault();
        e.stopPropagation();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var newLeft = e.clientX + window.scrollX - dragOffsetX;
        var newTop = e.clientY + window.scrollY - dragOffsetY;
        // clamp 在 viewport 內，避免拖出畫面找不回來
        var tbWidth = tb.offsetWidth || 0;
        var tbHeight = tb.offsetHeight || 0;
        var minLeft = window.scrollX + 4;
        var maxLeft = window.scrollX + window.innerWidth - tbWidth - 4;
        var minTop = window.scrollY + 4;
        var maxTop = window.scrollY + window.innerHeight - tbHeight - 4;
        tb.style.left = Math.max(minLeft, Math.min(maxLeft, newLeft)) + 'px';
        tb.style.top = Math.max(minTop, Math.min(maxTop, newTop)) + 'px';
      });
      document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        tb.classList.remove('dragging');
        document.body.style.userSelect = '';
        toolbarUserPositioned = true; // 拖過後切 text 不再自動跑回去
      });
    }
  })();

  function triggerImageUpload() {
    if (!currentEditingText) return;
    var imgFile = document.getElementById('tft-image-file');
    if (imgFile) imgFile.click();
  }

  function uploadAndInsertImage(file) {
    if (!currentEditingText) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('圖片太大（>2MB），請壓縮後再上傳。');
      return;
    }
    var savedTextEl = currentEditingText; // 上傳期間 toolbar 可能消失，保險快取
    var fd = new FormData();
    fd.append('hero', file);
    fetch('/admin/broadcast/hero/upload', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.url) {
          alert('圖片上傳失敗：' + (data.error || ''));
          return;
        }
        insertImageRow(savedTextEl, data.url, data.mediaId);
      })
      .catch(function (e) { alert('上傳錯誤：' + (e && e.message)); });
  }

  function insertImageRow(textEl, imageUrl, mediaId) {
    try {
      var path = JSON.parse(textEl.dataset.editPath || '[]');
      if (path.length < 2) return;
      var idxPos = path.length - 2;
      var idx = path[idxPos];
      var parentPath = path.slice(0, idxPos);
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      var ref = parsed.contents;
      for (var i = 0; i < parentPath.length; i++) ref = ref[parentPath[i]];
      if (!Array.isArray(ref)) {
        alert('無法在這裡插入圖片（非陣列容器）。');
        return;
      }
      var newImage = {
        type: 'image',
        url: imageUrl,
        size: 'full',
        aspectMode: 'cover',
        aspectRatio: '20:13',
        margin: 'md'
      };
      ref.splice(idx + 1, 0, newImage);
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      hideTextFormatToolbar();
      // 重 render preview + 重 scan 圖片 helper（讓上傳的圖出現在助手列）
      schedulePreview();
      try { scanJsonImagesAndUrls(); } catch (e) {}
    } catch (e) {
      console.warn('insertImageRow failed:', e && e.message);
      alert('插入圖片失敗：' + (e && e.message));
    }
  }

  // style 操作：JSON sync + DOM 即時 update（不 re-render preview，保留 focus / cursor）
  function handleStyleChange(prop, val) {
    if (!currentEditingText) return;
    try {
      var path = JSON.parse(currentEditingText.dataset.editPath || '[]');
      if (path.length === 0) return;
      var nodePath = path.slice(0, -1);
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      var ref = parsed.contents;
      for (var i = 0; i < nodePath.length; i++) ref = ref[nodePath[i]];
      if (!ref) return;
      if (val == null) delete ref[prop];
      else ref[prop] = val;
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      // DOM 即時 reflect
      if (prop === 'size') currentEditingText.style.fontSize = mapFlexSize(val);
      else if (prop === 'color') currentEditingText.style.color = val || '';
      else if (prop === 'weight') currentEditingText.style.fontWeight = val === 'bold' ? '700' : '';
      else if (prop === 'align') {
        currentEditingText.style.textAlign =
          val === 'center' ? 'center' :
          val === 'end' ? 'right' :
          val === 'start' ? 'left' : '';
      }
    } catch (e) {
      console.warn('handleStyleChange failed:', e && e.message);
    }
  }

  // row 操作：改 JSON 後 re-render preview（新加 row 沒 DOM element 必須重 render）
  function handleRowAction(action) {
    if (!currentEditingText) return;
    try {
      var path = JSON.parse(currentEditingText.dataset.editPath || '[]');
      if (path.length < 2) return;
      // path = [..., contents_key, idx, 'text']
      var idxPos = path.length - 2;
      var idx = path[idxPos];
      var parentPath = path.slice(0, idxPos);
      var textarea = $('flex-json');
      var parsed = JSON.parse(textarea.value);
      var ref = parsed.contents;
      for (var i = 0; i < parentPath.length; i++) ref = ref[parentPath[i]];
      if (!Array.isArray(ref)) {
        alert('這個 text 不在 array 內，無法插入或刪除一列。');
        return;
      }
      if (action === 'move-up') {
        if (idx <= 0) { alert('已經在最上面了。'); return; }
        var tmp = ref[idx - 1];
        ref[idx - 1] = ref[idx];
        ref[idx] = tmp;
      } else if (action === 'move-down') {
        if (idx >= ref.length - 1) { alert('已經在最下面了。'); return; }
        var tmp2 = ref[idx + 1];
        ref[idx + 1] = ref[idx];
        ref[idx] = tmp2;
      } else if (action === 'add-above' || action === 'add-below') {
        var newText = { type: 'text', text: '點此編輯', size: 'md', color: '#1f2937', wrap: true };
        var insertIdx = action === 'add-above' ? idx : idx + 1;
        ref.splice(insertIdx, 0, newText);
      } else if (action === 'add-box') {
        var newBox = {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#FFF7D6',
          paddingAll: 'md',
          cornerRadius: '8px',
          margin: 'md',
          contents: [
            { type: 'text', text: '點此編輯區塊文字', size: 'md', color: '#1f2937', wrap: true }
          ]
        };
        ref.splice(idx + 1, 0, newBox);
      } else if (action === 'delete-row') {
        if (ref.length <= 1) {
          alert('這個 box 只有一列，不可刪除（會破壞 LINE Flex 規範）。');
          return;
        }
        ref.splice(idx, 1);
      }
      textarea.value = JSON.stringify(parsed, null, 2);
      saveDraft();
      hideTextFormatToolbar();
      schedulePreview();
    } catch (e) {
      console.warn('handleRowAction failed:', e && e.message);
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
    var channel = getActiveChannel();
    if (channel === 'line' && !INIT.hasLineToken) {
      alert('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法送出。');
      return;
    }
    var statusEl = $('test-push-status');
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    statusEl.textContent = '送出中…';
    var body = { message_config: cfg, channel: channel };
    if (channel === 'email') {
      var emailInput = $('test-email');
      var targetEmail = emailInput && emailInput.value ? emailInput.value.trim() : '';
      if (!targetEmail) { statusEl.textContent = '請填收件 email'; return; }
      body.test_email = targetEmail;
      body.email_subject = ($('email-subject') && $('email-subject').value || '').trim();
      body.email_from_name = ($('email-from-name') && $('email-from-name').value || '').trim();
      body.email_from_address = ($('email-from-address') && $('email-from-address').value || '').trim();
    } else {
      var recipient = $('test-recipient').value.trim();
      if (recipient) {
        if (/^U[0-9a-f]{32}$/i.test(recipient)) {
          body.test_line_user_id = recipient;
        } else {
          body.test_member_name = recipient;
        }
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
          statusEl.innerHTML = '已送出到 <code style="font-size:12px">' + escapeHtml(data.sentTo || '') + '</code>';
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
      push_failed: 'LINE push 失敗（請至 line_push_logs 查 detail）',
      label_required: '請填顯示名',
      duplicate_line_user_id: '這個 LINE userId 已在清單'
    };
    return map[code] || code || 'unknown';
  }

  // ------------------------------------------------------------------
  // 7c. 測試人員清單（伺服器端 admin_test_recipients 表）
  // ------------------------------------------------------------------
  function loadTestRecipients() {
    fetch('/admin/broadcast/test-recipients')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          $('test-recipient-list').innerHTML = '<div class="muted" style="font-size:12px;">載入失敗</div>';
          return;
        }
        renderTestRecipients(data.recipients || []);
      })
      .catch(function () {
        $('test-recipient-list').innerHTML = '<div class="muted" style="font-size:12px;">載入失敗</div>';
      });
  }

  function renderTestRecipients(list) {
    var wrap = $('test-recipient-list');
    if (!list || list.length === 0) {
      wrap.innerHTML = '<div class="muted" style="font-size:12px;">尚無測試人員。在下方「＋ 新增」表單加入。</div>';
      return;
    }
    wrap.innerHTML = list.map(function (r) {
      return '<div class="test-recipient-row" data-id="' + r.id +
        '" data-uid="' + escapeHtml(r.line_user_id) + '">' +
        '<span class="tr-label">' + escapeHtml(r.label) + '</span>' +
        '<code class="tr-uid">' + escapeHtml(r.line_user_id) + '</code>' +
        '<button type="button" class="btn-test-one">發給此人</button>' +
        '<button type="button" class="btn-remove">移除</button>' +
        '</div>';
    }).join('');
    $$('.btn-test-one', wrap).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.test-recipient-row');
        sendTestTo(row.getAttribute('data-uid'), row.querySelector('.tr-label').textContent);
      });
    });
    $$('.btn-remove', wrap).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.test-recipient-row');
        removeRecipient(row.getAttribute('data-id'));
      });
    });
  }

  function sendTestTo(lineUid, label) {
    var statusEl = $('test-push-status');
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    statusEl.textContent = '送給 ' + label + '…';
    fetch('/admin/broadcast/test-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test_line_user_id: lineUid, message_config: cfg })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          statusEl.innerHTML = '已送給 <strong>' + escapeHtml(label) + '</strong>';
        } else {
          var msg = errorMap(data.error);
          if (data.detail) msg += '｜' + data.detail;
          statusEl.textContent = '失敗（' + label + '）：' + msg;
        }
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤（' + label + '）：' + e.message; });
  }

  function removeRecipient(id) {
    if (!confirm('確定從測試人員清單移除這位？')) return;
    fetch('/admin/broadcast/test-recipients/' + id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) loadTestRecipients();
        else alert('移除失敗：' + (data.error || ''));
      });
  }

  $('btn-test-push-all').addEventListener('click', function () {
    var statusEl = $('test-push-status');
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
      return;
    }
    if (!INIT.hasLineToken) { alert('尚未設定 LINE token'); return; }

    fetch('/admin/broadcast/test-recipients')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.recipients || data.recipients.length === 0) {
          statusEl.textContent = '清單為空，請先新增測試人員';
          return;
        }
        var list = data.recipients;
        if (!confirm('將發測試訊息給 ' + list.length + ' 位測試人員，確認？')) return;
        var idx = 0;
        var ok = 0;
        var fail = 0;
        function next() {
          if (idx >= list.length) {
            statusEl.innerHTML = '完成：成功 <strong>' + ok + '</strong> ／ 失敗 <strong>' + fail + '</strong>';
            return;
          }
          var r = list[idx++];
          statusEl.textContent = '送給 ' + r.label + '（' + idx + '/' + list.length + '）…';
          fetch('/admin/broadcast/test-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ test_line_user_id: r.line_user_id, message_config: cfg })
          })
            .then(function (r2) { return r2.json(); })
            .then(function (d) { if (d.ok) ok++; else fail++; })
            .catch(function () { fail++; })
            .then(function () { setTimeout(next, 200); });
        }
        next();
      });
  });

  $('btn-add-recipient').addEventListener('click', function () {
    var label = $('new-tr-label').value.trim();
    var uid = $('new-tr-uid').value.trim();
    var statusEl = $('add-recipient-status');
    if (!label) { statusEl.textContent = '請填顯示名'; return; }
    if (!/^U[0-9a-f]{32}$/i.test(uid)) { statusEl.textContent = 'LINE userId 格式錯（U + 32 hex）'; return; }
    statusEl.textContent = '新增中…';
    fetch('/admin/broadcast/test-recipients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label, lineUserId: uid })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          statusEl.textContent = '已加入：' + label;
          $('new-tr-label').value = '';
          $('new-tr-uid').value = '';
          loadTestRecipients();
        } else {
          statusEl.textContent = '失敗：' + errorMap(data.error) + (data.detail ? '｜' + data.detail : '');
        }
      });
  });

  // 啟動：載入清單
  loadTestRecipients();

  // ------------------------------------------------------------------
  // 9b. 訊息模板庫
  // ------------------------------------------------------------------
  // 內建「空白訊息」卡（不入 DB），讓同事從零開始
  var BLANK_TEMPLATE_CONFIG = {
    mode: 'flex_json',
    flex: {
      type: 'flex',
      altText: '新訊息',
      contents: {
        type: 'bubble',
        size: 'mega',
        body: {
          type: 'box',
          layout: 'vertical',
          paddingAll: 'xl',
          spacing: 'md',
          contents: [
            { type: 'text', text: '點此編輯標題', size: 'xl', weight: 'bold', color: '#1f2937', wrap: true },
            { type: 'text', text: '點此編輯內文，按下「＋區塊」可加上有底色的區塊。', size: 'md', color: '#374151', wrap: true }
          ]
        }
      }
    }
  };

  function renderBlankCard(grid) {
    var card = document.createElement('div');
    card.className = 'template-card template-card-blank';
    card.setAttribute('data-blank', '1');
    card.innerHTML =
      '<div class="template-card-name">＋ 空白訊息</div>' +
      '<div class="template-card-desc">從零開始：自由新增文字、區塊與背景色</div>';
    card.addEventListener('click', function () {
      var sel = $('template-select');
      if (sel) sel.value = '';
      var delBtn = $('btn-delete-template');
      if (delBtn) delBtn.hidden = true;
      applyMessageConfigToForm(BLANK_TEMPLATE_CONFIG);
      state.messagePreviewed = false;
      updateSendButton();
      saveDraft();
      $$('.template-card', grid).forEach(function (c) { c.classList.remove('active'); });
      card.classList.add('active');
    });
    return card;
  }

  // ?tpl=<id> 自動套用模板（只在第一次載入模板列表時生效）
  var tplParamPending = new URLSearchParams(location.search).get('tpl');

  function loadMessageTemplates() {
    var sel = $('template-select');
    var grid = $('template-grid');
    fetch('/admin/broadcast/templates')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          grid.innerHTML = '';
          grid.appendChild(renderBlankCard(grid));
          var err = document.createElement('div');
          err.className = 'muted';
          err.style.fontSize = '12px';
          err.textContent = '其他模板載入失敗';
          grid.appendChild(err);
          return;
        }
        var list = data.templates || [];
        // 隱藏 dropdown 同步給 internal logic 用
        sel.innerHTML = '<option value="">—</option>' +
          list.map(function (t) {
            return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>';
          }).join('');
        // 顯示 card grid（空白卡永遠第一個）
        grid.innerHTML = '';
        grid.appendChild(renderBlankCard(grid));
        list.forEach(function (t) {
          var card = document.createElement('div');
          card.className = 'template-card';
          card.setAttribute('data-id', t.id);
          card.innerHTML =
            '<div class="template-card-name">' + escapeHtml(t.name) + '</div>' +
            '<div class="template-card-desc">' + escapeHtml(t.description || '') + '</div>';
          card.addEventListener('click', function () {
            sel.value = t.id;
            sel.dispatchEvent(new Event('change'));
            $$('.template-card', grid).forEach(function (c) { c.classList.remove('active'); });
            card.classList.add('active');
          });
          grid.appendChild(card);
        });
        // ?tpl=<id>：自動套用指定模板
        if (tplParamPending) {
          var tplId = tplParamPending;
          tplParamPending = null;
          var matched = null;
          list.forEach(function (t) {
            if (String(t.id) === String(tplId)) matched = t;
          });
          if (matched) {
            sel.value = String(matched.id);
            sel.dispatchEvent(new Event('change'));
            $$('.template-card', grid).forEach(function (c) {
              c.classList.toggle('active', c.getAttribute('data-id') === String(matched.id));
            });
            var tplStatusEl = $('msg-status');
            if (tplStatusEl) tplStatusEl.textContent = '已帶入訊息庫的『' + matched.name + '』';
          }
        }
      })
      .catch(function () {
        grid.innerHTML = '';
        grid.appendChild(renderBlankCard(grid));
      });
  }

  function applyMessageConfigToForm(messageConfig) {
    if (!messageConfig || typeof messageConfig !== 'object') return;
    var topAltEl = document.getElementById('msg-alt-text');
    if (messageConfig.mode === 'flex_json') {
      // 自動展開「進階模式」details + 切到 flex_json mode
      var advBlock = document.getElementById('advanced-json-block');
      if (advBlock && !advBlock.open) advBlock.open = true;
      state.mode = 'flex_json';
      $('pane-template').hidden = true;
      if (messageConfig.flex) {
        $('flex-json').value = JSON.stringify(messageConfig.flex, null, 2);
        // 同步 altText 到上方欄位
        if (topAltEl) topAltEl.value = messageConfig.flex.altText || '';
      }
      // 清空助手 — 載入新模板舊 row 不該保留
      var urlList = $('json-url-list');
      var imgList = $('json-image-list');
      if (urlList) urlList.innerHTML = '';
      if (imgList) imgList.innerHTML = '';
      // 觸發圖片+URL 助手 scan + 預覽
      setTimeout(function () {
        scanJsonImagesAndUrls();
        renderColorPalette();
        schedulePreview();
      }, 100);
      return;
    }
    // template mode：折疊進階區、顯示黃色模板
    var advBlock2 = document.getElementById('advanced-json-block');
    if (advBlock2 && advBlock2.open) advBlock2.open = false;
    state.mode = 'template';
    $('pane-template').hidden = false;
    var t = messageConfig.template || {};
    $('tpl-title').value = t.title || '';
    $('tpl-subtitle').value = t.subtitle || '';
    $('tpl-coupon-code').value = t.couponCode || '';
    $('tpl-disclaimer').value = t.disclaimer || '';
    $('tpl-cta-label').value = t.ctaLabel || '';
    $('tpl-cta-url').value = t.ctaUrl || '';
    $('tpl-alt').value = t.altText || '';
    if (topAltEl) topAltEl.value = t.altText || '';
    if (t.heroMediaId) {
      state.heroMediaId = t.heroMediaId;
      // hero url 不在 message_config 內，模板載入時不還原 url（會顯示 mediaId hint）
      state.heroUrl = null;
    } else {
      state.heroMediaId = null;
      state.heroUrl = null;
    }
    renderHeroStatus(false);
    schedulePreview();
  }

  $('template-select').addEventListener('change', function () {
    var id = $('template-select').value;
    $('btn-delete-template').hidden = !id;
    if (!id) return;
    fetch('/admin/broadcast/templates/' + id)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          alert('載入失敗：' + (data.error || ''));
          return;
        }
        applyMessageConfigToForm(data.template.message_config);
        state.messagePreviewed = false;
        updateSendButton();
        saveDraft();
      });
  });

  $('btn-save-template').addEventListener('click', function () {
    var cfg = collectMessageConfig();
    if (cfg.mode === 'flex_json' && cfg.flex === null) {
      alert('JSON 格式錯誤，無法儲存：' + cfg._parseError);
      return;
    }
    var name = prompt('替這份訊息命名（之後從下拉選用）：', '');
    if (!name) return;
    name = name.trim();
    if (!name) { alert('名稱不可為空'); return; }
    fetch('/admin/broadcast/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, message_config: cfg })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          alert('儲存失敗：' + (data.error || '') + (data.detail ? '｜' + data.detail : ''));
          return;
        }
        alert('已儲存模板「' + name + '」');
        loadMessageTemplates();
        // 載入後自動選新模板
        setTimeout(function () {
          $('template-select').value = String(data.template.id);
          $('btn-delete-template').hidden = false;
        }, 300);
      });
  });

  $('btn-delete-template').addEventListener('click', function () {
    var sel = $('template-select');
    var id = sel.value;
    if (!id) return;
    var label = sel.options[sel.selectedIndex].text;
    if (!confirm('確定刪除模板「' + label + '」？這個動作無法復原。')) return;
    fetch('/admin/broadcast/templates/' + id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { alert('刪除失敗：' + (data.error || '')); return; }
        loadMessageTemplates();
        $('btn-delete-template').hidden = true;
      });
  });

  loadMessageTemplates();

  // ------------------------------------------------------------------
  // 8. send / process-chunk loop
  // ------------------------------------------------------------------
  function sendingBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  function updateSendButton() {
    var btn = $('btn-send');
    var ready =
      INIT.hasLineToken &&
      state.audiencePreviewedTotal !== null &&
      state.audiencePreviewedTotal > 0 &&
      state.messagePreviewed &&
      !state.sending;
    // 按鈕文字：收件人預覽完成後顯示人數
    var total = state.audiencePreviewedTotal;
    if (total !== null && total > 0) {
      btn.textContent = state.sendMode === 'scheduled'
        ? '排程發送給 ' + total + ' 人'
        : '正式送出給 ' + total + ' 人';
    } else {
      btn.textContent = state.sendMode === 'scheduled' ? '排程送出' : '立即送出';
    }
    // 送出期間掛 beforeunload，避免關頁中斷送出
    if (state.sending) {
      window.addEventListener('beforeunload', sendingBeforeUnload);
    } else {
      window.removeEventListener('beforeunload', sendingBeforeUnload);
    }
    // 不真的 disable，click 仍能 fire 才能給 user 明確 hint
    if (ready) {
      btn.classList.remove('btn-needs-prep');
      btn.title = '';
    } else {
      btn.classList.add('btn-needs-prep');
      btn.title = '需先完成步驟 1（預覽收件人）與步驟 2（預覽訊息）';
    }
  }

  function checkSendReadiness() {
    if (state.sending) return { ok: false, reason: '正在送出中，請稍候' };
    if (!INIT.hasLineToken) return { ok: false, reason: '尚未設定 LINE_CHANNEL_ACCESS_TOKEN，無法送出' };
    if (state.audiencePreviewedTotal === null) {
      return { ok: false, reason: '請先在步驟 1 點「預覽收件人」按鈕確認對象', focusEl: 'btn-preview-audience' };
    }
    if (state.audiencePreviewedTotal === 0) {
      return { ok: false, reason: '收件人為 0，請調整條件或選不同名單', focusEl: 'btn-preview-audience' };
    }
    if (!state.messagePreviewed) {
      return { ok: false, reason: '預覽尚未產生 — 請編輯訊息或從訊息模板選一個，等預覽顯示後再送', focusEl: 'msg-preview' };
    }
    if (state.mode === 'flex_json') {
      var phSource = ($('flex-json') ? $('flex-json').value : '');
      if (state.abTestEnabled && $('b-flex-json')) phSource += '\n' + $('b-flex-json').value;
      var phMatches = phSource.match(/REPLACE_[A-Z0-9_]+/g) || [];
      var phSeen = {};
      phMatches.forEach(function (p) { phSeen[p] = true; });
      var phCount = Object.keys(phSeen).length;
      if (phCount > 0) {
        return {
          ok: false,
          reason: '訊息裡還有 ' + phCount + ' 個圖片或連結沒設定（會發出破圖或點不開的連結）。請到『圖片上傳助手』和『URL 填寫助手』完成設定',
          focusEl: 'advanced-json-block'
        };
      }
    }
    if (state.sendMode === 'scheduled') {
      var dtStr = $('schedule-datetime').value;
      if (!dtStr) return { ok: false, reason: '請選擇排程時間', focusEl: 'schedule-datetime' };
      var dt = new Date(dtStr + ':00+08:00');
      if (isNaN(dt.getTime())) return { ok: false, reason: '排程時間格式錯誤' };
      if (dt.getTime() <= Date.now() + 60 * 1000) return { ok: false, reason: '排程時間必須在 1 分鐘後' };
    }
    return { ok: true };
  }

  // send-mode radio：切換顯示 + 按鈕文字
  $$('input[name="send-mode"]').forEach(function (r) {
    r.addEventListener('change', function () {
      var v = r.value;
      if (!r.checked) return;
      state.sendMode = v;
      $('schedule-field').hidden = (v !== 'scheduled');
      updateSendButton();
    });
  });

  $('btn-send').addEventListener('click', function () {
    var check = checkSendReadiness();
    if (!check.ok) {
      alert('無法送出：\n\n' + check.reason);
      if (check.focusEl) {
        var el = $(check.focusEl);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.focus();
        }
      }
      return;
    }
    openSendConfirm();
  });

  // 實際送出流程（抽出，由確認 modal 的「確定發送」呼叫）
  function executeSend() {
    // 最後一道把關：modal 開著期間若改了名單/條件/排程，狀態可能已變，送出前再驗一次
    var finalCheck = checkSendReadiness();
    if (!finalCheck.ok) {
      closeSendConfirm();
      alert('狀態已變更，無法送出：\n\n' + finalCheck.reason);
      return;
    }
    state.sending = true;
    updateSendButton();
    var progressWrap = $('send-progress');
    var bar = $('progress-bar-inner');
    var meta = $('progress-meta');
    var cancelBtn = $('btn-cancel');
    progressWrap.hidden = false;
    meta.textContent = '建立批次中…';
    bar.style.width = '0%';

    var createBody = {
      channel: getActiveChannel(),
      conditions: collectConditions(),
      message_config: collectMessageConfig(),
      send_mode: state.sendMode
    };
    if (createBody.channel === 'email') {
      createBody.email_subject = ($('email-subject') && $('email-subject').value || '').trim();
      createBody.email_from_name = ($('email-from-name') && $('email-from-name').value || '').trim();
      createBody.email_from_address = ($('email-from-address') && $('email-from-address').value || '').trim();
    }
    if (state.sendMode === 'scheduled') {
      createBody.scheduled_at = $('schedule-datetime').value;
    }
    if (state.abTestEnabled) {
      createBody.ab_test = true;
      createBody.variant_b_message_config = collectVariantBMessageConfig();
    }
    fetch('/admin/broadcast/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody)
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
        if (data.scheduled) {
          // 排程：不啟動前端 chunk loop，等 cron 處理
          bar.style.width = '100%';
          meta.innerHTML = '已排程批次 #' + data.broadcastId + '，' + data.total + ' 人。' +
            '預定 <strong>' + new Date(data.scheduledAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) +
            '</strong> 由 cron 自動送出。可至「群發歷史」追蹤狀態。';
          state.sending = false;
          updateSendButton();
          return;
        }
        cancelBtn.hidden = false;
        meta.textContent = '批次 #' + data.broadcastId + ' 已建立，共 ' + data.total + ' 人。正在送出…';
        processChunkLoop(data.broadcastId, data.total, 0);
      })
      .catch(function (e) {
        meta.textContent = '網路錯誤：' + e.message;
        state.sending = false;
        updateSendButton();
      });
  }

  // ===== 正式發送確認 modal =====
  function openSendConfirm() {
    var overlay = $('send-confirm-overlay');
    if (!overlay) { executeSend(); return; } // modal 不存在時退回直接送（仍有就緒檢查把關）
    var channel = getActiveChannel();
    var total = Number(state.audiencePreviewedTotal || 0);
    var scheduled = state.sendMode === 'scheduled';
    $('sc-channel').textContent = channel === 'email' ? 'Email' : 'LINE';
    $('sc-total').textContent = total.toLocaleString() + ' 人';
    $('sc-titlek').textContent = channel === 'email' ? '郵件主旨' : '通知文字';
    var ttl = channel === 'email'
      ? (($('email-subject') && $('email-subject').value || '').trim() || '（未填主旨）')
      : (($('msg-alt-text') && $('msg-alt-text').value || '').trim() || '（未填通知文字）');
    $('sc-msgtitle').textContent = ttl;
    if (scheduled) {
      $('sc-schedule-row').hidden = false;
      $('sc-schedule').textContent = (($('schedule-datetime') && $('schedule-datetime').value) || '').replace('T', ' ');
    } else {
      $('sc-schedule-row').hidden = true;
    }
    $('sc-ab-row').hidden = !state.abTestEnabled;
    var go = $('sc-btn-go');
    if (scheduled) {
      $('sc-title').textContent = '最後確認：排程發送';
      $('sc-warn').textContent = '排程後系統會在指定時間自動送出，屆時無法回收。請再次確認以下內容。';
      go.textContent = '確定排程給 ' + total.toLocaleString() + ' 人';
    } else {
      $('sc-title').textContent = '最後確認：正式發送';
      $('sc-warn').textContent = '送出後無法回收。請再次確認以下內容。';
      go.textContent = '確定發送給 ' + total.toLocaleString() + ' 人';
    }
    var chk = $('sc-confirm-check');
    chk.checked = false;
    go.disabled = true;
    overlay.hidden = false;
    var cancelBtn = $('sc-btn-cancel');
    if (cancelBtn) cancelBtn.focus();
  }
  function closeSendConfirm() {
    var overlay = $('send-confirm-overlay');
    if (overlay) overlay.hidden = true;
  }
  (function wireSendConfirm() {
    var chk = $('sc-confirm-check');
    var go = $('sc-btn-go');
    var cancel = $('sc-btn-cancel');
    var overlay = $('send-confirm-overlay');
    if (chk && go) chk.addEventListener('change', function () { go.disabled = !chk.checked; });
    if (go) go.addEventListener('click', function () {
      if (!chk || !chk.checked) return;
      closeSendConfirm();
      executeSend();
    });
    if (cancel) cancel.addEventListener('click', closeSendConfirm);
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) closeSendConfirm(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay && !overlay.hidden) closeSendConfirm();
    });
  })();

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
            meta.textContent = '完成。共處理 ' + newProcessed + ' 人。請至「近期批次」查看詳細。';
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
    'tpl-cta-label', 'tpl-cta-url', 'tpl-alt', 'flex-json', 'test-recipient',
    // 通知文字 / Email / A/B 版本 B —— 也要在輸入時觸發自動存草稿
    'msg-alt-text', 'email-subject', 'email-from-name', 'email-from-address',
    'b-tpl-title', 'b-tpl-subtitle', 'b-tpl-coupon-code', 'b-tpl-disclaimer',
    'b-tpl-cta-label', 'b-tpl-cta-url', 'b-tpl-alt', 'b-flex-json'
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
        altTop: ($('msg-alt-text') ? $('msg-alt-text').value : ''),
        email: {
          subject: ($('email-subject') ? $('email-subject').value : ''),
          fromName: ($('email-from-name') ? $('email-from-name').value : ''),
          fromAddress: ($('email-from-address') ? $('email-from-address').value : '')
        },
        abEnabled: !!state.abTestEnabled,
        variantB: {
          title: ($('b-tpl-title') ? $('b-tpl-title').value : ''),
          subtitle: ($('b-tpl-subtitle') ? $('b-tpl-subtitle').value : ''),
          couponCode: ($('b-tpl-coupon-code') ? $('b-tpl-coupon-code').value : ''),
          disclaimer: ($('b-tpl-disclaimer') ? $('b-tpl-disclaimer').value : ''),
          ctaLabel: ($('b-tpl-cta-label') ? $('b-tpl-cta-label').value : ''),
          ctaUrl: ($('b-tpl-cta-url') ? $('b-tpl-cta-url').value : ''),
          altText: ($('b-tpl-alt') ? $('b-tpl-alt').value : ''),
          flexJson: ($('b-flex-json') ? $('b-flex-json').value : '')
        },
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
      if (d.altTop != null && $('msg-alt-text')) $('msg-alt-text').value = d.altTop;
      if (d.email) {
        if (d.email.subject != null && $('email-subject')) $('email-subject').value = d.email.subject;
        if (d.email.fromName != null && $('email-from-name')) $('email-from-name').value = d.email.fromName;
        if (d.email.fromAddress != null && $('email-from-address')) $('email-from-address').value = d.email.fromAddress;
      }
      var vb = d.variantB || {};
      var vbMap = {
        'b-tpl-title': vb.title, 'b-tpl-subtitle': vb.subtitle, 'b-tpl-coupon-code': vb.couponCode,
        'b-tpl-disclaimer': vb.disclaimer, 'b-tpl-cta-label': vb.ctaLabel, 'b-tpl-cta-url': vb.ctaUrl,
        'b-tpl-alt': vb.altText, 'b-flex-json': vb.flexJson
      };
      Object.keys(vbMap).forEach(function (id) {
        if (vbMap[id] != null && $(id)) $(id).value = vbMap[id];
      });
      if (d.abEnabled && $('ab-test-enable') && !$('ab-test-enable').checked) {
        $('ab-test-enable').checked = true;
        $('ab-test-enable').dispatchEvent(new Event('change'));
      }
      if (d.hero && d.hero.mediaId) {
        state.heroMediaId = d.hero.mediaId;
        state.heroUrl = d.hero.url || null;
        renderHeroStatus(true);
      }
      if (d.mode === 'flex_json') {
        // 展開進階 JSON 區塊會觸發其 toggle handler，把 state.mode 設成 flex_json
        var advBlock = document.getElementById('advanced-json-block');
        if (advBlock && !advBlock.open) advBlock.open = true;
        state.mode = 'flex_json';
        if ($('pane-template')) $('pane-template').hidden = true;
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
    var fi = $('hero-file');
    if (fi) fi.value = '';
    renderHeroStatus(false);
    var ds = $('draft-status-time');
    if (ds) ds.textContent = '已清除草稿';
  }

  // ----- hero status 渲染（含「移除」link）-----
  function renderHeroStatus(isFromDraft) {
    var hs = $('hero-status');
    if (!hs) return;
    if (state.heroMediaId && state.heroUrl) {
      hs.innerHTML =
        (isFromDraft ? '已上傳（草稿）' : '已上傳') +
        ' <a href="' + state.heroUrl + '" target="_blank" rel="noopener">查看</a>' +
        ' <button type="button" class="link-btn btn-hero-remove" style="color:#dc2626;margin-left:8px;">移除</button>';
      var rmBtn = hs.querySelector('.btn-hero-remove');
      if (rmBtn) rmBtn.addEventListener('click', clearHero);
    } else if (state.heroMediaId) {
      hs.innerHTML =
        '已存草稿 (mediaId: ' + state.heroMediaId.slice(0, 8) + '…)' +
        ' <button type="button" class="link-btn btn-hero-remove" style="color:#dc2626;margin-left:8px;">移除</button>';
      var rmBtn2 = hs.querySelector('.btn-hero-remove');
      if (rmBtn2) rmBtn2.addEventListener('click', clearHero);
    } else {
      hs.textContent = '未上傳';
    }
  }

  function clearHero() {
    state.heroMediaId = null;
    state.heroUrl = null;
    state.messagePreviewed = false;
    var fi = $('hero-file');
    if (fi) fi.value = '';
    renderHeroStatus(false);
    updateSendButton();
    saveDraft();
    schedulePreview();
  }

  DRAFT_FIELDS.forEach(function (id) {
    var el = $(id);
    if (el) el.addEventListener('input', scheduleSave);
  });
  var btnClearDraft = $('btn-clear-draft');
  if (btnClearDraft) btnClearDraft.addEventListener('click', clearDraft);

  // ------------------------------------------------------------------
  // 10. recipient lists（已儲存名單 + 上傳）
  // ------------------------------------------------------------------
  function loadSavedLists() {
    var sel = $('saved-list-select');
    sel.innerHTML = '<option value="">— 載入中 —</option>';
    fetch('/admin/broadcast/recipient-lists')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok || !data.lists || data.lists.length === 0) {
          sel.innerHTML = '<option value="">— 尚無已儲存名單 —</option>';
          $('btn-delete-saved-list').hidden = true;
          return;
        }
        sel.innerHTML = '<option value="">— 請選擇 —</option>' +
          data.lists.map(function (l) {
            var label = l.name + '（' + l.total + ' 人）';
            return '<option value="' + l.id + '">' + escapeHtml(label) + '</option>';
          }).join('');
      })
      .catch(function () {
        sel.innerHTML = '<option value="">— 載入失敗 —</option>';
      });
  }

  $('saved-list-select').addEventListener('change', function () {
    var hasVal = !!$('saved-list-select').value;
    $('btn-delete-saved-list').hidden = !hasVal;
    state.audiencePreviewedTotal = null;
    $('audience-status').textContent = '尚未預覽';
    $('audience-sample').hidden = true;
    updateSendButton();
  });

  $('btn-delete-saved-list').addEventListener('click', function () {
    var sel = $('saved-list-select');
    var id = sel.value;
    if (!id) return;
    var label = sel.options[sel.selectedIndex].text;
    if (!confirm('確定刪除「' + label + '」？這個動作無法復原。')) return;
    fetch('/admin/broadcast/recipient-lists/' + id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.ok) {
          loadSavedLists();
          state.audiencePreviewedTotal = null;
          $('audience-status').textContent = '已刪除';
          $('audience-sample').hidden = true;
          updateSendButton();
        } else {
          alert('刪除失敗：' + (data.error || ''));
        }
      });
  });

  function parseUidsFromText(text) {
    var raw = String(text || '');
    var tokens = raw.split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var seen = {};
    var valid = [];
    var invalid = [];
    tokens.forEach(function (t) {
      var clean = t.replace(/^["']|["']$/g, '');
      if (/^U[0-9a-f]{32}$/i.test(clean)) {
        var key = clean.toLowerCase();
        if (!seen[key]) {
          seen[key] = true;
          valid.push(clean);
        }
      } else if (clean) {
        invalid.push(clean);
      }
    });
    return { valid: valid, invalid: invalid };
  }

  $('upload-list-uids').addEventListener('input', function () {
    var parsed = parseUidsFromText($('upload-list-uids').value);
    var c = $('upload-list-counter');
    if (parsed.invalid.length > 0) {
      c.innerHTML = '已輸入 <strong>' + parsed.valid.length + '</strong> 個有效 UID ' +
        '<span style="color:#b45309">（另有 ' + parsed.invalid.length + ' 個格式錯誤，上傳時會跳過）</span>';
    } else {
      c.textContent = '已輸入 ' + parsed.valid.length + ' 個有效 UID';
    }
  });

  $('btn-upload-list').addEventListener('click', function () {
    var statusEl = $('upload-list-status');
    var name = $('upload-list-name').value.trim();
    var desc = $('upload-list-desc').value.trim();
    var parsed = parseUidsFromText($('upload-list-uids').value);
    if (!name) { statusEl.textContent = '請填名單顯示名'; return; }
    if (parsed.valid.length === 0) { statusEl.textContent = '無有效 UID（每個需 U + 32 hex）'; return; }
    if (!confirm('將儲存名單「' + name + '」共 ' + parsed.valid.length + ' 人，確認？')) return;
    statusEl.textContent = '儲存中…';
    fetch('/admin/broadcast/recipient-lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, description: desc, lineUserIds: parsed.valid })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          statusEl.textContent = '失敗：' + (data.error || '') + (data.detail ? '｜' + data.detail : '');
          return;
        }
        statusEl.innerHTML = '已儲存「<strong>' + escapeHtml(data.list.name) + '</strong>」' +
          '（' + data.accepted + ' 人' +
          (data.rejectedInvalid > 0 ? '；忽略 ' + data.rejectedInvalid + ' 個格式錯誤' : '') +
          '）。已切到「已儲存名單」並選好。';
        $('upload-list-name').value = '';
        $('upload-list-desc').value = '';
        $('upload-list-uids').value = '';
        $('upload-list-counter').textContent = '已輸入 0 個 UID';
        var savedTabBtn = document.querySelector('.tab-btn[data-audience="saved_list"]');
        if (savedTabBtn) savedTabBtn.click();
        setTimeout(function () {
          $('saved-list-select').value = String(data.list.id);
          $('saved-list-select').dispatchEvent(new Event('change'));
        }, 300);
      });
  });

  // ------------------------------------------------------------------
  // 11. JSON 圖片上傳助手（友善：自動偵測 REPLACE_* placeholder + UI 上傳）
  // ------------------------------------------------------------------
  // 偵測 image URL 內的 ID（placeholder OR 已綁定的 mediaId UUID）
  var JSON_IMAGE_URL_RE =
    /(?:p\/line-media|v\/b\/[^/'"\\s]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|REPLACE_[A-Z0-9_]+)/gi;
  // 純 placeholder（給 URL form 用）
  var JSON_URL_PLACEHOLDER_RE = /\b(REPLACE_[A-Z0-9_]+)\b/g;
  var ANY_REPLACE_RE = /REPLACE_[A-Z0-9_]+/;
  var MEDIA_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ----- 智慧 context 偵測：parse JSON 後找出每個 placeholder 對應的訊息位置 -----
  function findFirstText(arr) {
    if (!Array.isArray(arr)) return '';
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (item && item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim();
      }
      if (item && item.type === 'box' && Array.isArray(item.contents)) {
        var sub = findFirstText(item.contents);
        if (sub) return sub;
      }
    }
    return '';
  }

  function extractBubbleLabel(bubble) {
    if (!bubble || typeof bubble !== 'object') return '';
    // 優先順序：header 第一個 text > body 第一個 text > footer 第一個 text
    var sources = [];
    if (bubble.header && Array.isArray(bubble.header.contents)) sources.push(bubble.header.contents);
    if (bubble.body && Array.isArray(bubble.body.contents)) sources.push(bubble.body.contents);
    if (bubble.footer && Array.isArray(bubble.footer.contents)) sources.push(bubble.footer.contents);
    for (var i = 0; i < sources.length; i++) {
      var t = findFirstText(sources[i]);
      if (t) return t;
    }
    return '';
  }

  function extractActionLabel(node) {
    if (!node || typeof node !== 'object') return '';
    // 1. action.label
    if (node.action && typeof node.action.label === 'string' && node.action.label.trim()) {
      var lbl = node.action.label.trim();
      // 忽略過於通用的 default
      if (lbl !== 'OPEN' && lbl !== '查看' && lbl !== '詳情' && lbl !== '修改') {
        return lbl;
      }
    }
    // 2. node 是 text → 用 text 本身
    if (node.type === 'text' && typeof node.text === 'string' && node.text.trim()) {
      return node.text.trim();
    }
    // 3. node 是 box → 找 contents 內第一個 text
    if (node.type === 'box' && Array.isArray(node.contents)) {
      var t = findFirstText(node.contents);
      if (t) return t;
    }
    // 4. 退回 action.label（即使是通用詞）
    if (node.action && typeof node.action.label === 'string') return node.action.label;
    return '';
  }

  function walkContext(node, ctx, ancestorBubbleLabel) {
    if (!node || typeof node !== 'object') return;
    var bubbleLabel = ancestorBubbleLabel;
    if (node.type === 'bubble') {
      bubbleLabel = extractBubbleLabel(node);
    }
    // image with REPLACE_ 或 mediaId UUID in url
    if (node.type === 'image' && typeof node.url === 'string') {
      var mi = node.url.match(/\/(?:p\/line-media|v\/b\/[^/'"\\s]+)\/([0-9a-f-]{36}|REPLACE_[A-Z0-9_]+)/i);
      if (mi) {
        var imgKey = mi[1];
        ctx.image[imgKey] = { label: bubbleLabel || '' };
      }
    }
    // action.uri with REPLACE_
    if (node.action && node.action.type === 'uri' && typeof node.action.uri === 'string') {
      var mu = node.action.uri.match(ANY_REPLACE_RE);
      if (mu) {
        ctx.url[mu[0]] = { label: extractActionLabel(node) };
      }
    }
    // 走 children
    Object.keys(node).forEach(function (k) {
      var v = node[k];
      if (Array.isArray(v)) {
        v.forEach(function (item) { walkContext(item, ctx, bubbleLabel); });
      } else if (v && typeof v === 'object') {
        walkContext(v, ctx, bubbleLabel);
      }
    });
  }

  function scanJsonContext() {
    var raw = $('flex-json').value || '';
    var ctx = { image: {}, url: {} };
    try {
      var parsed = JSON.parse(raw);
      walkContext(parsed, ctx, '');
    } catch (e) {
      // ignore — JSON 半輸入狀態，沒 context 也 OK
    }
    return ctx;
  }

  // image scan：永遠 rebuild image list，每個 URL 顯示一個 row（含已綁定 mediaId 的）
  function scanJsonImages() {
    var raw = $('flex-json').value || '';
    var seen = {};
    var list = [];
    var m;
    JSON_IMAGE_URL_RE.lastIndex = 0;
    while ((m = JSON_IMAGE_URL_RE.exec(raw)) !== null) {
      if (!seen[m[1]]) { seen[m[1]] = true; list.push(m[1]); }
    }
    var ctx = scanJsonContext();
    renderJsonImageRows(list, ctx.image);
  }

  // URL scan：rebuild URL list 只列尚未套用的 REPLACE_* placeholder
  // 已套用的 row 由 DOM 保持（不會被這個函式刪除）— 套用 handler 自行 update row
  function scanJsonUrls() {
    var raw = $('flex-json').value || '';
    var imgSet = {};
    JSON_IMAGE_URL_RE.lastIndex = 0;
    var m;
    while ((m = JSON_IMAGE_URL_RE.exec(raw)) !== null) imgSet[m[1]] = true;
    var allSet = {};
    var newPlaceholders = [];
    JSON_URL_PLACEHOLDER_RE.lastIndex = 0;
    while ((m = JSON_URL_PLACEHOLDER_RE.exec(raw)) !== null) {
      if (!allSet[m[1]] && !imgSet[m[1]]) {
        allSet[m[1]] = true;
        newPlaceholders.push(m[1]);
      }
    }
    // 比對 DOM 現有 URL row（含已套用的）
    var existing = {};
    $$('.json-url-row').forEach(function (r) {
      existing[r.getAttribute('data-id')] = r;
    });
    var combined = [];
    Object.keys(existing).forEach(function (k) { combined.push(k); });
    newPlaceholders.forEach(function (p) {
      if (!existing[p]) combined.push(p);
    });
    var ctx = scanJsonContext();
    renderJsonUrlRows(combined, existing, ctx.url);
  }

  // 同時 scan image + URL（給 tab 切換 / 模板載入 / 手動掃描用）
  function scanJsonImagesAndUrls() {
    scanJsonImages();
    scanJsonUrls();
  }

  function renderJsonUrlRows(rowAnchors, preservedRows, contextMap) {
    var helper = $('json-url-helper');
    var list = $('json-url-list');
    if (rowAnchors.length === 0) {
      helper.hidden = true;
      list.innerHTML = '';
      return;
    }
    helper.hidden = false;
    list.innerHTML = rowAnchors.map(function (anchor, i) {
      var existing = preservedRows && preservedRows[anchor];
      var inputVal = '';
      var statusHtml = '未套用';
      var labelHtml;
      var isApplied = existing && existing.getAttribute('data-applied') === '1';
      // 取 context label — 已套用 row 取自 data-context；未套用 row 取自當前 ctx
      var ctxLabel = '';
      if (isApplied && existing) {
        ctxLabel = existing.getAttribute('data-context') || '';
      } else if (contextMap && contextMap[anchor]) {
        ctxLabel = contextMap[anchor].label || '';
      }
      var contextHtml = ctxLabel
        ? '<span class="jur-context">「' + escapeHtml(ctxLabel) + '」</span>'
        : '';
      if (isApplied) {
        inputVal = anchor;
        statusHtml = '<span style="color:#065f46;">已套用</span>';
        labelHtml = 'URL ' + (i + 1) + '：' + contextHtml + '<span class="muted" style="font-size:11px;">（已綁定）</span>';
      } else {
        labelHtml = 'URL ' + (i + 1) + '：' + contextHtml + '<span class="jur-ph">' + anchor + '</span>';
      }
      return '<div class="json-url-row" data-id="' + anchor + '"' +
        (isApplied ? ' data-applied="1"' : '') +
        (ctxLabel ? ' data-context="' + escapeHtml(ctxLabel) + '"' : '') + '>' +
        '<div class="jur-label">' + labelHtml + '</div>' +
        '<input type="url" class="jur-input" placeholder="https://..." value="' + inputVal.replace(/"/g, '&quot;') + '" />' +
        '<button type="button" class="btn jur-apply">' + (isApplied ? '再套用' : '套用') + '</button>' +
        '<span class="jur-status">' + statusHtml + '</span>' +
        '</div>';
    }).join('');
    $$('.jur-apply', list).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.json-url-row');
        applyJsonUrl(row);
      });
    });
  }

  function applyJsonUrl(row) {
    var anchor = row.getAttribute('data-id');
    var input = row.querySelector('.jur-input');
    var statusEl = row.querySelector('.jur-status');
    var url = String(input.value || '').trim();
    if (!url) { statusEl.textContent = '請填 URL'; return; }
    if (!/^https?:\/\//i.test(url)) { statusEl.textContent = '需 http(s):// 開頭'; return; }
    var textarea = $('flex-json');
    // 整段取代：把「含此 placeholder 的整個 JSON 字串值」換成使用者填的完整網址。
    // 避免模板若是 "https://tw.openrice.com/REPLACE_TARGET" 這種「前綴 + 佔位」時，
    // 只換掉 token 會變成 https://tw.openrice.com/https://...（雙網址、連結失效）。
    var escAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var valRe = new RegExp('"[^"]*' + escAnchor + '[^"]*"', 'g');
    if (valRe.test(textarea.value)) {
      textarea.value = textarea.value.replace(valRe, JSON.stringify(url));
    } else {
      textarea.value = textarea.value.split(anchor).join(url); // 後備：非字串值情境
    }
    row.setAttribute('data-id', url);
    row.setAttribute('data-applied', '1');
    var labelEl = row.querySelector('.jur-label');
    if (labelEl) {
      var idxText = labelEl.textContent.split('：')[0] || 'URL';
      labelEl.innerHTML = idxText + '：<span class="muted" style="font-size:11px;">（已綁定）</span>';
    }
    statusEl.innerHTML = '<span style="color:#065f46;">已套用</span>';
    var btn = row.querySelector('.jur-apply');
    if (btn) btn.textContent = '再套用';
    state.messagePreviewed = false;
    updateSendButton();
    saveDraft();
    // 不 re-scan URL，row 維持
    scanJsonImages();
    schedulePreview();
  }

  // 判斷 ID 是 mediaId UUID 還是 placeholder
  function isMediaIdLike(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
  }

  function renderJsonImageRows(ids, contextMap) {
    var helper = $('json-image-helper');
    var list = $('json-image-list');
    if (ids.length === 0) {
      helper.hidden = true;
      list.innerHTML = '';
      return;
    }
    helper.hidden = false;
    list.innerHTML = ids.map(function (id, i) {
      var bound = isMediaIdLike(id);
      var ctx = (contextMap && contextMap[id]) || null;
      var contextHtml = ctx && ctx.label
        ? '<span class="jir-context">「' + escapeHtml(ctx.label) + '」</span>'
        : '';
      var idHint = bound
        ? '<span style="color:#065f46;font-weight:600;">已綁定</span> <code>' + id.slice(0, 8) + '…</code>'
        : '<span class="jir-ph">' + id + '</span>';
      var labelHtml = '圖 ' + (i + 1) + '：' + contextHtml + idHint;
      var btnLabel = bound ? '更換' : '上傳';
      return '<div class="json-image-row" data-id="' + id + '">' +
        '<div class="jir-label">' + labelHtml + '</div>' +
        '<input type="file" class="jir-file" accept="image/png,image/jpeg" />' +
        '<button type="button" class="btn jir-upload">' + btnLabel + '</button>' +
        '<button type="button" class="jir-remove">不要這張圖</button>' +
        '<span class="jir-status">' + (bound ? '' : '未上傳') + '</span>' +
        '</div>';
    }).join('');
    $$('.jir-upload', list).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.json-image-row');
        uploadJsonImage(row);
      });
    });
    $$('.jir-remove', list).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.json-image-row');
        removeJsonImageBlock(row);
      });
    });
  }

  // 用 JSON.parse 走訪 tree，找到 url 含該 anchor 的 hero/image 區塊並刪除
  function removeJsonImageBlock(row) {
    var ph = row.getAttribute('data-id');
    var textarea = $('flex-json');
    var raw = textarea.value;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      alert('JSON 解析失敗，無法自動移除：' + e.message + '\n請手動編輯 JSON。');
      return;
    }
    var removed = walkAndRemoveImage(parsed, ph);
    if (!removed) {
      alert('找不到含 ' + ph + ' 的圖片區塊。');
      return;
    }
    textarea.value = JSON.stringify(parsed, null, 2);
    state.messagePreviewed = false;
    updateSendButton();
    saveDraft();
    scanJsonImages();
    schedulePreview();
  }

  function walkAndRemoveImage(obj, ph) {
    var removed = false;
    if (!obj || typeof obj !== 'object') return false;
    if (Array.isArray(obj)) {
      // 對於 array，找 image 元素整個移除
      for (var i = obj.length - 1; i >= 0; i--) {
        var item = obj[i];
        if (item && typeof item === 'object' && item.type === 'image' &&
            typeof item.url === 'string' && item.url.indexOf(ph) >= 0) {
          obj.splice(i, 1);
          removed = true;
        } else if (walkAndRemoveImage(item, ph)) {
          removed = true;
        }
      }
      return removed;
    }
    // 對於 object，看每個 key 的 value
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v && typeof v === 'object' && v.type === 'image' &&
          typeof v.url === 'string' && v.url.indexOf(ph) >= 0) {
        delete obj[k];
        removed = true;
      } else if (walkAndRemoveImage(v, ph)) {
        removed = true;
      }
    });
    return removed;
  }

  function uploadJsonImage(row) {
    var anchor = row.getAttribute('data-id');
    var fi = row.querySelector('.jir-file');
    var statusEl = row.querySelector('.jir-status');
    if (!fi.files || fi.files.length === 0) {
      statusEl.textContent = '請先選圖';
      return;
    }
    var file = fi.files[0];
    if (file.size > 2 * 1024 * 1024) { statusEl.textContent = '檔案 > 2MB'; return; }
    statusEl.textContent = '上傳中…';
    var fd = new FormData();
    fd.append('hero', file);
    fetch('/admin/broadcast/hero/upload', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) { statusEl.textContent = '失敗：' + (data.error || ''); return; }
        // 把 textarea 內所有該 anchor (placeholder 或舊 mediaId) 替換為新 mediaId
        var textarea = $('flex-json');
        textarea.value = textarea.value.split(anchor).join(data.mediaId);
        state.messagePreviewed = false;
        updateSendButton();
        saveDraft();
        // 重新 scan image（row 會 rebuild，但仍有 row，這次 ID 是新 mediaId）
        scanJsonImages();
        schedulePreview();
      })
      .catch(function (e) { statusEl.textContent = '錯誤：' + e.message; });
  }

  // 觸發 scan：
  //   textarea input → 只 scan image（不影響 URL 已套用 row）
  //   tab 切換 / 載入模板 / 重新掃描按鈕 → 全 scan（含 URL list rebuild）
  var scanTimer = null;
  function scheduleScanImages() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scanJsonImages, 300);
  }
  $('flex-json').addEventListener('input', scheduleScanImages);
  $('btn-scan-json-images').addEventListener('click', scanJsonImagesAndUrls);
  // tab 切換 → 也 scan 一次
  $$('.tab-btn[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.getAttribute('data-mode') === 'flex_json') {
        setTimeout(scanJsonImagesAndUrls, 50);
      }
    });
  });

  // 啟動：嘗試 restore 上次的草稿
  loadDraft();
  // 草稿載入或 template 套用後 JSON 已就位 → scan
  setTimeout(scanJsonImagesAndUrls, 500);

  // ------------------------------------------------------------------
  // 訊息庫模式（?msglib=1）：複用本編輯器，存到訊息庫而非送出
  // ------------------------------------------------------------------
  if (INIT.msgLibMode) {
    (function initMsgLib() {
      var nameEl = document.getElementById('msglib-name');
      var statusEl = document.getElementById('msglib-status');
      var saveBtn = document.getElementById('msglib-save');
      var editingId = (INIT.msgLibId && !INIT.msgLibDup) ? INIT.msgLibId : null;

      if (INIT.msgLibId) {
        // 編輯或複製既有訊息
        fetch('/admin/messages/api/' + INIT.msgLibId)
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d.ok) { if (statusEl) statusEl.textContent = '載入失敗：' + (d.error || ''); return; }
            var m = d.message;
            if (nameEl) nameEl.value = INIT.msgLibDup ? (m.name + ' 複本') : m.name;
            if (m.message_config) applyMessageConfigToForm(m.message_config);
          })
          .catch(function (e) { if (statusEl) statusEl.textContent = '載入錯誤：' + e.message; });
      } else {
        // 新增：從空白開始（避免帶到上次群發草稿）
        try { applyMessageConfigToForm(BLANK_TEMPLATE_CONFIG); } catch (e) {}
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          var name = nameEl ? nameEl.value.trim() : '';
          if (!name) { if (statusEl) statusEl.textContent = '請填訊息名稱'; if (nameEl) nameEl.focus(); return; }
          var cfg = collectMessageConfig();
          if (cfg.mode === 'flex_json' && cfg.flex === null) {
            if (statusEl) statusEl.textContent = 'JSON 格式錯誤：' + cfg._parseError;
            return;
          }
          saveBtn.disabled = true;
          if (statusEl) statusEl.textContent = '儲存中…';
          var url = editingId ? ('/admin/messages/api/' + editingId) : '/admin/messages/api';
          var method = editingId ? 'PUT' : 'POST';
          fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, channel: 'line', message_config: cfg })
          })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              saveBtn.disabled = false;
              if (!d.ok) {
                if (statusEl) statusEl.textContent = '失敗：' + (d.error || '') + (d.detail ? '（' + d.detail + '）' : '');
                return;
              }
              window.location.href = '/admin/messages';
            })
            .catch(function (e) { saveBtn.disabled = false; if (statusEl) statusEl.textContent = '錯誤：' + e.message; });
        });
      }
    })();
  }
})();
