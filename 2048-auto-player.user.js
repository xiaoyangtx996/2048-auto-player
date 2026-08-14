// ==UserScript==
// @name         2048 Auto Player (合法走子)
// @namespace    local.2048.auto
// @version      2.6.1
// @description  v2.6：强化蛇形递减/反夹心；次大贴角；危机盘加深；合法move only
// @author       local
// @homepageURL  https://github.com/xiaoyangtx996/2048-auto-player
// @downloadURL  https://raw.githubusercontent.com/xiaoyangtx996/2048-auto-player/main/2048-auto-player.user.js
// @updateURL    https://raw.githubusercontent.com/xiaoyangtx996/2048-auto-player/main/2048-auto-player.user.js
// @match        *://2048.linux.do/*
// @match        *://*.linux.do/2048*
// @match        *://play2048.co/*
// @match        *://gabrielecirulli.github.io/2048/*
// @match        *://*/*2048*
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * CONFIG —— 可调参数与推荐值（v2.6）
   *
   * 【算法架构】真 expectimax：玩家层 max，机会层按 2=0.9 / 4=0.1 期望；
   * 评价偏「蛇形递减」：角锁 + 蛇路径单调 + 反夹心 + 次大贴角旁 + 空格。
   * 合法走子 only：handleMove / gameManager.move / 方向键。不改 tile、不伪造榜。
   *
   * 【v2.6 相对 v2.5 实战】
   *  - 用户观察：第二层「两边夹中间大」胜率差 → 加重蛇路径递减、惩罚夹心
   *  - 两局死于 512/2048 空位耗尽 → 危机盘 think↑、空权动态↑、少 skip4
   *  - 次大砖应在蛇身第二格（贴最大），而不是游离夹击
   *
   * 【推荐起步】
   *  snakeScale≈1.4；snakeMonoWeight≈220；sandwichPenalty≈18000
   *  emptyWeight≈320000；cornerLockWeight≈340000；preferredCorner='bl'
   *  canvas crisis：think≈120ms，empty≤5，chanceSkip4WhenDepthGe≥4
   * ============================================================ */
  const CONFIG = {
    /** 打开页面是否自动开跑（推荐 false，点面板「开始」） */
    autoStart: false,

    /** 本地 gameManager / 键盘：每步间隔 ms（推荐 30~50） */
    moveDelayMs: 40,
    /** 盘面稳定后再额外停顿 ms（推荐 8~24） */
    postMoveSettleMs: 12,
    /** 等动画/盘变的超时 ms（推荐 450~800） */
    animWaitTimeoutMs: 520,
    /** 连续多少帧 boardHash 不变才视为稳定（推荐 2） */
    boardStableFrames: 2,
    /** 走子后盘面未变时的重试等待 ms */
    staleMoveRetryMs: 70,
    staleMoveMaxRetries: 2,

    autoRestart: true,
    restartDelayMs: 900,
    keepGoing: true,
    /** >0 时达到该最大砖可停；0=一直玩 */
    targetMaxTile: 0,

    /**
     * 搜索：迭代加深，至少 depthMin。
     * 推荐 depthMin=2（真 1 玩家步 + 机会层），depthMax=3~4。
     * thinkTimeMs：每步时间预算；过小会退化成浅贪心。
     */
    thinkTimeMs: 75,
    depthMin: 2,
    depthMax: 4,

    /**
     * 评价权重（量级对齐 nneonneo / 常见 expectimax）：
     *  - emptyWeight：每空格分，宜高（推荐 2.8e5~3.4e5）——防卡 128/256
     *  - emptyPower：空格指数，>1 时空位稀缺更痛（推荐 1.1~1.25）
     *  - mergeWeight：相邻同值合并潜力（推荐 800~1500）
     *  - monoWeight：非单调惩罚（推荐 40~60）
     *  - smoothWeight：相邻对数差惩罚系数（推荐 3000~5000）
     *  - snakeBase/snakeScale：蛇形矩阵底数与缩放（base=4 经典）
     *  - cornerLockWeight：最大砖在角奖励 / 离角惩罚（推荐 3.0e5~3.6e5）
     */
    emptyWeight: 320000,
    emptyPower: 1.22,
    /** max≥此值时空位权再乘 emptyLateBoost（防 512/2048 挤死） */
    emptyLateMaxTile: 512,
    emptyLateBoost: 1.35,
    mergeWeight: 1100,
    monoWeight: 48,
    sumPower: 3.5,
    sumWeight: 11,
    smoothWeight: 4200,
    snakeBase: 4,
    /** 蛇形矩阵缩放：越高越强制大砖靠角/蛇头（推荐 1.3~1.5） */
    snakeScale: 1.4,
    /** 沿蛇路径「应递减」的违约惩罚（推荐 180~280） */
    snakeMonoWeight: 220,
    /** 夹心形 a<b>c 且 b 非合并中轴的惩罚系数（推荐 1.2e4~2.5e4） */
    sandwichPenalty: 18000,
    /** 次大砖贴在蛇身第二格的奖励 */
    secondAlongSnakeWeight: 90000,
    cornerLockWeight: 340000,
    lostPenalty: 600000,

    /**
     * 角落策略：bl=左下（配合 down/left 优先）。
     * dirOrder：候选方向优先序；up 最危险。
     * hardCornerLock：空位少时禁止把最大砖移出角。
     * banUpUnlessRescue：非救援禁用 up。
     * rescueEmptyMax：空位≤此值才允许救援性 up。
     */
    preferredCorner: 'bl',
    dirOrder: ['down', 'left', 'right', 'up'],
    hardCornerLock: true,
    banUpUnlessRescue: true,
    rescueEmptyMax: 2,
    /** 空位≤此值才启用硬角锁（推荐 5；过大前期难合砖） */
    hardLockEmptyMax: 5,

    /**
     * 机会层：随机刷砖 2=90% / 4=10%。
     * chanceSampleMax：空位抽样上限（推荐 4~8；越大越准越慢）
     * chanceSkip4WhenDepthGe：仅当剩余玩家深度≥此值才近似只算 2
     *   （推荐 ≥3，保证 depth=2 时完整 0.9/0.1）
     */
    chanceSampleMax: 8,
    chanceSkip4WhenDepthGe: 4,
    requireGameDetect: true,

    /**
     * canvasGame(linux.do)：handleMove 只发 WS，主线程过久会堵回包。
     * 仍用真 expectimax；空位多时缩短 think，空位少时加深。
     * 实战：wsSettle 100ms 会拖到 ~2s/步，冲 8192 不现实 → 默认 40ms。
     */
    canvasThinkTimeMs: 28,
    canvasThinkCrisisMs: 120,
    canvasDepthMax: 3,
    canvasDepthMin: 2,
    canvasWsSettleMs: 40,
    canvasMoveDelayMs: 8,
    /** 空位≤此值用 crisis think/depth（推荐 5；实战 512/2048 死于空位耗尽） */
    canvasCrisisEmpty: 5,
    /** true=board[col][row]；linux.do 实测默认 false（row-major） */
    canvasBoardTransposed: false,
    /** newGame 后等待新局就绪超时 ms */
    newGameWaitMs: 2500,
    /** 保留最近 N 局复盘（面板/ window.__AUTO2048.state.history） */
    historyLimit: 30,
  };

  const VERSION = '2.6.1';

  function pageLooksLike2048() {
    if (window.canvasGame && typeof window.canvasGame.handleMove === 'function') return true;
    if (window.gameManager && typeof window.gameManager.move === 'function') return true;
    if (document.querySelector('.grid-container, #game-board, canvas#game-canvas, .game-container')) return true;
    if (/2048/i.test(location.hostname + location.pathname + (document.title || ''))) return true;
    return false;
  }

  let _booted = false;

  const DIRS = CONFIG.dirOrder.slice();
  const DIR_TO_STD = { up: 0, right: 1, down: 2, left: 3 };

  function cloneBoard(b) {
    return [b[0].slice(), b[1].slice(), b[2].slice(), b[3].slice()];
  }

  function boardsEqual(a, b) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (a[r][c] !== b[r][c]) return false;
    return true;
  }

  function boardHash(b) {
    let h = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) h = (h * 37 + (b[r][c] || 0)) | 0;
    return h;
  }

  function slideRowLeft(row) {
    const a = [];
    for (let i = 0; i < 4; i++) if (row[i]) a.push(row[i]);
    let score = 0;
    let merges = 0;
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (i + 1 < a.length && a[i] === a[i + 1]) {
        const v = a[i] << 1;
        out.push(v);
        score += v;
        merges += 1;
        i++;
      } else out.push(a[i]);
    }
    while (out.length < 4) out.push(0);
    return { row: out, score, merges };
  }

  function moveBoard(board, dir) {
    const b = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    let score = 0;
    let merges = 0;
    const writeLine = (cells, coords) => {
      const s = slideRowLeft(cells);
      score += s.score;
      merges += s.merges;
      for (let i = 0; i < 4; i++) {
        const [r, c] = coords[i];
        b[r][c] = s.row[i];
      }
    };
    if (dir === 'left') {
      for (let r = 0; r < 4; r++) writeLine([board[r][0], board[r][1], board[r][2], board[r][3]], [[r, 0], [r, 1], [r, 2], [r, 3]]);
    } else if (dir === 'right') {
      for (let r = 0; r < 4; r++) writeLine([board[r][3], board[r][2], board[r][1], board[r][0]], [[r, 3], [r, 2], [r, 1], [r, 0]]);
    } else if (dir === 'up') {
      for (let c = 0; c < 4; c++) writeLine([board[0][c], board[1][c], board[2][c], board[3][c]], [[0, c], [1, c], [2, c], [3, c]]);
    } else if (dir === 'down') {
      for (let c = 0; c < 4; c++) writeLine([board[3][c], board[2][c], board[1][c], board[0][c]], [[3, c], [2, c], [1, c], [0, c]]);
    }
    let changed = false;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (b[r][c] !== board[r][c]) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    return { board: b, score, merges, changed };
  }

  function empties(board) {
    const cells = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!board[r][c]) cells.push([r, c]);
    return cells;
  }

  function maxTileAt(board) {
    let m = 0;
    let mr = 0;
    let mc = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] > m) {
          m = board[r][c];
          mr = r;
          mc = c;
        }
      }
    }
    return { max: m, r: mr, c: mc };
  }

  function maxTile(board) {
    return maxTileAt(board).max;
  }

  function cornerPos() {
    switch (CONFIG.preferredCorner) {
      case 'br':
        return [3, 3];
      case 'tl':
        return [0, 0];
      case 'tr':
        return [0, 3];
      default:
        return [3, 0];
    }
  }

  /** 左下角蛇形路径：底行左→右，上行右→左……（经典 snake / 递减） */
  function buildSnakeOrder() {
    const order = [
      [3, 0], [3, 1], [3, 2], [3, 3],
      [2, 3], [2, 2], [2, 1], [2, 0],
      [1, 0], [1, 1], [1, 2], [1, 3],
      [0, 3], [0, 2], [0, 1], [0, 0],
    ];
    if (CONFIG.preferredCorner === 'bl') return order;
    if (CONFIG.preferredCorner === 'br') return order.map(([r, c]) => [r, 3 - c]);
    if (CONFIG.preferredCorner === 'tl') return order.map(([r, c]) => [3 - r, c]);
    return order.map(([r, c]) => [3 - r, 3 - c]);
  }

  function buildSnakeGradient() {
    const order = buildSnakeOrder();
    const g = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    for (let i = 0; i < 16; i++) {
      const [r, c] = order[i];
      g[r][c] = Math.pow(CONFIG.snakeBase, 15 - i);
    }
    return g;
  }

  const SNAKE_ORDER = buildSnakeOrder();
  const SNAKE = buildSnakeGradient();
  const [CR, CC] = cornerPos();

  /** 行/列双向单调惩罚（辅助）；主结构靠蛇路径递减 */
  function monoLinePenalty(line) {
    let left = 0;
    let right = 0;
    for (let i = 0; i < 3; i++) {
      const a = line[i] ? Math.log2(line[i]) : 0;
      const b = line[i + 1] ? Math.log2(line[i + 1]) : 0;
      if (a > b) left += Math.pow(a, CONFIG.sumPower) - Math.pow(b, CONFIG.sumPower);
      else right += Math.pow(b, CONFIG.sumPower) - Math.pow(a, CONFIG.sumPower);
    }
    return Math.min(left, right);
  }

  /** 沿蛇身应非增：前格 ≥ 后格；违约按对数差惩罚（强化递减蛇形） */
  function snakePathMonoPenalty(board) {
    let pen = 0;
    for (let i = 0; i < SNAKE_ORDER.length - 1; i++) {
      const [r0, c0] = SNAKE_ORDER[i];
      const [r1, c1] = SNAKE_ORDER[i + 1];
      const a = board[r0][c0];
      const b = board[r1][c1];
      if (!a || !b) continue;
      if (b > a) {
        const da = Math.log2(a);
        const db = Math.log2(b);
        pen += Math.pow(db - da, 2) * (1 + i * 0.08);
      }
    }
    return pen;
  }

  /** 夹心惩罚：同行/列出现 a<b>c（中间更大），且非「即将合并的一对贴边」 */
  function sandwichPenaltyScore(board) {
    let pen = 0;
    const scan = (a, b, c) => {
      if (!a || !b || !c) return;
      if (a < b && c < b && a !== b && c !== b) {
        // 两边同等且等于 b/2 时略轻（可能在造合并），否则重罚
        const soft = a === c && a * 2 === b;
        pen += Math.log2(b) * (soft ? 0.35 : 1.0);
      }
    };
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 2; c++) scan(board[r][c], board[r][c + 1], board[r][c + 2]);
    }
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 2; r++) scan(board[r][c], board[r + 1][c], board[r + 2][c]);
    }
    return pen;
  }

  /** 次大砖应在蛇身第 2 格（贴最大）；否则按距角曼哈顿惩罚 */
  function secondTileSnakeBonus(board, maxV) {
    if (!maxV) return 0;
    let second = 0;
    let sr = -1;
    let sc = -1;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const v = board[r][c];
        if (v && v < maxV && v > second) {
          second = v;
          sr = r;
          sc = c;
        }
      }
    }
    if (!second) return 0;
    const [tr, tc] = SNAKE_ORDER[1];
    if (sr === tr && sc === tc) return CONFIG.secondAlongSnakeWeight * Math.log2(second);
    const dist = Math.abs(sr - tr) + Math.abs(sc - tc);
    return -CONFIG.secondAlongSnakeWeight * 0.45 * Math.log2(second) * dist;
  }

  function countPotentialMerges(board) {
    let merges = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        if (board[r][c] && board[r][c] === board[r][c + 1]) merges++;
      }
    }
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 3; r++) {
        if (board[r][c] && board[r][c] === board[r + 1][c]) merges++;
      }
    }
    return merges;
  }

  function hasAnyMove(board) {
    for (const d of DIRS) if (moveBoard(board, d).changed) return true;
    return false;
  }

  function evaluate(board) {
    const emptyCells = empties(board);
    const empty = emptyCells.length;
    if (empty === 0 && !hasAnyMove(board)) return -CONFIG.lostPenalty * 20;

    let snake = 0;
    let smooth = 0;
    let sumPen = 0;
    const { max, r: maxR, c: maxC } = maxTileAt(board);

    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const v = board[r][c];
        if (!v) continue;
        const rank = Math.log2(v);
        snake += rank * SNAKE[r][c] * CONFIG.snakeScale;
        sumPen += Math.pow(rank, CONFIG.sumPower);
        if (c + 1 < 4 && board[r][c + 1]) {
          smooth -= Math.abs(rank - Math.log2(board[r][c + 1]));
        }
        if (r + 1 < 4 && board[r + 1][c]) {
          smooth -= Math.abs(rank - Math.log2(board[r + 1][c]));
        }
      }
    }

    let mono = 0;
    for (let r = 0; r < 4; r++) mono += monoLinePenalty(board[r]);
    for (let c = 0; c < 4; c++) mono += monoLinePenalty([board[0][c], board[1][c], board[2][c], board[3][c]]);

    const snakeMono = snakePathMonoPenalty(board);
    const sandwich = sandwichPenaltyScore(board);
    const secondBonus = secondTileSnakeBonus(board, max);

    const merges = countPotentialMerges(board);
    let corner = 0;
    if (max) {
      if (maxR === CR && maxC === CC) corner = CONFIG.cornerLockWeight * Math.log2(max);
      else {
        const dist = Math.abs(maxR - CR) + Math.abs(maxC - CC);
        corner = -CONFIG.cornerLockWeight * 0.65 * Math.log2(max) * dist;
      }
      if (board[CR][CC] && board[CR][CC] < max) {
        corner -= CONFIG.cornerLockWeight * 0.35 * Math.log2(max);
      }
    }

    let emptyW = CONFIG.emptyWeight;
    if (max >= (CONFIG.emptyLateMaxTile || 512)) emptyW *= CONFIG.emptyLateBoost || 1.35;
    if (empty <= 3) emptyW *= 1.25;
    const emptyScore = emptyW * Math.pow(empty, CONFIG.emptyPower);

    return (
      emptyScore +
      CONFIG.mergeWeight * merges +
      snake +
      CONFIG.smoothWeight * smooth -
      CONFIG.monoWeight * mono -
      CONFIG.snakeMonoWeight * snakeMono -
      CONFIG.sandwichPenalty * sandwich -
      CONFIG.sumWeight * sumPen +
      corner +
      secondBonus
    );
  }

  let _deadline = 0;
  let _tt = new Map();
  let _nodes = 0;

  /**
   * 真 expectimax：
   *  - isPlayer：对合法方向取 max，无效方向跳过
   *  - !isPlayer：对空位均匀 × (0.9·放2 + 0.1·放4)
   *  - playerDepth 只在玩家层递减；机会层不吞深度
   */
  function expectimax(board, playerDepth, isPlayer, cprob) {
    _nodes++;
    if ((_nodes & 63) === 0 && Date.now() > _deadline) return evaluate(board);
    if (cprob < 0.00012) return evaluate(board);
    if (playerDepth <= 0) return evaluate(board);

    const key = playerDepth + ':' + (isPlayer ? 1 : 0) + ':' + boardHash(board);
    const hit = _tt.get(key);
    if (hit !== undefined) return hit;

    let res;
    if (isPlayer) {
      let best = -Infinity;
      for (const dir of DIRS) {
        const m = moveBoard(board, dir);
        if (!m.changed) continue;
        const s = expectimax(m.board, playerDepth - 1, false, cprob);
        if (s > best) best = s;
      }
      res = best === -Infinity ? evaluate(board) - CONFIG.lostPenalty : best;
    } else {
      const cells = empties(board);
      if (!cells.length) {
        res = expectimax(board, playerDepth, true, cprob);
      } else {
        let sample = cells;
        if (cells.length > CONFIG.chanceSampleMax) {
          sample = [];
          const step = cells.length / CONFIG.chanceSampleMax;
          for (let i = 0; i < CONFIG.chanceSampleMax; i++) {
            sample.push(cells[Math.min(cells.length - 1, Math.floor(i * step))]);
          }
        }
        // 仅深层近似跳过 4；depth≤2 的浅层完整 0.9/0.1
        const skip4 = playerDepth >= CONFIG.chanceSkip4WhenDepthGe;
        let total = 0;
        const n = sample.length;
        const pCell = 1 / n;
        for (const [r, c] of sample) {
          const b2 = cloneBoard(board);
          b2[r][c] = 2;
          if (skip4) {
            total += pCell * expectimax(b2, playerDepth, true, cprob * pCell);
          } else {
            total += pCell * 0.9 * expectimax(b2, playerDepth, true, cprob * pCell * 0.9);
            const b4 = cloneBoard(board);
            b4[r][c] = 4;
            total += pCell * 0.1 * expectimax(b4, playerDepth, true, cprob * pCell * 0.1);
          }
        }
        res = total;
      }
    }
    if (_tt.size < 24000) _tt.set(key, res);
    return res;
  }

  function cornerSafeAfter(board, after) {
    const { max } = maxTileAt(board);
    if (!max) return true;
    return after[CR][CC] >= max;
  }

  function maxDistToCorner(board) {
    const { max, r, c } = maxTileAt(board);
    if (!max) return 0;
    return Math.abs(r - CR) + Math.abs(c - CC);
  }

  function filterCandidates(board, legal) {
    let candidates = legal.slice();
    const empty = empties(board).length;
    const rescue = empty <= CONFIG.rescueEmptyMax;
    const dist = maxDistToCorner(board);
    const maxAway = dist > 0;
    const { max, r: maxR, c: maxC } = maxTileAt(board);

    // 复盘：最大砖已离角时，禁 up 会卡死在底行中部（32-128-32）。
    if (CONFIG.hardCornerLock && candidates.length > 1 && empty <= CONFIG.hardLockEmptyMax && !maxAway) {
      const safe = candidates.filter((x) => cornerSafeAfter(board, x.m.board));
      if (safe.length) candidates = safe;
    }

    if (CONFIG.banUpUnlessRescue && candidates.length > 1 && !maxAway) {
      const up = candidates.find((x) => x.dir === 'up');
      if (up) {
        const ok = cornerSafeAfter(board, up.m.board);
        if (!(rescue && ok)) candidates = candidates.filter((x) => x.dir !== 'up');
      }
    }

    // 解缠：仅当最大砖较大且卡在角行外侧、一步无法沿边滑回时，才抬离（防早期乱 up）
    if (maxAway && max >= 64 && candidates.length > 1) {
      let unstick = null;
      if (CONFIG.preferredCorner === 'bl' || CONFIG.preferredCorner === 'br') {
        if (maxR === 3 && maxC !== CC) {
          const toward = CONFIG.preferredCorner === 'bl' ? 'left' : 'right';
          const slide = candidates.find((x) => x.dir === toward);
          const canSlideCloser = slide && maxDistToCorner(slide.m.board) < dist;
          if (!canSlideCloser) unstick = candidates.find((x) => x.dir === 'up');
        }
      }
      if (unstick) candidates = [unstick];
    }

    // 离角时：优先缩短到角的曼哈顿距离
    if (maxAway && candidates.length > 1) {
      const better = candidates.filter((x) => maxDistToCorner(x.m.board) < dist);
      if (better.length) candidates = better;
    }

    return candidates.length ? candidates : legal;
  }

  function scoreRootMove(m, playerDepthLeft, beforeBoard) {
    let bonus = m.score * 2.0 + m.merges * 140;
    if (beforeBoard) {
      const d0 = maxDistToCorner(beforeBoard);
      const d1 = maxDistToCorner(m.board);
      if (d1 < d0) bonus += CONFIG.cornerLockWeight * 0.15 * (d0 - d1);
      if (d1 === 0 && d0 > 0) bonus += CONFIG.cornerLockWeight * 0.25;
    }
    return expectimax(m.board, playerDepthLeft, false, 1.0) + bonus;
  }

  /** 空位越少搜越深（危机盘）；canvas 空位多时压深度保步速 */
  function depthBudget(emptyCount, isCanvas) {
    let dMin = isCanvas ? CONFIG.canvasDepthMin : CONFIG.depthMin;
    let dMax = isCanvas ? CONFIG.canvasDepthMax : CONFIG.depthMax;
    dMin = Math.max(2, dMin);
    if (isCanvas) {
      if (emptyCount >= 8) dMax = Math.min(dMax, 2);
      else if (emptyCount >= CONFIG.canvasCrisisEmpty) dMax = Math.min(dMax, 2);
      else dMax = Math.min(Math.max(dMax, 3), CONFIG.canvasDepthMax);
    } else {
      if (emptyCount >= 8) dMax = Math.min(dMax, dMin);
      else if (emptyCount >= 5) dMax = Math.min(dMax, Math.max(dMin, 3));
      else if (emptyCount <= 2) dMax = Math.max(dMax, Math.min(CONFIG.depthMax, 4));
    }
    return { dMin, dMax };
  }

  function thinkBudgetMs(emptyCount, isCanvas) {
    if (!isCanvas) return CONFIG.thinkTimeMs;
    let ms = CONFIG.canvasThinkTimeMs || 28;
    if (emptyCount <= CONFIG.canvasCrisisEmpty) ms = CONFIG.canvasThinkCrisisMs || 120;
    else if (emptyCount >= 8) ms = Math.min(ms, 22);
    // 大砖阶段再多想一会，换结构胜率
    try {
      const g = typeof window !== 'undefined' && window.canvasGame;
      const flat = g && g.board ? g.board.flat() : null;
      const mx = flat ? Math.max(0, ...flat) : 0;
      if (mx >= 1024 && emptyCount <= 6) ms = Math.max(ms, (CONFIG.canvasThinkCrisisMs || 120) + 20);
    } catch (_) {}
    return ms;
  }

  function pickMove(board, mode) {
    const isCanvas = mode === 'canvas' || mode === 'fast';
    const legal = [];
    for (const dir of DIRS) {
      const m = moveBoard(board, dir);
      if (m.changed) legal.push({ dir, m });
    }
    if (!legal.length) return null;

    const candidates = filterCandidates(board, legal);
    const emptyN = empties(board).length;
    const { dMin, dMax } = depthBudget(emptyN, isCanvas);

    _deadline = Date.now() + thinkBudgetMs(emptyN, isCanvas);
    _tt = new Map();
    _nodes = 0;

    let bestDir = candidates[0].dir;
    let bestScore = -Infinity;
    let reached = 0;

    for (let depth = dMin; depth <= dMax; depth++) {
      if (Date.now() > _deadline && depth > dMin) break;
      let localBest = candidates[0].dir;
      let localScore = -Infinity;
      let timedOut = false;
      for (const { dir, m } of candidates) {
        if (Date.now() > _deadline && depth > dMin) {
          timedOut = true;
          break;
        }
        _tt = new Map();
        // depth = 玩家层数；根已走一步，剩余 depth-1 再进机会层
        const s =
          scoreRootMove(m, Math.max(1, depth - 1), board) +
          (DIRS.length - DIRS.indexOf(dir)) * 0.001;
        if (s > localScore) {
          localScore = s;
          localBest = dir;
        }
      }
      if (!timedOut || depth === dMin) {
        bestDir = localBest;
        bestScore = localScore;
        reached = depth;
      }
      if (Date.now() > _deadline) break;
    }
    void bestScore;
    void reached;
    return bestDir;
  }

  /* ============================================================
   * 适配层
   * ============================================================ */
  function getAdapter() {
    if (window.canvasGame && typeof window.canvasGame.handleMove === 'function') {
      return {
        name: 'canvasGame',
        ready() {
          const g = window.canvasGame;
          if (!g) return false;
          const sock = g.ws || window.gameWS;
          if (!sock) return false;
          if (typeof sock.readyState === 'number' && sock.readyState !== 1) return false;
          if (sock.connectionStatus && sock.connectionStatus !== 'connected') return false;
          return true;
        },
        getBoard() {
          const b = window.canvasGame && window.canvasGame.board;
          if (!b || !b.length) return null;
          const out = [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ];
          const tr = !!CONFIG.canvasBoardTransposed;
          for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
              const v = (b[i] && b[i][j]) || 0;
              if (tr) out[j][i] = v;
              else out[i][j] = v;
            }
          }
          return out;
        },
        getScore() {
          return (window.canvasGame && window.canvasGame.score) || 0;
        },
        isOver() {
          return !!(window.canvasGame && window.canvasGame.gameOver);
        },
        isWon() {
          return !!(window.canvasGame && window.canvasGame.victory);
        },
        isAnimating() {
          const g = window.canvasGame;
          if (!g) return false;
          if (g.isAnimating) return true;
          if (g.moveAnimations && g.moveAnimations.length) return true;
          if (g.mergeAnimations && g.mergeAnimations.length) return true;
          if (g.newTileAnimations && g.newTileAnimations.length) return true;
          if (g.animations && g.animations.length) return true;
          return false;
        },
        move(dir) {
          window.canvasGame.handleMove(dir);
        },
        newGame() {
          if (typeof window.canvasGame.newGame === 'function') window.canvasGame.newGame();
        },
        keepGoing() {
          const btn = document.querySelector(
            '.keep-playing-button, [data-action="keep"], button.keep-going, .continue-btn'
          );
          if (btn) btn.click();
        },
      };
    }

    if (window.gameManager && typeof window.gameManager.move === 'function') {
      return {
        name: 'gameManager',
        ready() {
          return !!window.gameManager;
        },
        getBoard() {
          const g = window.gameManager.grid;
          if (!g || !g.cells) return null;
          const out = [
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
          ];
          for (let x = 0; x < 4; x++) {
            for (let y = 0; y < 4; y++) {
              const t = g.cells[x][y];
              if (t) out[y][x] = t.value;
            }
          }
          return out;
        },
        getScore() {
          return window.gameManager.score || 0;
        },
        isOver() {
          return !!window.gameManager.over;
        },
        isWon() {
          return !!window.gameManager.won && !window.gameManager.keepPlaying;
        },
        isAnimating() {
          return false;
        },
        move(dir) {
          window.gameManager.move(DIR_TO_STD[dir]);
        },
        newGame() {
          if (typeof window.gameManager.restart === 'function') window.gameManager.restart();
          else {
            const b = document.querySelector('.restart-button, .retry-button');
            if (b) b.click();
          }
        },
        keepGoing() {
          if (window.gameManager) window.gameManager.keepPlaying = true;
          const b = document.querySelector('.keep-playing-button');
          if (b) b.click();
        },
      };
    }

    return {
      name: 'keyboard',
      ready() {
        return !!document.querySelector('.grid-container, .game-container, canvas');
      },
      getBoard() {
        const tiles = document.querySelectorAll('.tile');
        if (!tiles.length) return null;
        const out = [
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ];
        tiles.forEach((el) => {
          const m = el.className.match(/tile-position-(\d)-(\d)/);
          const vm = el.className.match(/tile-(\d+)/);
          if (!m || !vm) return;
          const col = parseInt(m[1], 10) - 1;
          const row = parseInt(m[2], 10) - 1;
          const val = parseInt(vm[1], 10);
          if (row >= 0 && row < 4 && col >= 0 && col < 4 && val) {
            out[row][col] = Math.max(out[row][col], val);
          }
        });
        return out;
      },
      getScore() {
        const el = document.querySelector('.score-container') || document.querySelector('.score');
        if (!el) return 0;
        const n = parseInt(el.textContent.replace(/[^\d]/g, ''), 10);
        return isFinite(n) ? n : 0;
      },
      isOver() {
        return !!document.querySelector('.game-over, .game-message.game-over');
      },
      isWon() {
        return !!document.querySelector('.game-won, .game-message.game-won');
      },
      isAnimating() {
        return !!document.querySelector('.tile-merged, .tile-new');
      },
      move(dir) {
        const keyMap = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
        const codeMap = { up: 38, down: 40, left: 37, right: 39 };
        const ev = new KeyboardEvent('keydown', {
          key: keyMap[dir],
          code: keyMap[dir],
          keyCode: codeMap[dir],
          which: codeMap[dir],
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(ev);
        window.dispatchEvent(ev);
      },
      newGame() {
        const b = document.querySelector('.restart-button, .retry-button, #new-game');
        if (b) b.click();
      },
      keepGoing() {
        const b = document.querySelector('.keep-playing-button');
        if (b) b.click();
      },
    };
  }

  const state = {
    running: false,
    games: 0,
    steps: 0,
    bestScore: 0,
    bestMax: 0,
    adapterName: '',
    lastDir: '-',
    version: VERSION,
    timer: null,
    history: [],
    gameStartedAt: 0,
    peakMaxThisGame: 0,
    lastLesson: '',
  };

  function summarizeGame(board, score, steps) {
    const mx = board ? maxTile(board) : 0;
    const empty = board ? empties(board).length : 0;
    const { max, r, c } = board ? maxTileAt(board) : { max: 0, r: 0, c: 0 };
    const inCorner = max && r === CR && c === CC;
    const notes = [];
    if (mx < 256) notes.push('早期崩盘');
    else if (mx < 512) notes.push('卡在256级');
    else if (mx < 1024) notes.push('卡在512级');
    else if (mx < 2048) notes.push('卡在1024级');
    else if (mx < 4096) notes.push('卡在2048级');
    else if (mx < 8192) notes.push('卡在4096级');
    else notes.push('达到8192+');
    if (!inCorner && mx >= 128) notes.push('终局最大砖不在锁定角');
    if (empty <= 1) notes.push('空位耗尽');
    const c8192 = board ? board.flat().filter((v) => v === 8192).length : 0;
    if (c8192 >= 2) notes.push('双8192达成');
    const lesson =
      mx < 512
        ? '提高 empty/corner 权，禁非救援 up，加快步速多采样'
        : mx < 2048
          ? '中盘维持蛇形，空位≤4 加深 expectimax'
          : mx < 8192
            ? '后期硬角锁 + crisis think；避免打散底行'
            : c8192 < 2
              ? '已有8192：保角、第二大砖沿蛇身推进，勿乱 up'
              : '冲击 All Time：双8192 后继续压分（榜一≈27.6万）';
    return {
      at: new Date().toISOString(),
      score,
      max: mx,
      peakMax: Math.max(state.peakMaxThisGame, mx),
      steps,
      empty,
      inCorner: !!inCorner,
      cornerTile: board ? board[CR][CC] || 0 : 0,
      c8192,
      notes,
      lesson,
      durationMs: state.gameStartedAt ? Date.now() - state.gameStartedAt : 0,
    };
  }

  function pushHistory(rec) {
    state.history.push(rec);
    state.lastLesson = (rec.notes || []).join('; ') + ' | ' + rec.lesson;
    while (state.history.length > (CONFIG.historyLimit || 30)) state.history.shift();
    try {
      console.info('[2048-Auto][复盘]', rec.score, rec.max, rec.notes.join(','), rec.lesson);
    } catch (_) {}
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitUntilSettled(adapter, prevBoard) {
    const t0 = Date.now();
    while (Date.now() - t0 < CONFIG.animWaitTimeoutMs) {
      if (!adapter.isAnimating || !adapter.isAnimating()) break;
      await sleep(16);
    }
    if (prevBoard) {
      while (Date.now() - t0 < CONFIG.animWaitTimeoutMs) {
        const cur = adapter.getBoard();
        if (cur && !boardsEqual(cur, prevBoard)) break;
        if (adapter.isOver && adapter.isOver()) break;
        await sleep(16);
      }
    }
    let last = null;
    let stable = 0;
    while (Date.now() - t0 < CONFIG.animWaitTimeoutMs + 240) {
      const cur = adapter.getBoard();
      const h = cur ? boardHash(cur) : 0;
      if (h && h === last) stable += 1;
      else {
        last = h;
        stable = 0;
      }
      if (stable >= CONFIG.boardStableFrames) break;
      await sleep(16);
    }
    if (CONFIG.postMoveSettleMs) await sleep(CONFIG.postMoveSettleMs);
  }

  async function waitReadyToMove(adapter) {
    const t0 = Date.now();
    const limit = Math.min(CONFIG.animWaitTimeoutMs, 500);
    while (Date.now() - t0 < limit) {
      if (!adapter.isAnimating || !adapter.isAnimating()) {
        // 再确认盘哈希稳定一帧，避免动画刚清但砖未落地
        const b1 = adapter.getBoard();
        await sleep(16);
        const b2 = adapter.getBoard();
        if (b1 && b2 && boardsEqual(b1, b2)) return true;
        if (!adapter.isAnimating || !adapter.isAnimating()) return true;
      }
      await sleep(16);
    }
    return false;
  }

  async function waitForFreshGame(adapter) {
    const limit = CONFIG.newGameWaitMs || 2500;
    const t0 = Date.now();
    while (Date.now() - t0 < limit) {
      await sleep(50);
      const b = adapter.getBoard && adapter.getBoard();
      if (!b) continue;
      let tiles = 0;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (b[r][c]) tiles++;
      const score = adapter.getScore ? adapter.getScore() : 0;
      const over = adapter.isOver && adapter.isOver();
      if (!over && score === 0 && tiles > 0 && tiles <= 2) {
        await waitUntilSettled(adapter, null);
        return true;
      }
    }
    await waitUntilSettled(adapter, null);
    return false;
  }

  async function restartGame(adapter) {
    try {
      adapter.newGame();
    } catch (_) {}
    await waitForFreshGame(adapter);
  }

  function ensureUI() {
    if (document.getElementById('auto2048-panel')) {
      const ver = document.getElementById('auto2048-ver');
      if (ver) ver.textContent = 'v' + VERSION;
      const hint = document.querySelector('#auto2048-panel .hint');
      if (hint) hint.textContent = `v${VERSION} 蛇形递减 · 反夹心 · 危机深搜 · 合法走子`;
      return;
    }
    const css = document.createElement('style');
    css.textContent = `
      #auto2048-panel{
        position:fixed; z-index:2147483646; right:12px; top:12px;
        width:240px; padding:10px 12px; border-radius:10px;
        background:rgba(20,24,32,.92); color:#e8eef7; font:12px/1.4 system-ui,sans-serif;
        box-shadow:0 8px 28px rgba(0,0,0,.35); user-select:none;
      }
      #auto2048-panel h3{margin:0 0 8px;font-size:13px;font-weight:700;color:#7dd3fc}
      #auto2048-panel .row{display:flex;justify-content:space-between;margin:3px 0;opacity:.95}
      #auto2048-panel .btns{display:flex;gap:6px;margin-top:8px}
      #auto2048-panel button{
        flex:1;border:0;border-radius:6px;padding:6px 0;cursor:pointer;
        background:#2563eb;color:#fff;font-weight:600
      }
      #auto2048-panel button.stop{background:#64748b}
      #auto2048-panel button:hover{filter:brightness(1.08)}
      #auto2048-panel .hint{margin-top:8px;opacity:.65;font-size:11px}
    `;
    document.documentElement.appendChild(css);
    const panel = document.createElement('div');
    panel.id = 'auto2048-panel';
    panel.innerHTML = `
      <h3>2048 自动走子 <span id="auto2048-ver">v${VERSION}</span></h3>
      <div class="row"><span>适配</span><span id="auto2048-adapter">-</span></div>
      <div class="row"><span>状态</span><span id="auto2048-status">暂停</span></div>
      <div class="row"><span>分数</span><span id="auto2048-score">0</span></div>
      <div class="row"><span>最大砖</span><span id="auto2048-max">0</span></div>
      <div class="row"><span>本局步数</span><span id="auto2048-steps">0</span></div>
      <div class="row"><span>局数</span><span id="auto2048-games">0</span></div>
      <div class="row"><span>历史最佳分</span><span id="auto2048-best">0</span></div>
      <div class="row"><span>历史最大砖</span><span id="auto2048-bestmax">0</span></div>
      <div class="row"><span>上一步</span><span id="auto2048-dir">-</span></div>
      <div class="row"><span>上局教训</span><span id="auto2048-lesson" style="max-width:130px;text-align:right;opacity:.85">-</span></div>
      <div class="btns">
        <button id="auto2048-start" type="button">开始</button>
        <button id="auto2048-stop" class="stop" type="button">暂停</button>
      </div>
      <div class="hint">v${VERSION} 蛇形递减 · 反夹心 · 危机深搜 · 合法走子</div>
    `;
    document.documentElement.appendChild(panel);
    document.getElementById('auto2048-start').addEventListener('click', () => startAuto());
    document.getElementById('auto2048-stop').addEventListener('click', () => stopAuto());
  }

  function refreshUI(adapter, board) {
    const max = board ? maxTile(board) : 0;
    const score = adapter ? adapter.getScore() : 0;
    if (score > state.bestScore) state.bestScore = score;
    if (max > state.bestMax) state.bestMax = max;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(v);
    };
    set('auto2048-adapter', state.adapterName || (adapter && adapter.name) || '-');
    set('auto2048-status', state.running ? '运行中' : '暂停');
    set('auto2048-score', score);
    set('auto2048-max', max);
    set('auto2048-steps', state.steps);
    set('auto2048-games', state.games);
    set('auto2048-best', state.bestScore);
    set('auto2048-bestmax', state.bestMax);
    set('auto2048-dir', state.lastDir);
    set('auto2048-lesson', (state.lastLesson || '-').slice(0, 42));
  }

  function stopAuto() {
    state.running = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const el = document.getElementById('auto2048-status');
    if (el) el.textContent = '暂停';
  }

  async function startAuto() {
    if (state.running) return;
    state.running = true;
    state.gameStartedAt = Date.now();
    state.peakMaxThisGame = 0;
    ensureUI();

    while (state.running) {
      const adapter = getAdapter();
      state.adapterName = adapter.name;
      // canvas 不永久覆盖本地 think；逐步由 thinkBudgetMs / depthBudget 自适应

      if (!adapter.ready() || !adapter.getBoard()) {
        refreshUI(adapter, null);
        await sleep(120);
        continue;
      }

      await waitUntilSettled(adapter, null);
      let board = adapter.getBoard();
      refreshUI(adapter, board);
      if (!board) {
        await sleep(120);
        continue;
      }

      const mxNow = maxTile(board);
      if (mxNow > state.peakMaxThisGame) state.peakMaxThisGame = mxNow;

      if (adapter.isWon() && CONFIG.keepGoing) {
        try {
          adapter.keepGoing();
        } catch (_) {}
        await sleep(200);
      }

      const mx = maxTile(board);
      if (CONFIG.targetMaxTile > 0 && mx >= CONFIG.targetMaxTile && !CONFIG.keepGoing) {
        stopAuto();
        break;
      }

      if (adapter.isOver()) {
        const sc = adapter.getScore();
        if (sc > state.bestScore) state.bestScore = sc;
        if (mx > state.bestMax) state.bestMax = mx;
        pushHistory(summarizeGame(board, sc, state.steps));
        if (CONFIG.autoRestart) {
          await sleep(CONFIG.restartDelayMs);
          await restartGame(adapter);
          state.games += 1;
          state.steps = 0;
          state.gameStartedAt = Date.now();
          state.peakMaxThisGame = 0;
          continue;
        }
        stopAuto();
        break;
      }

      const dir = pickMove(board, adapter.name === 'canvasGame' ? 'canvas' : 'deep');
      if (!dir) {
        pushHistory(summarizeGame(board, adapter.getScore(), state.steps));
        if (CONFIG.autoRestart) {
          await sleep(CONFIG.restartDelayMs);
          await restartGame(adapter);
          state.games += 1;
          state.steps = 0;
          state.gameStartedAt = Date.now();
          state.peakMaxThisGame = 0;
          continue;
        }
        stopAuto();
        break;
      }

      state.lastDir = dir;
      const before = cloneBoard(board);
      let applied = false;
      for (let attempt = 0; attempt <= CONFIG.staleMoveMaxRetries; attempt++) {
        await waitReadyToMove(adapter);
        try {
          adapter.move(dir);
        } catch (e) {
          console.warn('[2048-Auto] move failed', e);
        }
        await waitUntilSettled(adapter, before);
        board = adapter.getBoard();
        if (board && !boardsEqual(board, before)) {
          applied = true;
          break;
        }
        await sleep(Math.min(CONFIG.staleMoveRetryMs, 120));
      }
      if (applied) state.steps += 1;
      else {
        await sleep(adapter.name === 'canvasGame' ? CONFIG.canvasWsSettleMs || 40 : 50);
      }
      if (adapter.name === 'canvasGame') await sleep(CONFIG.canvasWsSettleMs || 40);
      else if (CONFIG.moveDelayMs) await sleep(CONFIG.moveDelayMs);
      refreshUI(adapter, adapter.getBoard());
    }
  }

  function boot() {
    if (_booted) return;
    if (CONFIG.requireGameDetect && !pageLooksLike2048()) return;
    _booted = true;
    ensureUI();
    const adapter = getAdapter();
    state.adapterName = adapter.name;
    refreshUI(adapter, adapter.getBoard && adapter.getBoard());
    if (CONFIG.autoStart) startAuto();
  }

  function scheduleBoot() {
    boot();
    if (_booted) return;
    let n = 0;
    const t = setInterval(() => {
      n++;
      boot();
      if (_booted || n > 40) clearInterval(t);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(scheduleBoot, 300));
  } else {
    setTimeout(scheduleBoot, 300);
  }

  window.__AUTO2048 = {
    CONFIG,
    VERSION,
    start: startAI,
    stop: stopAI,
    state,
    pickMove,
    evaluate,
    expectimax,
    moveBoard,
  };
})();
