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
    abTestEnabled: false
  };

  // ------------------------------------------------------------------
  // 1. tabs
  // ------------------------------------------------------------------
  $$('.tab-btn[data-mode]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var mode = btn.getAttribute('data-mode');
      state.mode = mode;
      $$('.tab-btn[data-mode]').forEach(function (b) { b.classList.toggle('active', b === btn); });
      $('pane-template').hidden = (mode !== 'template');
      $('pane-flex-json').hidden = (mode !== 'flex_json');
      // variant B 跟 variant A 共用 mode
      $('pane-b-template').hidden = (mode !== 'template');
      $('pane-b-flex-json').hidden = (mode !== 'flex_json');
      state.messagePreviewed = false;
      updateSendButton();
      saveDraft();
    });
  });

  // A/B test toggle
  $('ab-test-enable').addEventListener('change', function () {
    state.abTestEnabled = $('ab-test-enable').checked;
    $('variant-b-pane').hidden = !state.abTestEnabled;
    $('variant-a-label').hidden = !state.abTestEnabled;
    state.messagePreviewed = false;
    updateSendButton();
    saveDraft();
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
    // conditions（預設）
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
  }

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
  $('btn-preview-msg').addEventListener('click', function () {
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

    statusEl.textContent = '預覽中…';
    var fetches = [
      fetch('/admin/broadcast/preview-message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_config: cfg })
      }).then(function (r) { return r.json(); })
    ];
    if (state.abTestEnabled) {
      fetches.push(
        fetch('/admin/broadcast/preview-message', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_config: cfgB })
        }).then(function (r) { return r.json(); })
      );
    }
    Promise.all(fetches)
      .then(function (results) {
        var dataA = results[0];
        var dataB = results[1];
        if (!dataA.ok || (state.abTestEnabled && !dataB.ok)) {
          var err = !dataA.ok ? dataA.error : dataB.error;
          statusEl.textContent = '錯誤：' + (err || '');
          state.messagePreviewed = false;
          previewEl.classList.add('empty');
          previewEl.innerHTML = '預覽失敗：' + escapeHtml(err || '');
          updateSendButton();
          return;
        }
        if (state.abTestEnabled) {
          previewEl.classList.remove('empty');
          previewEl.innerHTML =
            '<div style="margin-bottom:6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 A</div>' +
            '<div class="ab-preview-card" id="ab-preview-a"></div>' +
            '<div style="margin:14px 0 6px;font-size:12px;font-weight:600;color:#1d4ed8;">版本 B</div>' +
            '<div class="ab-preview-card" id="ab-preview-b"></div>';
          renderFlexMock(dataA.messages[0], $('ab-preview-a'));
          renderFlexMock(dataB.messages[0], $('ab-preview-b'));
        } else {
          renderFlexMock(dataA.messages[0], previewEl);
        }
        state.messagePreviewed = true;
        statusEl.textContent = '預覽完成';
        updateSendButton();
      })
      .catch(function (e) { statusEl.textContent = '網路錯誤：' + e.message; });
  });

  // ------------------------------------------------------------------
  // 7. render Flex mock (支援 bubble 跟 carousel，含 header/hero/body/footer)
  // ------------------------------------------------------------------
  function renderFlexMock(flexMsg, container) {
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
        renderBubble(bubble, bubbleDiv);
        carouselDiv.appendChild(bubbleDiv);
      });
      container.appendChild(carouselDiv);
      return;
    }
    renderBubble(contents, container);
  }

  function renderBubble(bubble, container) {
    if (!bubble || typeof bubble !== 'object') return;
    // header
    if (bubble.header && Array.isArray(bubble.header.contents)) {
      var headerDiv = document.createElement('div');
      headerDiv.className = 'lm-header';
      applyBoxStyle(bubble.header, headerDiv);
      bubble.header.contents.forEach(function (c) {
        renderFlexComponent(c, headerDiv);
      });
      container.appendChild(headerDiv);
    }
    // hero
    if (bubble.hero && bubble.hero.url) {
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
      bubble.body.contents.forEach(function (c) {
        renderFlexComponent(c, bodyDiv);
      });
      container.appendChild(bodyDiv);
    }
    // footer
    if (bubble.footer && Array.isArray(bubble.footer.contents)) {
      var footerDiv = document.createElement('div');
      footerDiv.className = 'lm-footer';
      applyBoxStyle(bubble.footer, footerDiv);
      bubble.footer.contents.forEach(function (c) {
        renderFlexComponent(c, footerDiv);
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

  function renderFlexComponent(c, parent) {
    if (!c || typeof c !== 'object') return;
    if (c.type === 'text') {
      var t = document.createElement('div');
      var isTitle = (c.weight === 'bold' && (c.size === 'xl' || c.size === 'xxl'));
      t.className = isTitle ? 'lm-title' : 'lm-subtitle';
      if (c.color) t.style.color = c.color;
      if (c.size) t.style.fontSize = mapFlexSize(c.size);
      if (c.weight === 'bold') t.style.fontWeight = '700';
      if (c.align === 'center') t.style.textAlign = 'center';
      if (c.margin) t.style.marginTop = mapFlexSpacing(c.margin);
      if (c.lineSpacing) t.style.lineHeight = '1.55';
      if (c.wrap) t.style.whiteSpace = 'pre-wrap';
      if (c.flex !== undefined) t.style.flex = String(c.flex);
      t.textContent = String(c.text || '');
      if (c.action && c.action.type === 'uri' && c.action.uri) {
        t.style.cursor = 'pointer';
        t.style.textDecoration = 'underline';
        t.addEventListener('click', function () { window.open(c.action.uri, '_blank'); });
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
      applyBoxStyle(c, sub);
      if (c.margin) sub.style.marginTop = mapFlexSpacing(c.margin);
      if (c.flex !== undefined) sub.style.flex = String(c.flex);
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
  function loadMessageTemplates() {
    var sel = $('template-select');
    fetch('/admin/broadcast/templates')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.ok) {
          sel.innerHTML = '<option value="">— 載入失敗 —</option>';
          return;
        }
        var list = data.templates || [];
        if (list.length === 0) {
          sel.innerHTML = '<option value="">— 尚無模板 —</option>';
          return;
        }
        sel.innerHTML = '<option value="">— 載入既有模板 —</option>' +
          list.map(function (t) {
            return '<option value="' + t.id + '">' + escapeHtml(t.name) + '</option>';
          }).join('');
      })
      .catch(function () { sel.innerHTML = '<option value="">— 載入失敗 —</option>'; });
  }

  function applyMessageConfigToForm(messageConfig) {
    if (!messageConfig || typeof messageConfig !== 'object') return;
    if (messageConfig.mode === 'flex_json') {
      // 切到進階 JSON tab
      var jsonBtn = document.querySelector('.tab-btn[data-mode="flex_json"]');
      if (jsonBtn) jsonBtn.click();
      if (messageConfig.flex) {
        $('flex-json').value = JSON.stringify(messageConfig.flex, null, 2);
      }
      // 觸發圖片助手 scan
      setTimeout(scanJsonImagesAndUrls, 100);
      return;
    }
    // template mode
    var tplBtn = document.querySelector('.tab-btn[data-mode="template"]');
    if (tplBtn) tplBtn.click();
    var t = messageConfig.template || {};
    $('tpl-title').value = t.title || '';
    $('tpl-subtitle').value = t.subtitle || '';
    $('tpl-coupon-code').value = t.couponCode || '';
    $('tpl-disclaimer').value = t.disclaimer || '';
    $('tpl-cta-label').value = t.ctaLabel || '';
    $('tpl-cta-url').value = t.ctaUrl || '';
    $('tpl-alt').value = t.altText || '';
    if (t.heroMediaId) {
      state.heroMediaId = t.heroMediaId;
      // hero url 不在 message_config 內，模板載入時不還原 url（會顯示 mediaId hint）
      state.heroUrl = null;
    } else {
      state.heroMediaId = null;
      state.heroUrl = null;
    }
    renderHeroStatus(false);
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
  function updateSendButton() {
    var btn = $('btn-send');
    var ready =
      INIT.hasLineToken &&
      state.audiencePreviewedTotal !== null &&
      state.audiencePreviewedTotal > 0 &&
      state.messagePreviewed &&
      !state.sending;
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
      return { ok: false, reason: '請先在步驟 2 點「預覽訊息」按鈕確認訊息樣式', focusEl: 'btn-preview-msg' };
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
      $('btn-send').textContent = v === 'scheduled' ? '排程送出' : '立即送出';
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
    var confirmMsg;
    if (state.sendMode === 'scheduled') {
      var dtStr2 = $('schedule-datetime').value;
      confirmMsg = '將排程於「' + dtStr2.replace('T', ' ') + '」送給 ' + state.audiencePreviewedTotal + ' 人，確認？';
    } else {
      confirmMsg = '將立即送 ' + state.audiencePreviewedTotal + ' 人。發出後無法回收，確認？';
    }
    if (!confirm(confirmMsg)) return;
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
      conditions: collectConditions(),
      message_config: collectMessageConfig(),
      send_mode: state.sendMode
    };
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
        renderHeroStatus(true);
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
    renderJsonImageRows(list);
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
    // 全新出現的 placeholder → append；舊的（含已套用）keep；不存在的 placeholder
    // 但 row 也不在 DOM → 也不會出現
    var combined = [];
    // existing rows（含已套用 URL）排前面
    Object.keys(existing).forEach(function (k) { combined.push(k); });
    // 新發現的 placeholder
    newPlaceholders.forEach(function (p) {
      if (!existing[p]) combined.push(p);
    });
    renderJsonUrlRows(combined, existing);
  }

  // 同時 scan image + URL（給 tab 切換 / 模板載入 / 手動掃描用）
  function scanJsonImagesAndUrls() {
    scanJsonImages();
    scanJsonUrls();
  }

  function renderJsonUrlRows(rowAnchors, preservedRows) {
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
      if (isApplied) {
        // 之前已套用過，anchor 是已替換的 URL（或 placeholder）
        inputVal = anchor;
        statusHtml = '<span style="color:#065f46;">已套用</span>';
        labelHtml = 'URL ' + (i + 1) + '：<span class="muted" style="font-size:11px;">（已綁定）</span>';
      } else {
        labelHtml = 'URL ' + (i + 1) + '：<code>' + anchor + '</code>';
      }
      return '<div class="json-url-row" data-id="' + anchor + '"' +
        (isApplied ? ' data-applied="1"' : '') + '>' +
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
    textarea.value = textarea.value.split(anchor).join(url);
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
  }

  // 判斷 ID 是 mediaId UUID 還是 placeholder
  function isMediaIdLike(id) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''));
  }

  function renderJsonImageRows(ids) {
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
      var labelHtml = '圖片 ' + (i + 1) + '：' + (
        bound
          ? '<span style="color:#065f46;font-weight:600;">已綁定</span> <code>' + id.slice(0, 8) + '…</code>'
          : '<code>' + id + '</code>'
      );
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
})();
