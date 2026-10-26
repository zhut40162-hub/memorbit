(() => {
  'use strict';

  const MAX_PACKET_BYTES = 2 * 1024 * 1024;
  // The historical 3.3.1 organizer can issue up to nine summary judgments
  // plus twelve core memories. Keep the hardened mobile return flow while
  // accepting that older packet shape without silently dropping entries.
  const MAX_TARGETS = 24;
  const MAX_TEXT_LENGTH = 5000;
  const MAX_SUPPLEMENT_LENGTH = 2000;
  const CONTEXT_DIMENSIONS = new Set(['importance', 'participants', 'stage', 'scope', 'basis']);
  const CONTEXT_LABELS = { importance: '保留重点', participants: '人物与对象', stage: '阶段与场景', scope: '适用范围', basis: '经历与期待' };
  const SUPPLEMENT_LABELS = {
    relationship: '关系定位与变化',
    attitude: '伴侣对我的表达态度',
    tone: 'AI 伴侣的语气与交流习惯',
    memory: '遗漏的重要经历'
  };
  const DRAFT_KEY_PREFIX = 'memorbit-participant-review-draft-v1:';
  const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const VERDICTS = new Set(['accurate', 'needs_change', 'uncertain']);
  const BLOCKED_TOP_LEVEL_KEYS = new Set([
    'rawChat', 'rawText', 'sourceSnapshot', 'screenshots', 'images', 'messages',
    'conversation', 'material', 'files', 'attachments'
  ]);
  const REVIEW_SECTIONS = {
    relationship: ['先看关系核心', '只判断 AI 对你们目前关系的理解是否准确。'],
    interaction: ['再看相处方式', '重点看安慰方式、交流习惯和相处感受有没有说反。'],
    companion: ['关于 AI 伴侣', '确认身份、人设和稳定特点，不用纠结偶发玩笑。'],
    boundaries: ['偏好、边界与约定', '这一类会影响以后怎样回应，拿不准时请选择“不确定”。'],
    events: ['重要记忆文件夹', '只展示最值得带走的事件；同一件事的多条记忆已收在一起。']
  };

  const $ = id => document.getElementById(id);
  const state = { packet: null, targets: [], fileHashSha256: '', response: null };
  const isContextual = () => state.packet?.reviewMode === 'contextual';
  const responseSchema = () => `memorbit-participant-review-response/${isContextual() ? '2' : '1'}`;

  function cleanText(value, limit = MAX_TEXT_LENGTH) {
    return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
  }

  function cleanId(value, label = '编号') {
    const normalized = String(value ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(normalized)) throw new Error(`${label}格式无效。`);
    return normalized;
  }

  function setStatus(node, message, tone = '') {
    node.textContent = message;
    node.classList.remove('error', 'ok');
    if (tone) node.classList.add(tone);
  }

  function normalizeClarificationHints(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 6 || value.some(item => typeof item !== 'string' || item.length > 500)) throw new Error('补充提示格式无效：最多 6 个问题，每个最多 500 字。');
    return value.map(item => cleanText(item, 500)).filter(Boolean);
  }

  function normalizeContextQuestions(value, itemIds) {
    if (!Array.isArray(value) || !value.length || value.length > 5) throw new Error('背景核对需要 1–5 个问题。');
    const contextId = value => {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new Error('背景问题或选项编号格式无效。');
      return value;
    };
    const seen = new Set();
    const text = (value, limit, required = true) => {
      if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) throw new Error('背景问题文字格式或长度无效。');
      return cleanText(value, limit);
    };
    return value.map(question => {
      const fields = ['id', 'dimension', 'prompt', 'groupLabel', 'memberIds', 'options', 'allowDetail'];
      if (!question || typeof question !== 'object' || Array.isArray(question) || Object.keys(question).some(key => !fields.includes(key))) throw new Error('背景问题包含无效字段。');
      const id = contextId(question.id);
      if (seen.has(id) || !CONTEXT_DIMENSIONS.has(question.dimension) || question.allowDetail !== true) throw new Error('背景问题编号、类别或补充设置无效。');
      seen.add(id);
      if (!Array.isArray(question.memberIds) || !question.memberIds.length || question.memberIds.length > 12) throw new Error('背景问题缺少有效关联记忆。');
      const memberIds = question.memberIds.map(contextId);
      if (new Set(memberIds).size !== memberIds.length || memberIds.some(value => !itemIds.has(value))) throw new Error('背景问题引用了重复或未知记忆。');
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 16) throw new Error('背景问题选项数量无效。');
      const optionIds = new Set();
      const options = question.options.map(option => {
        if (!option || typeof option !== 'object' || Array.isArray(option) || Object.keys(option).some(key => !['id', 'label'].includes(key))) throw new Error('背景问题选项格式无效。');
        const optionId = contextId(option.id);
        if (optionIds.has(optionId)) throw new Error('背景问题存在重复选项。');
        optionIds.add(optionId);
        return { id: optionId, label: text(option.label, 200) };
      });
      if (!optionIds.has('unknown') || !optionIds.has('other')) throw new Error('背景问题必须允许“不确定”和“都不符合”。');
      return { id, dimension: question.dimension, prompt: text(question.prompt, 500), groupLabel: text(question.groupLabel, 200, false), memberIds, options, allowDetail: true };
    });
  }

  function validatePacket(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('核对包必须是 JSON 对象。');
    const blockedKey = Object.keys(input).find(key => BLOCKED_TOP_LEVEL_KEYS.has(key));
    if (blockedKey) throw new Error(`检测到不应进入核对包的原始材料字段：${blockedKey}。请让研究方重新生成脱敏文件。`);

    const contextual = input.schemaVersion === 'memorbit-participant-review/2';
    if (!contextual && input.schemaVersion !== 'memorbit-participant-review/1') throw new Error('核对包版本不受支持。');
    if (contextual ? input.reviewMode !== 'contextual' || input.reviewScope !== 'supplemental' : input.reviewMode !== undefined || input.contextQuestions !== undefined) throw new Error('核对模式与版本不匹配，请重新生成核对包。');
    if (input.reviewScope !== undefined && !['normal', 'supplemental'].includes(input.reviewScope)) throw new Error('核对包范围无效。');
    const reviewId = cleanId(input.reviewId, '核对编号');
    const summaries = Array.isArray(input.summary) ? input.summary : [];
    const items = Array.isArray(input.items) ? input.items : [];
    if (!summaries.length && !items.length && input.reviewScope !== 'supplemental') throw new Error('核对包没有可核对的 summary 或 items。');
    if (summaries.length + items.length > MAX_TARGETS) throw new Error(`核对项超过 ${MAX_TARGETS} 条上限。`);
    if (input.reviewScope === 'supplemental' && (items.length > 12 || summaries.length > 2)) throw new Error('补充核对每轮最多 12 条候选和 2 条关系或相处判断。');

    const targets = [
      ...summaries.map((entry, index) => normalizeTarget(entry, 'summary', index)),
      ...items.map((entry, index) => normalizeTarget(entry, 'item', index))
    ];
    const seen = new Set();
    for (const target of targets) {
      if (seen.has(target.id)) throw new Error(`核对项 ID 重复：${target.id}`);
      seen.add(target.id);
    }
    return {
      packet: {
        schemaVersion: cleanText(input.schemaVersion, 80) || 'memorbit-participant-review/1',
        reviewId,
        ...(input.reviewScope !== undefined ? { reviewScope: input.reviewScope } : {}),
        ...(contextual ? { reviewMode: 'contextual', contextQuestions: normalizeContextQuestions(input.contextQuestions, new Set(targets.filter(target => target.kind === 'item').map(target => target.id))) } : {}),
        packetVersion: cleanText(input.packetVersion, 80) || '1',
        packetHash: cleanText(input.packetHash, 160),
        participantAlias: cleanText(input.participantAlias, 100) || '未提供',
        consentVersion: cleanText(input.consentVersion, 80) || 'local-review-v1',
        consentText: cleanText(input.consentText, 2000),
        expiresAt: cleanText(input.expiresAt, 80),
        ...(input.clarificationHints !== undefined ? { clarificationHints: normalizeClarificationHints(input.clarificationHints) } : {}),
        suggestedGaps: Array.isArray(input.suggestedGaps)
          ? input.suggestedGaps.map(value => cleanText(value, 180)).filter(Boolean).slice(0, 2)
          : []
      },
      targets
    };
  }

  function normalizeTarget(entry, kind, index) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`第 ${index + 1} 个 ${kind} 核对项格式无效。`);
    const id = cleanId(entry.id, `第 ${index + 1} 个核对项编号`);
    if (entry.confirmationStatus !== undefined && entry.confirmationStatus !== 'pending') throw new Error(`核对项 ${id} 的确认状态无效。`);
    if (entry.eventGroup !== undefined && (kind !== 'item' || typeof entry.eventGroup !== 'string' || entry.eventGroup.length > 160)) throw new Error(`核对项 ${id} 的事件分组无效。`);
    const fullText = String(entry.text ?? '').replace(/\u0000/g, '').trim();
    if (fullText.length > MAX_TEXT_LENGTH) throw new Error(`核对项 ${id} 超过 ${MAX_TEXT_LENGTH} 字上限。`);
    const text = cleanText(fullText);
    if (!text) throw new Error(`核对项 ${id} 缺少 text。`);
    return {
      id,
      kind,
      ...(entry.confirmationStatus === 'pending' ? { confirmationStatus: 'pending' } : {}),
      ...(entry.eventGroup ? { eventGroup: cleanText(entry.eventGroup, 160) } : {}),
      label: cleanText(entry.label || entry.type, 120) || (kind === 'summary' ? '整体判断' : '整理条目'),
      text,
      evidenceSnippet: cleanText(entry.evidenceSnippet, 1000),
      section: REVIEW_SECTIONS[entry.section] ? entry.section : (kind === 'summary' ? 'relationship' : 'events'),
      memberCount: Math.max(1, Math.min(99, Number(entry.memberCount) || 1))
    };
  }

  async function sha256Hex(buffer) {
    if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全摘要，请改用最新版 Edge、Chrome 或 Safari 打开。');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function renderTarget(target, index) {
    const pending = target.confirmationStatus === 'pending';
    const article = document.createElement('article');
    article.className = 'review-card';
    article.dataset.targetId = target.id;

    const kicker = document.createElement('div');
    kicker.className = 'item-kicker';
    kicker.textContent = `${pending ? (target.kind === 'summary' ? '待核实判断' : '候选记忆') : target.kind === 'summary' ? '核心内容' : (target.memberCount > 1 ? `事件文件夹 · ${target.memberCount} 条` : '重要记忆')} · ${target.label}`;
    const text = document.createElement('p');
    text.className = 'item-text';
    text.textContent = target.text;
    article.append(kicker, text);

    if (pending) {
      article.classList.add('pending-card');
      const notice = document.createElement('p');
      notice.className = 'pending-notice';
      notice.textContent = '这是待本人核实的内容，尚不是已核实事实。确认属实或填写修订后才会纳入；暂不确定的内容会保留待核对，不会伪装成已确认事实导出。';
      article.insertBefore(notice, text);
    }

    if (target.evidenceSnippet && !isContextual()) {
      const evidence = document.createElement('blockquote');
      evidence.className = 'evidence';
      evidence.textContent = `核对片段：${target.evidenceSnippet}`;
      article.append(evidence);
    }

    const choices = document.createElement('fieldset');
    choices.className = 'choices';
    const legend = document.createElement('legend');
    legend.textContent = `判断第 ${index + 1} 项`;
    choices.append(legend);
    (pending ? [
      ['accurate', '确认属实并纳入'],
      ['needs_change', '修改后纳入'],
      ['uncertain', '暂不确定，保留待核对']
    ] : [
      ['accurate', '准确'],
      ['needs_change', '需改'],
      ['uncertain', '不确定']
    ]).forEach(([value, labelText]) => {
      const label = document.createElement('label');
      label.className = 'choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = `verdict-${index}`;
      input.value = value;
      input.dataset.verdict = target.id;
      const span = document.createElement('span');
      span.textContent = labelText;
      label.append(input, span);
      choices.append(label);
    });
    article.append(choices);

    const importanceLabel = document.createElement('label');
    importanceLabel.className = 'importance-check';
    const importance = document.createElement('input');
    importance.type = 'checkbox';
    importance.disabled = isContextual();
    importance.dataset.important = target.id;
    const importanceText = document.createElement('span');
    importanceText.textContent = '这项对我很重要（可选）';
    importanceLabel.append(importance, importanceText);
    article.append(importanceLabel);

    const correctionLabel = document.createElement('label');
    correctionLabel.className = 'detail-field';
    correctionLabel.hidden = true;
    correctionLabel.dataset.correctionField = target.id;
    const correctionTitle = document.createElement('span');
    const replacesList = target.kind === 'summary' && /^\s*•/m.test(target.text);
    const replacesFolder = target.kind === 'item' && target.memberCount > 1;
    correctionTitle.textContent = pending
      ? '本人认可、同意纳入档案的准确内容（“修改后纳入”时必填）'
      : replacesList
      ? '这一栏最终要保留的全部正确内容（“需改”时必填，每行一条）'
      : replacesFolder
        ? '这个事件文件夹的准确版本（“需改”时必填）'
        : '准确事实（“需改”时必填）';
    correctionTitle.className = 'required-mark';
    const correction = document.createElement('textarea');
    correction.rows = 3;
    correction.maxLength = 2000;
    correction.dataset.correction = target.id;
    correction.placeholder = replacesList
      ? '请把修改后仍要保留的内容全部写完整，每行一条；未写的旧内容会从这一栏移除。'
      : replacesFolder
        ? '请概括这个事件的准确版本；旧文件夹内容会停用并保留这条用户修订。'
        : '只写准确事实，不必重复上方标题，也不要粘贴整段原聊天。';
    correctionLabel.append(correctionTitle, correction);

    const noteLabel = document.createElement('label');
    noteLabel.className = 'detail-field';
    noteLabel.hidden = true;
    noteLabel.dataset.noteField = target.id;
    const noteTitle = document.createElement('span');
    noteTitle.textContent = '补充说明（可选）';
    const note = document.createElement('textarea');
    note.rows = 2;
    note.maxLength = 1000;
    note.dataset.note = target.id;
    note.placeholder = '可说明为什么这样判断，避免填写无关敏感信息。';
    noteLabel.append(noteTitle, note);
    const noteToggle = document.createElement('button');
    noteToggle.type = 'button';
    noteToggle.disabled = isContextual();
    noteToggle.className = 'detail-toggle';
    noteToggle.dataset.noteToggle = target.id;
    noteToggle.textContent = '＋ 补充一句（可选）';
    article.append(correctionLabel, noteToggle, noteLabel);
    if (state.packet.reviewScope === 'supplemental') {
      const details = document.createElement('details');
      details.className = 'answer-details';
      details.dataset.answerDetails = target.id;
      details.open = true;
      const summary = document.createElement('summary');
      summary.className = 'answer-summary';
      summary.dataset.answerSummary = target.id;
      const body = document.createElement('div');
      body.className = 'answer-body';
      body.append(...article.childNodes);
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'button secondary compact';
      next.dataset.nextUnanswered = target.id;
      next.textContent = '收起已完成项，继续核对';
      body.append(next);
      details.append(summary, body);
      article.append(details);
    }
    return article;
  }

  function answerIsComplete(answer) {
    return VERDICTS.has(answer?.verdict) && (answer.verdict !== 'needs_change' || Boolean(answer.correction));
  }

  function renderContextQuestions() {
    $('contextPanel').hidden = !isContextual();
    $('contextQuestions').replaceChildren();
    if (!isContextual()) return;
    const memories = new Map(state.targets.filter(target => target.kind === 'item').map(target => [target.id, target]));
    state.packet.contextQuestions.forEach((question, index) => {
      const card = document.createElement('article');
      card.className = 'context-card';
      const kicker = document.createElement('p');
      kicker.className = 'item-kicker';
      kicker.textContent = `${index + 1} · ${CONTEXT_LABELS[question.dimension]}${question.groupLabel ? ` · ${question.groupLabel}` : ''}`;
      const choices = document.createElement('fieldset');
      choices.className = 'context-choices';
      const legend = document.createElement('legend');
      legend.textContent = question.prompt;
      choices.append(legend);
      question.options.forEach(option => {
        const label = document.createElement('label');
        label.className = 'choice';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `context-${question.id}`;
        input.value = option.id;
        input.dataset.contextQuestion = question.id;
        const span = document.createElement('span');
        span.textContent = option.label;
        label.append(input, span);
        choices.append(label);
      });
      const references = document.createElement('details');
      references.className = 'context-references';
      const preview = document.createElement('p');
      preview.className = 'context-reference-preview';
      const firstText = memories.get(question.memberIds[0]).text;
      preview.textContent = `关联内容（可能待核实）：${firstText.length > 120 ? `${firstText.slice(0, 119)}…` : firstText}`;
      const summary = document.createElement('summary');
      summary.textContent = `参考这 ${question.memberIds.length} 条整理内容（展开查看，内容可能仍待核实）`;
      const list = document.createElement('ul');
      question.memberIds.forEach(id => {
        const item = document.createElement('li');
        item.textContent = memories.get(id).text;
        list.append(item);
      });
      references.append(summary, list);
      const details = document.createElement('details');
      details.className = 'context-detail-disclosure';
      const detailsTitle = document.createElement('summary');
      detailsTitle.textContent = '补充一句（可选，不填也可以继续）';
      const label = document.createElement('label');
      label.className = 'detail-field';
      const labelText = document.createElement('span');
      labelText.textContent = '补充背景或说明选项不符合的地方，最多 1000 字';
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 1000;
      input.dataset.contextDetail = question.id;
      input.placeholder = '知道多少写多少；不必重写聊天，也不要填写无关敏感信息。';
      label.append(labelText, input);
      details.append(detailsTitle, label);
      card.append(kicker, preview, references, choices, details);
      $('contextQuestions').append(card);
    });
  }

  function contextAnswersFromForm() {
    if (!isContextual()) return [];
    return state.packet.contextQuestions.map(question => ({
      questionId: question.id,
      optionId: document.querySelector(`[data-context-question="${CSS.escape(question.id)}"]:checked`)?.value || '',
      detail: String(document.querySelector(`[data-context-detail="${CSS.escape(question.id)}"]`)?.value || '').replace(/\u0000/g, '').trim()
    }));
  }

  function responseAnswersFromForm() {
    return answersFromForm().filter(answer => !isContextual() || VERDICTS.has(answer.verdict)).map(answer => ({
      targetId: answer.targetId, targetKind: answer.targetKind, verdict: answer.verdict, important: answer.important,
      ...(answer.correction ? { correction: answer.correction } : {}),
      ...(answer.note ? { note: answer.note } : {})
    }));
  }

  function updateFocusedReview(validation) {
    if (state.packet.reviewScope !== 'supplemental') return;
    validation.answers.forEach(answer => {
      const target = state.targets.find(item => item.id === answer.targetId);
      const card = document.querySelector(`[data-target-id="${CSS.escape(answer.targetId)}"]`);
      const summary = card?.querySelector('[data-answer-summary]');
      if (!summary) return;
      const complete = answerIsComplete(answer);
      card.dataset.answerState = complete ? 'complete' : 'unfinished';
      const label = answer.verdict === 'uncertain' ? '暂不确定，保留待核对'
        : answer.verdict === 'accurate' ? '已确认属实'
          : answer.verdict === 'needs_change' ? (complete ? '已填写修订' : '待填写修订') : '待判断';
      summary.textContent = `${label} · ${cleanText(target.text, 90)}${target.text.length > 90 ? '…' : ''}${complete ? '（展开可修改）' : ''}`;
    });
    const filled = Object.keys(supplementsFromForm()).length;
    $('supplementsTitle').textContent = `还有重要内容没问到？${filled ? `（已填写 ${filled} 栏，展开可修改）` : '（可选）'}`;
  }

  // Only called on initial/draft load or an explicit navigation click. Moving
  // existing cards preserves every input and never moves the focused editor
  // while a participant is typing or changing a verdict.
  function arrangeFocusedReview({ focusNext = false } = {}) {
    if (state.packet?.reviewScope !== 'supplemental' || isContextual()) return;
    const answers = answersFromForm();
    const byId = new Map(answers.map(answer => [answer.targetId, answer]));
    const cards = new Map([...document.querySelectorAll('.review-card')].map(card => [card.dataset.targetId, card]));
    const unfinished = state.targets.filter(target => !answerIsComplete(byId.get(target.id)));
    const completed = state.targets.filter(target => answerIsComplete(byId.get(target.id)));
    const nodes = [];
    [[unfinished, '待完成'], [completed, '已完成 · 可展开修改']].forEach(([targets, label]) => {
      if (!targets.length) return;
      const lane = document.createElement('section');
      lane.className = 'review-answer-lane';
      lane.dataset.answerLane = targets === unfinished ? 'unfinished' : 'complete';
      const title = document.createElement('h2');
      title.textContent = `${label}（${targets.length} 项）`;
      lane.append(title);
      const groups = new Map();
      targets.forEach(target => {
        const key = target.eventGroup ? `event:${target.eventGroup}` : `section:${target.section}`;
        if (!groups.has(key)) {
          const group = document.createElement('div');
          group.className = 'review-event-group';
          group.dataset.eventGroup = target.eventGroup || '';
          const heading = document.createElement('h3');
          heading.textContent = target.eventGroup || REVIEW_SECTIONS[target.section][0];
          group.append(heading);
          groups.set(key, group);
          lane.append(group);
        }
        const card = cards.get(target.id);
        if (!card) return;
        card.querySelector('[data-answer-details]').open = !answerIsComplete(byId.get(target.id));
        groups.get(key).append(card);
      });
      nodes.push(lane);
    });
    $('reviewItems').replaceChildren(...nodes);
    if (!focusNext) return;
    const next = unfinished[0];
    if (next) {
      const answer = byId.get(next.id);
      const card = cards.get(next.id);
      const input = answer.verdict === 'needs_change'
        ? card.querySelector('[data-correction]') : card.querySelector('[data-verdict]');
      card.scrollIntoView({ block: 'start', behavior: 'auto' });
      input?.focus({ preventScroll: true });
    } else {
      $('consentAccepted').scrollIntoView({ block: 'center', behavior: 'auto' });
      $('consentAccepted').focus({ preventScroll: true });
    }
  }

  function renderPacket() {
    const { packet, targets } = state;
    renderContextQuestions();
    $('factReviewDisclosure').open = !isContextual();
    $('factReviewSummary').hidden = !isContextual();
    $('reviewTitle').textContent = isContextual() ? '单条内容纠错（可选）' : '逐项核对';
    $('metaReviewId').textContent = packet.reviewId;
    $('metaAlias').textContent = packet.participantAlias;
    $('metaVersion').textContent = packet.packetVersion;
    const expiry = Date.parse(packet.expiresAt || '');
    $('metaExpiry').textContent = Number.isFinite(expiry) ? `建议在 ${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(expiry))}前完成` : '未提供';
    $('packetMeta').hidden = false;
    const nodes = [];
    let lastSection = '';
    targets.forEach((target, index) => {
      if (target.section !== lastSection) {
        const heading = document.createElement('div');
        heading.className = 'review-section-heading';
        const title = document.createElement('h2');
        const note = document.createElement('p');
        [title.textContent, note.textContent] = REVIEW_SECTIONS[target.section];
        heading.append(title, note);
        nodes.push(heading);
        lastSection = target.section;
      }
      nodes.push(renderTarget(target, index));
    });
    $('reviewItems').replaceChildren(...nodes);
    const supplemental = packet.reviewScope === 'supplemental';
    const hasPending = targets.some(target => target.confirmationStatus === 'pending');
    $('supplementsPanel').hidden = !supplemental;
    const clarificationHints = packet.clarificationHints || [];
    $('clarificationHintsPanel').hidden = !supplemental || !clarificationHints.length;
    $('clarificationHintList').replaceChildren(...clarificationHints.map(value => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }));
    $('reviewInstructions').textContent = hasPending
      ? '请逐项确认；修改后纳入必须填写准确内容。暂不确定会保留待核对，不会作为已确认事实导出。' + (supplemental ? '完成一项后可点“继续核对”收起已完成项。' : '')
      : '每项选择“准确 / 需改 / 不确定”。选择“需改”后必须填写修订内容。';
    if (!targets.length) $('reviewInstructions').textContent = '这份页面没有逐项核对内容。可在下方填写你愿意补充的内容，不知道就留空。';
    $('markRemainingAccurate').hidden = supplemental || !targets.some(target => target.confirmationStatus !== 'pending');
    $('markRemainingAccurate').textContent = hasPending ? '其余普通项全部准确' : '其余全部准确';
    $('focusedReviewActions').hidden = !supplemental || !targets.length || isContextual();
    if (isContextual()) $('reviewInstructions').textContent = '这里不用逐项作答。仅在需要明确确认或修改某条内容时操作；不操作的条目保持原状态。背景回答、重要性和普通说明都不会自动确认事实。';
    $('reviewForm').hidden = false;
    $('clearReview').hidden = false;
    $('studyConsent').hidden = !packet.consentText;
    $('studyConsentText').textContent = packet.consentText;
    const gaps = Array.isArray(packet.suggestedGaps) ? packet.suggestedGaps : [];
    $('suggestedGaps').hidden = !gaps.length;
    $('suggestedGapList').replaceChildren(...gaps.map(value => {
      const item = document.createElement('li');
      item.textContent = value;
      return item;
    }));
    updateCompletion();
    arrangeFocusedReview();
  }

  function answersFromForm() {
    return state.targets.map(target => {
      const verdict = document.querySelector(`[data-verdict="${CSS.escape(target.id)}"]:checked`)?.value || '';
      const correction = cleanText(document.querySelector(`[data-correction="${CSS.escape(target.id)}"]`)?.value, 2000);
      const note = cleanText(document.querySelector(`[data-note="${CSS.escape(target.id)}"]`)?.value, 1000);
      const important = Boolean(document.querySelector(`[data-important="${CSS.escape(target.id)}"]`)?.checked);
      return { targetId: target.id, targetKind: target.kind, verdict, correction, note, important };
    });
  }

  function draftKey(packet = state.packet) {
    if (!packet?.reviewId) return '';
    return `${DRAFT_KEY_PREFIX}${packet.reviewId}:${packet.packetVersion || '1'}${packet.reviewMode === 'contextual' ? ':contextual' : ''}`;
  }

  function supplementsFromForm() {
    if (state.packet?.reviewScope !== 'supplemental') return {};
    return Object.fromEntries(Object.keys(SUPPLEMENT_LABELS).map(key => [
      key, String($(`supplement-${key}`).value || '').replace(/\u0000/g, '').trim()
    ]).filter(([, value]) => value));
  }

  function responseMatchesCurrentForm(response) {
    if (!response || response.schemaVersion !== responseSchema() || response.reviewId !== state.packet?.reviewId) return false;
    if (!isContextual() && (Object.prototype.hasOwnProperty.call(response, 'reviewMode') || Object.prototype.hasOwnProperty.call(response, 'contextAnswers'))) return false;
    if (isContextual() && (response.reviewMode !== 'contextual' || response.packetHash !== state.packet.packetHash || response.packetVersion !== state.packet.packetVersion || response.packetFileSha256 !== state.fileHashSha256 || JSON.stringify(response.contextAnswers) !== JSON.stringify(contextAnswersFromForm()) || validationResult().invalidContexts.length || validationResult().unansweredContexts.length)) return false;
    const current = responseAnswersFromForm();
    return $('consentAccepted').checked
      && cleanText($('overallNote').value, 2000) === cleanText(response.overallNote, 2000)
      && JSON.stringify(supplementsFromForm()) === JSON.stringify(response.supplements || {})
      && JSON.stringify(current) === JSON.stringify(response.answers || []);
  }

  function saveDraft() {
    const key = draftKey();
    if (!key) return false;
    try {
      localStorage.setItem(key, JSON.stringify({
        version: isContextual() ? 2 : 1,
        reviewId: state.packet.reviewId,
        packetVersion: state.packet.packetVersion,
        packetHash: state.packet.packetHash,
        packetFileSha256: state.fileHashSha256,
        savedAt: new Date().toISOString(),
        consentAccepted: $('consentAccepted').checked,
        overallNote: cleanText($('overallNote').value, 2000),
        ...(state.packet.reviewScope === 'supplemental' ? { supplements: supplementsFromForm() } : {}),
        answers: answersFromForm(),
        ...(isContextual() ? { reviewMode: 'contextual', contextAnswers: contextAnswersFromForm() } : {}),
        response: state.response
      }));
      setStatus($('draftStatus'), '已自动保存在这台设备的当前浏览器中。', 'ok');
      return true;
    } catch {
      setStatus($('draftStatus'), '当前浏览器不允许保存本机草稿；完成后请务必分享或复制完整结果。', 'error');
      return false;
    }
  }

  function removeSavedDraft(packet = state.packet) {
    const key = draftKey(packet);
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* storage may be blocked */ }
  }

  function restoreDraft() {
    const key = draftKey();
    if (!key) return false;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      const savedAt = Date.parse(draft.savedAt || '');
      const packetMatches = draft.version === (isContextual() ? 2 : 1)
        && draft.reviewId === state.packet.reviewId
        && draft.packetVersion === state.packet.packetVersion
        && (!state.packet.packetHash || draft.packetHash === state.packet.packetHash)
        && (isContextual() ? draft.reviewMode === 'contextual' && draft.packetHash === state.packet.packetHash && draft.packetFileSha256 === state.fileHashSha256 : !draft.packetFileSha256 || draft.packetFileSha256 === state.fileHashSha256);
      if (!packetMatches || !Number.isFinite(savedAt) || Date.now() - savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(key);
        return false;
      }
      // Validate the entire contextual draft before changing any live inputs.
      // A stale or malformed question must not partially restore fact verdicts.
      if (isContextual()) {
        const facts = draft.answers;
        const factIds = new Set();
        if (!Array.isArray(facts) || facts.length !== state.targets.length) throw new Error('逐项草稿不完整。');
        for (const answer of facts) {
          const target = state.targets.find(target => target.id === answer?.targetId);
          if (!target || factIds.has(answer.targetId) || answer.targetKind !== target.kind || typeof answer.verdict !== 'string' || (answer.verdict !== '' && !VERDICTS.has(answer.verdict)) || typeof answer.correction !== 'string' || answer.correction.length > 2000 || typeof answer.note !== 'string' || answer.note.length > 1000 || typeof answer.important !== 'boolean') throw new Error('逐项草稿与当前核对内容不匹配。');
          if (!answer.verdict && (answer.correction.trim() || answer.note.trim() || answer.important)) throw new Error('草稿存在未选择判断的备注或重要性，不能静默忽略。');
          factIds.add(answer.targetId);
        }
        const contexts = draft.contextAnswers;
        const seen = new Set();
        if (!Array.isArray(contexts) || contexts.length !== state.packet.contextQuestions.length) throw new Error('背景草稿不完整。');
        for (const answer of contexts) {
          const question = state.packet.contextQuestions.find(question => question.id === answer?.questionId);
          if (!question || seen.has(answer.questionId) || typeof answer.optionId !== 'string' || (answer.optionId && !question.options.some(option => option.id === answer.optionId)) || typeof answer.detail !== 'string' || answer.detail.length > 1000) throw new Error('本机背景草稿与当前问题不匹配。');
          seen.add(answer.questionId);
        }
      }
      const byId = new Map((Array.isArray(draft.answers) ? draft.answers : []).map(answer => [answer.targetId, answer]));
      state.targets.forEach(target => {
        const answer = byId.get(target.id);
        if (!answer) return;
        if (VERDICTS.has(answer.verdict)) {
          const input = document.querySelector(`[data-verdict="${CSS.escape(target.id)}"][value="${answer.verdict}"]`);
          if (input) input.checked = true;
        }
        const correction = document.querySelector(`[data-correction="${CSS.escape(target.id)}"]`);
        const correctionField = document.querySelector(`[data-correction-field="${CSS.escape(target.id)}"]`);
        if (correction) correction.value = cleanText(answer.correction, 2000);
        if (correctionField) correctionField.hidden = answer.verdict !== 'needs_change';
        if (correction) correction.required = answer.verdict === 'needs_change';
        const note = document.querySelector(`[data-note="${CSS.escape(target.id)}"]`);
        const noteField = document.querySelector(`[data-note-field="${CSS.escape(target.id)}"]`);
        const noteToggle = document.querySelector(`[data-note-toggle="${CSS.escape(target.id)}"]`);
        if (note) note.value = cleanText(answer.note, 1000);
        if (noteField && note?.value) noteField.hidden = false;
        if (noteToggle && note?.value) noteToggle.textContent = '－ 收起补充说明';
        const important = document.querySelector(`[data-important="${CSS.escape(target.id)}"]`);
        if (important) important.checked = Boolean(answer.important);
        if (isContextual()) {
          if (important) important.disabled = !VERDICTS.has(answer.verdict);
          if (noteToggle) noteToggle.disabled = !VERDICTS.has(answer.verdict);
        }
      });
      if (isContextual()) {
        for (const answer of draft.contextAnswers) {
          const question = state.packet.contextQuestions.find(question => question.id === answer.questionId);
          const input = document.querySelector(`[data-context-question="${CSS.escape(question.id)}"][value="${CSS.escape(answer.optionId)}"]`);
          if (input) input.checked = true;
          const detail = document.querySelector(`[data-context-detail="${CSS.escape(question.id)}"]`);
          detail.value = cleanText(answer.detail, 1000);
          if (detail.value) detail.closest('details').open = true;
        }
      }
      $('consentAccepted').checked = Boolean(draft.consentAccepted);
      $('overallNote').value = cleanText(draft.overallNote, 2000);
      if (state.packet.reviewScope === 'supplemental') {
        Object.keys(SUPPLEMENT_LABELS).forEach(key => {
          const value = draft.supplements?.[key];
          $(`supplement-${key}`).value = typeof value === 'string' && value.length <= MAX_SUPPLEMENT_LENGTH ? value : '';
        });
      }
      state.response = responseMatchesCurrentForm(draft.response) ? draft.response : null;
      updateCompletion();
      arrangeFocusedReview();
      setStatus($('draftStatus'), `已恢复本机草稿（${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(savedAt))}保存）。`, 'ok');
      return true;
    } catch {
      removeSavedDraft();
      if (isContextual()) {
        state.response = null;
        renderPacket();
        $('consentAccepted').checked = false;
        $('overallNote').value = '';
        Object.keys(SUPPLEMENT_LABELS).forEach(key => { $(`supplement-${key}`).value = ''; });
        updateCompletion();
        setStatus($('draftStatus'), '本机草稿不完整或与当前内容不匹配，未恢复任何答案；请重新核对，避免误用旧判断或漏掉备注。', 'error');
      }
      return false;
    }
  }

  function validationResult() {
    const answers = answersFromForm();
    const unanswered = isContextual() ? [] : answers.filter(answer => !VERDICTS.has(answer.verdict));
    const contextAnswers = contextAnswersFromForm();
    const unansweredContexts = contextAnswers.filter(answer => !answer.optionId);
    const invalidContexts = contextAnswers.filter(answer => answer.detail.length > 1000 || (answer.optionId && !state.packet.contextQuestions.find(question => question.id === answer.questionId).options.some(option => option.id === answer.optionId)));
    const missingCorrections = answers.filter(answer => answer.verdict === 'needs_change' && !answer.correction);
    const invalidSupplements = state.packet?.reviewScope === 'supplemental'
      ? Object.keys(SUPPLEMENT_LABELS).filter(key => $(`supplement-${key}`).value.length > MAX_SUPPLEMENT_LENGTH)
      : [];
    const missingSupplement = !isContextual() && state.packet?.reviewScope === 'supplemental' && !answers.length && !Object.keys(supplementsFromForm()).length;
    return { answers, unanswered, contextAnswers, unansweredContexts, invalidContexts, missingCorrections, invalidSupplements, missingSupplement, consent: $('consentAccepted').checked };
  }

  function updateCompletion() {
    if (!state.packet) return;
    const validation = validationResult();
    updateFocusedReview(validation);
    const answered = validation.answers.filter(answer => VERDICTS.has(answer.verdict)).length;
    $('reviewProgress').textContent = isContextual() ? `${answered} 项已主动判断（可选）` : `${answered} / ${validation.answers.length} 已判断`;
    $('contextProgress').textContent = `${validation.contextAnswers.length - validation.unansweredContexts.length} / ${validation.contextAnswers.length} 已补充`;
    document.querySelectorAll('.review-card').forEach(card => {
      const answer = validation.answers.find(item => item.targetId === card.dataset.targetId);
      card.classList.toggle('has-error', Boolean(answer && answer.verdict === 'needs_change' && !answer.correction));
    });
    const complete = !validation.unanswered.length && !validation.unansweredContexts.length && !validation.invalidContexts.length && !validation.missingCorrections.length && !validation.invalidSupplements.length && !validation.missingSupplement && validation.consent;
    $('downloadResponse').disabled = !complete;
    $('copySummary').disabled = !complete;
    if (complete) setStatus($('validationStatus'), isContextual() ? '背景补充已完成。未逐项判断的内容仍保持原状态；请发送或保存完整结果。' : '核对已完整。请发送或保存结果；若手机下载受限，可复制完整结果发回。', 'ok');
    else if (validation.unansweredContexts.length) setStatus($('validationStatus'), `还有 ${validation.unansweredContexts.length} 个背景问题未选择；拿不准可选“不确定”，不必填写文字。`);
    else if (validation.invalidContexts.length) setStatus($('validationStatus'), '背景选项无效或补充超过 1000 字，请检查。', 'error');
    else if (validation.unanswered.length) setStatus($('validationStatus'), `还有 ${validation.unanswered.length} 项未判断。`);
    else if (validation.missingCorrections.length) setStatus($('validationStatus'), `还有 ${validation.missingCorrections.length} 项“需改”但未填写修订内容。`, 'error');
    else if (validation.invalidSupplements.length) setStatus($('validationStatus'), `每栏补充最多 ${MAX_SUPPLEMENT_LENGTH} 字，请精简：${validation.invalidSupplements.map(key => SUPPLEMENT_LABELS[key]).join('、')}。`, 'error');
    else if (validation.missingSupplement) setStatus($('validationStatus'), '这份页面没有逐项核对内容。请至少填写一栏你认可的补充后再交回；没有可补充的内容可以直接关闭。');
    else setStatus($('validationStatus'), '请勾选并接受本地核对说明。');
  }

  function newResponseId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function buildResponse() {
    const validation = validationResult();
    if (validation.unanswered.length || validation.unansweredContexts.length || validation.invalidContexts.length || validation.missingCorrections.length || validation.invalidSupplements.length || validation.missingSupplement || !validation.consent) throw new Error('核对尚未完成，请检查判断、修订及补充字数。');
    const supplements = supplementsFromForm();
    const answers = responseAnswersFromForm();
    return {
      schemaVersion: responseSchema(),
      ...(isContextual() ? { reviewMode: 'contextual', contextAnswers: validation.contextAnswers } : {}),
      responseId: newResponseId(),
      reviewId: state.packet.reviewId,
      participantAlias: state.packet.participantAlias,
      packetVersion: state.packet.packetVersion,
      packetHash: state.packet.packetHash,
      packetFileSha256: state.fileHashSha256,
      consentVersion: state.packet.consentVersion,
      consentAccepted: true,
      completedAtClient: new Date().toISOString(),
      answers,
      overallNote: cleanText($('overallNote').value, 2000),
      ...(Object.keys(supplements).length ? { supplements } : {}),
      submissionMode: 'local-file-download-not-central-upload'
    };
  }

  function invalidateGeneratedResponse() {
    state.response = null;
    $('summaryBox').hidden = true;
    $('summaryPreview').textContent = '';
    const fallback = $('responseFallback');
    if (fallback) fallback.hidden = true;
    const preview = $('responseJsonPreview');
    if (preview) preview.value = '';
  }

  function ensureResponse() {
    if (!state.response) {
      state.response = buildResponse();
      saveDraft();
    }
    return state.response;
  }

  function responseJson(response = ensureResponse()) {
    return JSON.stringify(response, null, 2);
  }

  function responseFile(response = ensureResponse(), textBackup = false) {
    return new File(
      [responseJson(response)],
      textBackup ? 'review-response-json.txt' : 'review-response.json',
      { type: textBackup ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' }
    );
  }

  function shareableResponseFile(response = ensureResponse()) {
    if (typeof File !== 'function' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
    try {
      const json = responseFile(response);
      if (navigator.canShare({ files: [json] })) return json;
      const text = responseFile(response, true);
      if (navigator.canShare({ files: [text] })) return text;
      return null;
    } catch {
      return null;
    }
  }

  function canShareResponseFile(response = ensureResponse()) {
    return Boolean(shareableResponseFile(response));
  }

  function isEmbeddedMobileBrowser() {
    return /(MQQBrowser|QQ\/|MicroMessenger|Weibo|DingTalk|AlipayClient)/i.test(navigator.userAgent || '');
  }

  function showResponseFallback(response = ensureResponse()) {
    const shareable = canShareResponseFile(response);
    $('responseJsonPreview').value = responseJson(response);
    $('responseFallback').hidden = false;
    $('shareResponse').hidden = !shareable;
    $('responseFallbackHelp').textContent = shareable
      ? '可点“打开系统分享”选择微信、QQ或文件应用；若分享受限，也可复制完整结果发回。'
      : isEmbeddedMobileBrowser()
        ? 'QQ/微信内置浏览器可能拦截 JSON 下载。请优先“复制完整结果”并粘贴发回；完整内容也会保留在下方。'
        : '当前浏览器不支持直接分享文件。优先复制完整结果发回；也可尝试手机兼容版 TXT 或 JSON 下载。';
  }

  function downloadResponseFile(response = ensureResponse(), textBackup = false) {
    const json = responseJson(response);
    const blob = new Blob([json], { type: textBackup ? 'text/plain;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = textBackup ? 'review-response-json.txt' : 'review-response.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function shareResponseFile(response = ensureResponse()) {
    const file = shareableResponseFile(response);
    if (!file) throw new Error('当前浏览器不支持直接分享文件');
    await navigator.share({
      files: [file],
      title: '星迹核对结果',
      text: '这是我填写的星迹核对结果，请交回工作人员导入。'
    });
  }

  function summaryFor(response) {
    const counts = { accurate: 0, needs_change: 0, uncertain: 0 };
    response.answers.forEach(answer => { counts[answer.verdict] += 1; });
    const importantCount = response.answers.filter(answer => answer.important).length;
    const lines = [
      '星迹参与者核对摘要',
      `核对编号：${response.reviewId}`,
      `参与者代号：${response.participantAlias}`,
      `准确：${counts.accurate}；需改：${counts.needs_change}；不确定：${counts.uncertain}`,
      `标记为重要：${importantCount}`,
      '提交方式：本地生成文件，尚未自动上传'
    ];
    if (response.reviewMode === 'contextual') {
      lines.push(`已补充背景：${response.contextAnswers.length} 项；未逐项判断的内容保持原状态。`);
      response.contextAnswers.forEach(answer => {
        const question = state.packet.contextQuestions.find(question => question.id === answer.questionId);
        const option = question.options.find(option => option.id === answer.optionId);
        lines.push(`${question.prompt}：${option.label}${answer.detail ? `；补充：${answer.detail}` : ''}`);
      });
    }
    response.answers.filter(answer => answer.correction || answer.note).forEach(answer => {
      lines.push(`- ${answer.targetId}：${answer.verdict}${answer.correction ? `；修订：${answer.correction}` : ''}${answer.note ? `；补充：${answer.note}` : ''}`);
    });
    if (response.overallNote) lines.push(`整体补充：${response.overallNote}`);
    Object.entries(SUPPLEMENT_LABELS).forEach(([key, label]) => {
      if (response.supplements?.[key]) lines.push(`${label}：${response.supplements[key]}`);
    });
    return lines.join('\n');
  }

  async function copyText(value) {
    let clipboardError = null;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch (error) {
        clipboardError = error;
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange?.(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw clipboardError || new Error('浏览器未允许复制');
  }

  async function loadPacketBuffer(buffer, sourceLabel = '核对包') {
    resetReview(false);
    if (buffer.byteLength > MAX_PACKET_BYTES) throw new Error('核对包超过 2 MB 上限。');
    const parsed = JSON.parse(new TextDecoder().decode(buffer));
    const normalized = validatePacket(parsed);
    state.packet = normalized.packet;
    state.targets = normalized.targets;
    state.fileHashSha256 = await sha256Hex(buffer);
    renderPacket();
    const restored = restoreDraft();
    setStatus($('loadStatus'), `已在本地读取 ${state.targets.length} 个精简核对项（${sourceLabel}）；没有上传文件${restored ? '，并已恢复本机草稿' : ''}。`, 'ok');
  }

  async function loadPacket(file) {
    if (!file) return;
    if (file.size > MAX_PACKET_BYTES) throw new Error('核对包超过 2 MB 上限。');
    await loadPacketBuffer(await file.arrayBuffer(), file.name || '所选文件');
  }

  function decodeBase64(value) {
    const binary = atob(String(value || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function loadEmbeddedPacket() {
    const embedded = $('embeddedReviewPacket');
    if (!embedded) return false;
    const bytes = decodeBase64(embedded.content?.textContent || embedded.textContent);
    const expected = document.querySelector('meta[name="memorbit-review-packet-sha256"]')?.content || '';
    const actual = await sha256Hex(bytes);
    if (expected && expected !== actual) throw new Error('单文件核对页的数据摘要不一致，请联系发送者重新生成。');
    await loadPacketBuffer(bytes.buffer, '页面已内置，无需选择文件');
    const loadPanel = $('loadPanel');
    if (loadPanel) loadPanel.hidden = true;
    $('clearReview').hidden = true;
    const heroTitle = document.querySelector('.hero h1');
    const heroLead = document.querySelector('.hero .lede');
    if (heroTitle) heroTitle.textContent = '请核对整理好的档案';
    if (heroLead) heroLead.textContent = '内容已经准备好。你只需要判断是否准确、指出需要修改的地方，并在完成后把结果文件发回。';
    if ($('boundaryTitle')) $('boundaryTitle').textContent = '只核对整理结果，不上传聊天';
    if ($('boundaryText')) $('boundaryText').textContent = '这份页面只包含少量核心档案结果，不含原聊天或图片，但仍可能出现双方称呼和重要关系事实。页面不会联网或调用 AI；填写会尽力保存在当前设备，完成后请分享、下载或复制完整结果发回。';
    if ($('reviewStepLabel')) $('reviewStepLabel').textContent = '核对内容';
    if ($('finishStepLabel')) $('finishStepLabel').textContent = '完成并保存';
    if (state.packet.reviewScope === 'supplemental') {
      if (heroTitle) heroTitle.textContent = '核实候选记忆，补充重要内容';
      if (heroLead) heroLead.textContent = '请只确认和填写你本人认可的内容。暂不确定的候选会保留待核对，不会作为已确认事实导出。已完成项可收起，也能展开修改；可选补充留空不作结论。';
    }
    if (isContextual()) {
      if (heroTitle) heroTitle.textContent = '补几个关键背景，让记忆更贴近原意';
      if (heroLead) heroLead.textContent = '优先点选，不确定或都不符合也可以；补充文字可留空。背景回答只帮助理解，不会替你确认所有记忆事实。需要纠正单条内容时，可展开下方的可选核对区。';
    }
    document.body.classList.add('embedded-review');
    return true;
  }

  function resetReview(clearFile = true) {
    if (clearFile) removeSavedDraft();
    state.packet = null;
    state.targets = [];
    state.fileHashSha256 = '';
    state.response = null;
    $('reviewItems').replaceChildren();
    $('contextQuestions').replaceChildren();
    $('contextPanel').hidden = true;
    $('factReviewDisclosure').open = true;
    $('factReviewSummary').hidden = true;
    $('reviewForm').hidden = true;
    $('packetMeta').hidden = true;
    $('clearReview').hidden = true;
    $('consentAccepted').checked = false;
    $('overallNote').value = '';
    $('supplementsPanel').hidden = true;
    $('supplementsDisclosure').open = false;
    $('clarificationHintsPanel').hidden = true;
    $('clarificationHintList').replaceChildren();
    $('focusedReviewActions').hidden = true;
    Object.keys(SUPPLEMENT_LABELS).forEach(key => { $(`supplement-${key}`).value = ''; });
    $('summaryBox').hidden = true;
    $('summaryPreview').textContent = '';
    $('responseFallback').hidden = true;
    $('responseJsonPreview').value = '';
    setStatus($('draftStatus'), '填写内容会自动保存在这台设备的当前浏览器中。');
    if (clearFile) $('packetFile').value = '';
    setStatus($('loadStatus'), '尚未选择文件。');
  }

  $('packetFile').addEventListener('change', async event => {
    try {
      await loadPacket(event.target.files?.[0]);
    } catch (error) {
      resetReview(false);
      setStatus($('loadStatus'), error instanceof SyntaxError ? 'JSON 格式无效。' : (error.message || '无法读取核对包。'), 'error');
      event.target.value = '';
    }
  });

  $('reviewItems').addEventListener('change', event => {
    invalidateGeneratedResponse();
    if (event.target.matches('[data-verdict]')) {
      const id = event.target.dataset.verdict;
      const field = document.querySelector(`[data-correction-field="${CSS.escape(id)}"]`);
      field.hidden = event.target.value !== 'needs_change';
      const correction = field.querySelector('textarea');
      correction.required = event.target.value === 'needs_change';
      if (correction.required) correction.focus();
      if (isContextual()) {
        document.querySelector(`[data-important="${CSS.escape(id)}"]`).disabled = false;
        document.querySelector(`[data-note-toggle="${CSS.escape(id)}"]`).disabled = false;
      }
    }
    updateCompletion();
    saveDraft();
  });
  $('reviewItems').addEventListener('click', event => {
    if (event.target.closest('[data-next-unanswered]')) {
      arrangeFocusedReview({ focusNext: true });
      return;
    }
    const button = event.target.closest('[data-note-toggle]');
    if (!button) return;
    const field = document.querySelector(`[data-note-field="${CSS.escape(button.dataset.noteToggle)}"]`);
    if (!field) return;
    field.hidden = !field.hidden;
    button.textContent = field.hidden ? '＋ 补充一句（可选）' : '－ 收起补充说明';
    if (!field.hidden) field.querySelector('textarea')?.focus();
  });
  $('reviewItems').addEventListener('input', () => {
    invalidateGeneratedResponse();
    updateCompletion();
    saveDraft();
  });
  ['change', 'input'].forEach(type => $('contextQuestions').addEventListener(type, () => {
    invalidateGeneratedResponse();
    updateCompletion();
    saveDraft();
  }));
  $('markRemainingAccurate').addEventListener('click', () => {
    if (state.packet?.reviewScope === 'supplemental') return;
    invalidateGeneratedResponse();
    state.targets.forEach(target => {
      if (target.confirmationStatus === 'pending') return;
      const selected = document.querySelector(`[data-verdict="${CSS.escape(target.id)}"]:checked`);
      if (selected) return;
      const accurate = [...document.querySelectorAll(`[data-verdict="${CSS.escape(target.id)}"]`)].find(input => input.value === 'accurate');
      if (accurate) accurate.checked = true;
    });
    updateCompletion();
    saveDraft();
  });
  $('consentAccepted').addEventListener('change', () => {
    invalidateGeneratedResponse();
    updateCompletion();
    saveDraft();
  });
  $('overallNote').addEventListener('input', () => {
    invalidateGeneratedResponse();
    saveDraft();
  });
  $('supplementsPanel').addEventListener('input', () => {
    invalidateGeneratedResponse();
    updateCompletion();
    saveDraft();
  });
  $('nextUnanswered').addEventListener('click', () => arrangeFocusedReview({ focusNext: true }));
  $('collapseAnswered').addEventListener('click', () => arrangeFocusedReview());
  $('clearReview').addEventListener('click', () => resetReview(true));

  $('reviewForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const response = ensureResponse();
      showResponseFallback(response);
      const summary = summaryFor(response);
      $('summaryPreview').textContent = summary;
      $('summaryBox').hidden = false;
      if (canShareResponseFile(response)) {
        try {
          await shareResponseFile(response);
          setStatus($('validationStatus'), '系统分享操作已结束；页面无法确认对方是否收到。结果仍保留在下方，可再次发送、下载或复制。', 'ok');
        } catch (error) {
          if (error?.name === 'AbortError') setStatus($('validationStatus'), '你取消了系统分享。结果没有丢失，可在下方再次发送、下载或复制。');
          else setStatus($('validationStatus'), `系统分享未完成：${error.message || '浏览器不支持'}。请用下方下载或复制完整结果。`, 'error');
        }
      } else if (isEmbeddedMobileBrowser()) {
        try {
          await copyText(responseJson(response));
          setStatus($('validationStatus'), '完整核对结果已复制。请直接粘贴发给工作人员；QQ/微信内置浏览器不再自动发起可能失败的文件下载。', 'ok');
        } catch (error) {
          $('responseJsonPreview').focus();
          $('responseJsonPreview').select();
          setStatus($('validationStatus'), `自动复制未成功：${error.message || '浏览器未授权'}。完整结果已在下方选中，请长按复制后发回。`, 'error');
        }
      } else {
        downloadResponseFile(response);
        setStatus($('validationStatus'), '已发起保存，但尚未上传。若手机下载失败，请直接使用下方 TXT 或“复制完整结果”。', 'ok');
      }
    } catch (error) {
      setStatus($('validationStatus'), error.message || '无法生成响应文件。', 'error');
    }
  });

  $('shareResponse').addEventListener('click', async () => {
    try {
      const response = ensureResponse();
      showResponseFallback(response);
      await shareResponseFile(response);
      setStatus($('validationStatus'), '系统分享操作已结束；请确认已把文件发给工作人员。页面无法自动确认对方是否收到。', 'ok');
    } catch (error) {
      if (error?.name === 'AbortError') setStatus($('validationStatus'), '你取消了系统分享。结果仍保留在下方。');
      else setStatus($('validationStatus'), `无法直接分享：${error.message || '浏览器不支持'}。请改用下载或复制完整结果。`, 'error');
    }
  });

  $('retryResponseDownload').addEventListener('click', () => {
    try {
      const response = ensureResponse();
      showResponseFallback(response);
      downloadResponseFile(response);
      setStatus($('validationStatus'), '已再次发起 JSON 下载，但尚未上传。若仍失败，请下载 TXT 或复制完整结果。', 'ok');
    } catch (error) {
      setStatus($('validationStatus'), error.message || '无法下载结果文件。', 'error');
    }
  });

  $('downloadResponseText').addEventListener('click', () => {
    try {
      const response = ensureResponse();
      showResponseFallback(response);
      downloadResponseFile(response, true);
      setStatus($('validationStatus'), '已发起手机兼容版 TXT 下载，但页面无法确认手机是否保存成功。内容与 JSON 完全相同；若失败，请复制完整结果。', 'ok');
    } catch (error) {
      setStatus($('validationStatus'), error.message || '无法下载 TXT 备份。', 'error');
    }
  });

  $('copyFullResponse').addEventListener('click', async () => {
    try {
      const response = ensureResponse();
      showResponseFallback(response);
      await copyText(responseJson(response));
      setStatus($('validationStatus'), '完整核对结果已复制。可直接粘贴发给工作人员；这不是摘要，可用于合并。', 'ok');
    } catch (error) {
      $('responseJsonPreview').focus();
      $('responseJsonPreview').select();
      setStatus($('validationStatus'), `自动复制未成功：${error.message || '浏览器未授权'}。完整结果已保留在下方，请长按全选复制。`, 'error');
    }
  });

  $('clearSavedDraft').addEventListener('click', () => {
    removeSavedDraft();
    setStatus($('draftStatus'), '已清除这份核对在当前浏览器中的本机草稿。');
  });

  $('copySummary').addEventListener('click', async () => {
    try {
      const response = ensureResponse();
      const summary = summaryFor(response);
      $('summaryPreview').textContent = summary;
      $('summaryBox').hidden = false;
      await copyText(summary);
      setStatus($('validationStatus'), '摘要已复制，但它不能用于合并。请使用下方“复制完整结果”、系统分享、TXT 或 JSON 发回。', 'ok');
    } catch (error) {
      setStatus($('validationStatus'), `摘要已显示，但复制失败：${error.message || '浏览器未授权'}`, 'error');
    }
  });

  loadEmbeddedPacket().catch(error => {
    const node = $('loadStatus');
    if (node) setStatus(node, error.message || '无法打开这份单文件核对页。', 'error');
  });
})();
