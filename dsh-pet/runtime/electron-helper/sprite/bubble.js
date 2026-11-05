/**
 * 气泡与悬浮提示的渲染：工作状态 / 碎碎念 / 余额三段内容共用一个气泡槽，按优先级择一显示。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 只读实例状态，除 DOM 与 syncInputBusy() 之外不写任何字段。
 * @module dsh-pet/runtime/electron-helper/sprite-bubble
 */
'use strict';

Object.assign(PetSprite.prototype, {
  setTip(on) {
    const next = !!on;
    if (next === this.tipOn) return;
    this.tipOn = next;
    this.renderTip();
  },

  /**
   * 悬浮提示渲染：文本 = 宠物显示名（宿主已保证非空）；位置 = 光标右下（装不下自动翻边），
   * 摆位判据与浏览器端共用 shared 的 tooltipPlacement。
   *
   * 光标存的是视口坐标，而提示是 position:fixed、DOM 坐标相对窗口，所以这里减掉窗口原点。
   * 存视口坐标而非窗口坐标，是因为窗口会随宠物移动：只在这里按当前原点重算一次，贴光标不会漂。
   */
  renderTip() {
    if (this.tip.textContent !== this.pet.name) this.tip.textContent = this.pet.name;
    const cursor = this.tipCursor;
    if (cursor) {
      const winX = this.pos.x - this.winOffset.x;
      const winY = this.pos.y - this.winOffset.y;
      const winW = this.size + this.margin.l + this.margin.r;
      const winH = this.winH + this.margin.t + this.margin.b;
      // 允许显示范围 = 窗口 ∩ 光标所在屏的工作区：只按窗口夹会画到屏幕外，只按工作区夹会落到
      // 窗口外（html/body 是 overflow:hidden，一样看不见）。
      const area = S.resolveRect(WORK_AREAS, cursor.x, cursor.y) ?? { x: winX, y: winY, width: winW, height: winH };
      const x0 = Math.max(winX, area.x);
      const y0 = Math.max(winY, area.y);
      const x1 = Math.min(winX + winW, area.x + area.width);
      const y1 = Math.min(winY + winH, area.y + area.height);
      const p = S.tooltipPlacement(
        { x: cursor.x - winX, y: cursor.y - winY },
        { w: this.tip.offsetWidth, h: this.tip.offsetHeight },
        { x: x0 - winX, y: y0 - winY, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) },
        this.size * S.TOOLTIP_GAP_RATIO,
      );
      this.tip.style.left = p.x + 'px';
      this.tip.style.top = p.y + 'px';
    }
    this.tip.classList.toggle('is-on', this.tipOn);
    window.__dshPetDebug.tooltipOn = this.tipOn;
  },
  renderBubble() {
    // 待办面板占气泡槽且优先级最高：它是用户主动打开的窗口，其余气泡一律让位。
    // 面板是外部塞进来的 DOM，重建 innerHTML 会把它自己抹掉，所以这一段只补显隐与让位。
    this.bubble.classList.toggle('dsh-pet-todo-bubble', this.todoOpen);
    const alert = S.selectHermesAlert(this.hermesAlerts, this.pet.id, this.frozen);
    if (this.todoOpen || !alert) {
      this.hermesPanel?.dispose();
      this.hermesPanel = null;
    }
    if (this.todoOpen) {
      this.bubbleSlot = 'todo';
      this.bubble.classList.remove('is-whisper', 'is-clickable', S.MEME_BUBBLE_CLASS);
      this.bubble.classList.add('is-on');
      window.__dshPetDebug.lastBubbleTitle = '待办事项';
      this.syncInputBusy();
      return;
    }
    if (alert) {
      this.bubbleSlot = 'hermes';
      if (!this.hermesPanel) {
        this.bubble.replaceChildren();
        this.hermesPanel = S.createHermesAlertPanel({
          baseUrl: BASE,
          open: (url) => window.petBridge.openHermesConversation(url),
        });
        this.hermesPanel.el.addEventListener('pointerdown', () => window.petBridge.requestKeyboardFocus());
        this.bubble.appendChild(this.hermesPanel.el);
      }
      this.hermesPanel.update({ alert, stale: this.hermesAlerts.stale, count: this.hermesAlerts.alerts.length });
      this.bubble.classList.remove('is-whisper', S.MEME_BUBBLE_CLASS);
      this.bubble.classList.add('is-on', 'is-clickable');
      window.__dshPetDebug.lastBubbleTitle = alert.title;
      this.syncInputBusy();
      return;
    }
    // 气泡单槽：同一时刻只显示一个（优先级：终态任务 > 说话 > 非终态任务）。
    // 终态任务不让位：完成/失败气泡只活 10s，被顶掉就彻底看不到；非终态气泡常驻，让位零损失。
    // 工作气泡与碎碎念同款样式（宽度自适应 + 自动换行）；配图标记交给 CSS（带图时取消 min-width）。
    // 图片 URL 与视频同规则：传 BASE 前缀（桌面是 file:// 页面，必须绝对地址），素材根同理。
    const workOn = !!(this.workOn && this.workText);
    const whisperOn = !!(this.whisperOn && this.whisperView);
    const workTerminal = this.workState === 'success' || this.workState === 'error';
    const slot = workTerminal && workOn ? 'work' : whisperOn ? 'whisper' : workOn ? 'work' : 'none';
    // 记住当前槽位：点击处理在 init.js，必须知道「现在显示的是哪一种气泡」才能分清翻页与跳会话。
    this.bubbleSlot = slot;
    // 配图两种形态二选一：url 用完整地址，image 按素材根拼表情包路径；样式/class 共用。
    const whisperImg =
      slot === 'whisper'
        ? this.whisperUrl
          ? S.createMemeImageFromUrl(this.whisperUrl)
          : S.createMemeImage(this.whisperImage, BASE, this.assetRoot)
        : null;
    this.bubble.classList.toggle('is-whisper', slot === 'whisper' || slot === 'work');
    this.bubble.classList.toggle(S.MEME_BUBBLE_CLASS, !!whisperImg);
    // 可点 → 气泡参与命中区（见 syncInputRegions）：只有带会话的工作气泡可点（跳会话）。
    this.bubble.classList.toggle('is-clickable', this.workClickable());
    if (slot === 'none') {
      // 都没有可显示的内容：隐藏（不占位，也就不会挡住任何一层）
      this.bubble.classList.remove('is-on');
      window.__dshPetDebug.lastBubbleTitle = '';
      this.syncInputBusy(); // 气泡没了 → 撤销它的控件矩形与 busy 标记（否则整窗还留着可点区域）
      return;
    }
    this.bubble.innerHTML = '';
    if (slot === 'work') {
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.workText;
      this.bubble.appendChild(line);
    } else if (slot === 'whisper') {
      // 配图（shared 生成的 <img> + 共用样式）：先看图再读话
      if (whisperImg) this.bubble.appendChild(whisperImg);
      const line = document.createElement('div');
      line.className = 'pet-bub-row';
      line.textContent = this.whisperView[0]?.text ?? '';
      this.bubble.appendChild(line);
      // 语音状态角标：idle 时什么都不加；failed 用静音喇叭，表示这句没念出来
      const voice = S.getVoiceState();
      if (voice !== 'idle') {
        S.injectMemeBubbleCss(); // 角标样式与配图同一份 CSS，两端共用
        const badge = document.createElement('span');
        badge.className =
          'dsh-pet-voice-badge' + (voice === 'loading' ? ' is-loading' : '') + (voice === 'failed' ? ' is-failed' : '');
        badge.setAttribute('aria-hidden', 'true');
        if (voice === 'ready') badge.textContent = '🔊';
        else if (voice === 'failed') badge.textContent = '🔇';
        this.bubble.appendChild(badge);
      }
    }
    this.bubble.classList.add('is-on');
    window.__dshPetDebug.lastBubbleTitle = this.bubble.textContent.slice(0, 60);
    // 气泡内容/尺寸变了 → 重报控件矩形并同步 busy 标记。这里是所有显隐与换内容的汇聚点。
    this.syncInputBusy();
  },
});
