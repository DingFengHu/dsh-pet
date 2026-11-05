/**
 * 右键菜单：打开/关闭、叶子动作派发，以及菜单里用到的自绘节点渲染。
 *
 * PetSprite 由 sprite.js 定义，本文件只往原型上挂方法，必须在其后加载。
 * 菜单结构与文案来自 shared-core（两端同一份）；这里只决定点下去之后做什么。
 * @module dsh-pet/runtime/electron-helper/sprite-menu
 */
'use strict';

// 菜单首项文案随宿主形态变：桌面应用唤起主窗口，独立模式打开本机 AI 设置页，web 宿主打开站点。
const OPEN_LABEL = { desktop: '打开软件', standalone: '打开 AI 设置', web: '打开网站' };

Object.assign(PetSprite.prototype, {
  onContextMenu(e) {
    const d = this.dragState;
    if (d.active || d.dragging || this.justDragged || this.menuOpen) return;
    e.preventDefault();
    this.stopThrow(); // 菜单弹出前停住飞行中的宠物
    this.stopMove(); // 菜单悬停期间宠物不漫游
    // 桌面专属工具根项 + 共享菜单树（动作 → 分类 → 具体动画）。首项文案与去向随宿主形态变，见 OPEN_LABEL。
    // 顺序：打开软件 / 待办 → 动作树 → 显示位置 / 重载配置 / 回到初始位置。
    const tools = [
      {
        label: OPEN_LABEL[OPEN_TARGET],
        action: 'open-site',
        hint: OPEN_SHORTCUT_HINT,
      },
      // 「待办事项」是待办面板的唯一入口（单击宠物不再弹面板）。
      { label: '待办事项', action: 'todo', hint: S.TODO_HOTKEY_HINT },
    ];
    // 动作树之后是维护类：显示位置 → 重载配置 → 回到初始位置。
    const tail = [
      // 显示位置（仅网页/仅桌面/两者/都不）：改这只宠物的 display 配置，由宿主重载生效。
      // 与浏览器端注入同一份子菜单，两端文案与取值不会漂移。不就地开关窗：窗口是进程启动时按
      // DSH_PET_PETS 一次性建的，就地增删既改不了磁盘配置也改不了窗口数量。
      S.displayMenuBranch(),
      // 重载配置：请宿主重启桌面 Helper，全部窗口按最新配置重建。维护动作，排在回到初始位置之前。
      { label: '重载配置', action: 'reload' },
      { label: '回到初始位置', action: 'home' },
    ];
    // 第三方菜单项统一收在「更多」下：label 唯一的直接平铺，label 重名的按 owner 分子菜单。
    // 放在最后——「更多」不插在工具项与动作之间。
    const more = S.buildMoreBranch(this.menuItems);
    const tree = tools.concat(S.buildMenuTree(this.animations), tail, more ? [more] : []);
    if (!tree.length) return;
    this.menuOpen = true;
    this.setInteractive(true); // 菜单是窗口内 DOM：悬停期间整窗保持可交互，关闭后恢复命中区穿透
    this.syncInputBusy();
    window.__dshPetDebug.menuOpen = true;
    const m = S.mountContextMenu({
      tree,
      x: e.clientX,
      y: e.clientY,
      // 只允许在「窗口 ∩ 工作区」内显示：宠物贴边时外扩余量伸出屏幕，菜单走进那里会被 OS 裁掉
      clamp: this.visibleClampRect(),
      onAction: (leaf) => this.onMenuAction(leaf),
      // 菜单被点外/Esc 关闭（非菜单项路径）：同样复位可交互标记，恢复命中区判定
      onClose: () => {
        this.menuOpen = false;
        window.__dshPetDebug.menuOpen = false;
        this.syncInputBusy();
        if (!this.inputBusy()) this.setInteractive(false);
      },
    });
    this.menuClose = m.close;
    this.syncInputRegions(); // mountContextMenu 完成布局后才能读取菜单矩形
  },

  /** keepFacing = 调用方已显式指定朝向：跳过下面「文字类动画点播前强制朝左」的镜像修正，显式值优先。 */
  onMenuAction(leaf, keepFacing) {
    this.closeMenu();
    if (!leaf || typeof leaf !== 'object') return;
    if (leaf.action === 'third-party') {
      // 第三方菜单项：只把 (owner, label) 交给宿主，具体做什么由注册方自己查 /menu/events。
      // 带上宠物 id——同一条菜单项在不同宠物上被点，注册方要能分辨是哪只。
      if (leaf.owner) {
        S.postAction(BASE + '/menu/click', { owner: leaf.owner, label: leaf.label, pet: this.pet.id }).catch(() => {
          /* 上报失败不影响本地：注册方下次轮询自然拿不到这次触发 */
        });
      }
      return;
    }
    if (leaf.action === 'open-site') {
      if (window.petBridge) window.petBridge.openDshSite(ORIGIN); // 系统默认浏览器打开（等效 Ctrl+点击链接）
      return;
    }
    if (leaf.action === 'todo') {
      this.toggleTodo(); // 打开待办面板（右键菜单入口）
      return;
    }
    if (leaf.action === 'home') {
      this.goHome(); // 停漫游/移动，清会话位置，回配置角落
      return;
    }
    if (leaf.action === 'set-display') {
      this.setPetDisplay(leaf.display); // 改这只宠物的显示位置：写 display 配置，由宿主重载生效
      return;
    }
    if (leaf.action === 'reload') {
      this.reloadDesktop(); // 请宿主重启桌面 Helper：全部桌面宠物窗口按最新配置重建
      return;
    }
    if (!leaf.anim) return;
    // 回执归属：这一段若来自第三方点播，编号跟着换源走（自播动画传 null）
    const playbackId = typeof leaf.playbackId === 'string' && leaf.playbackId ? leaf.playbackId : null;
    // 文字类（noMirror）朝右是镜像的：点播前强制朝左，避免文字镜像。keepFacing 时跳过（显式值优先）。
    if (!keepFacing && S.isNoMirrorAnimation(this.animations.categories, leaf.anim) && this.facing === 'right') {
      this.facing = 'left';
    }
    // 点播移动动画：走真实移动（与随机游走同一套），只有「选哪个动画」由菜单决定；挪不动则退化纯播放。
    if (this.animations.moves.actions.some((a) => a.name === leaf.anim)) {
      const moved = this.tryMove(leaf.anim, playbackId);
      if (moved === false) this.playOnce(leaf.anim, playbackId);
      // moved === true = 已有移动/抛掷在进行中（没换源）：本段不会真的播起来 → 如实回 failed/busy
      else if (moved === true && playbackId) this.reportPlayback(playbackId, 'failed', 'busy');
      return;
    }
    this.playOnce(leaf.anim, playbackId);
  },

  closeMenu() {
    if (this.menuClose) {
      this.menuClose();
      this.menuClose = null;
    }
    this.menuOpen = false;
    window.__dshPetDebug.menuOpen = false;
    this.syncInputBusy(); // 菜单关：若没有别的占用（拖拽/弹窗）则交还常规判定
    if (!this.inputBusy()) this.setInteractive(false);
  },

  // 待办面板开关：面板占气泡槽（优先级最高），期间整窗保持可交互，关闭后交还命中区穿透。
  // 与浏览器半侧共用 shared/todo/panel，只有接口基址不同（桌面是 file:// 页面，必须绝对地址）。
  toggleTodo() {
    if (this.todoPanel) {
      this.closeTodo();
      return;
    }
    const panel = S.createTodoPanel({
      baseUrl: BASE + '/todos',
      onClose: () => this.closeTodo(),
      // 点宠物本体不收起：拖它走是常见需求，收起就没法一边看清单一边挪位置。
      keepOpenOn: (target) => typeof target?.closest === 'function' && target.closest('.pet-hit') !== null,
    });
    // replaceChildren 而不是 appendChild：气泡里还留着上一次渲染的行（碎碎念/余额），
    // 而 renderBubble 在面板开着时会提前返回、走不到清空那一步，不清就会叠在面板上方。
    this.bubble.replaceChildren(panel.el);
    this.todoPanel = panel;
    this.todoOpen = true;
    window.__dshPetDebug.todoOpen = true;
    this.renderBubble();
    this.syncInputBusy();
    this.setInteractive(true);
  },

  // 收起待办面板：摘掉面板节点、撤掉气泡变体类，再把槽位交回正常判定。
  closeTodo() {
    const panel = this.todoPanel;
    if (!panel) return;
    panel.dispose();
    this.todoPanel = null;
    this.todoOpen = false;
    window.__dshPetDebug.todoOpen = false;
    this.renderBubble();
    if (!this.menuOpen) this.setInteractive(false);
  },

  // 「回到初始位置」菜单：停掉漫游/移动，清掉会话位置，回到配置角落
  goHome() {
    this.stopThrow();
    this.stopMove();
    this.customPos = null;
    this.position();
  },

  // 「重载配置」菜单：请宿主重启桌面 Helper，与设置页「保存」同一条重启路径（宿主 POST /reload →
  // syncDesktop）。不在渲染端就地重拉：窗口数量/display/size 由宿主按 DSH_PET_PETS 建，且全局轮询是
  // 一次性启动的（loopsStarted），就地重建会漏启新循环或留下旧定时器。
  // 本请求由即将被重启的进程发出，响应可能永远不回（宿主杀进程时回调地址已失效），故不 await、
  // 不重试，失败只记日志——重载本身就是把本进程换掉。
  reloadDesktop() {
    fetch(BASE + '/reload', { method: 'POST' }).catch((e) => {
      console.warn('[dsh-pet] 重载配置请求失败（宿主不可达？）', e);
    });
  },

  // 「显示位置」菜单：改这一只宠物的 display，写它自己的配置，再由宿主重载生效。取值直接来自菜单项，
  // 渲染端不做推导（当前状态以配置为准）。不就地开关窗：窗口是进程启动时按 DSH_PET_PETS 一次性建的。
  // 与 reloadDesktop 同一处境：选「仅网页/都不」时本进程会在重载中被换掉，故不 await、不重试。
  setPetDisplay(display) {
    if (!display) return;
    fetch(BASE + '/pet-display', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: this.pet.id, display }),
    }).catch((e) => {
      console.warn('[dsh-pet] 显示位置请求失败（宿主不可达？）', e);
    });
  },

  /**
   * 自定义节点树 → DOM（custom 形态的渲染器）。
   *
   * tag 与样式白名单在 shared 的解析层已裁过，这里只做映射：不用 innerHTML，文本走 createTextNode，
   * 第三方内容因而没有注入面。样式键是 camelCase，直接赋给 el.style 即可。
   */
  renderTree(node) {
    const el = document.createElement(node.tag);
    if (node.style) {
      for (const [key, value] of Object.entries(node.style)) el.style[key] = value;
    }
    if (node.tag === 'img') {
      el.src = node.src || '';
      el.alt = '';
      return el;
    }
    // 文本与子节点可同时存在：先文本、后子节点（与 textContent + appendChild 的顺序一致）
    if (node.text) el.appendChild(document.createTextNode(node.text));
    for (const child of node.children || []) el.appendChild(this.renderTree(child));
    return el;
  },
});
