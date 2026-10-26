(function (root) {
  'use strict';
  // Context is separate from truth: none of these helpers changes a memory's
  // confirmation, subject, source, text, or evidence status.
  const DIMENSIONS = ['importance', 'participants', 'stage', 'scope', 'basis'];
  const LABELS = { importance: '保留重点', participants: '涉及对象', stage: '适用阶段', scope: '适用范围', basis: '内容性质' };
  const ID = /^[a-zA-Z0-9_-]{1,120}$/;
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const known = value => !/^(?:未知|不确定|未说明|待确认|待核对|unknown|unspecified|不详|无)$/i.test(value) ? value : '';
  function normalizeContext(raw) {
    const value = plain(raw) ? raw : {};
    return {
      speaker: known(text(value.speaker)), recipient: known(text(value.recipient)),
      participants: Array.isArray(value.participants) ? [...new Set(value.participants.map(item => known(text(item))).filter(Boolean))].slice(0, 12) : [],
      scene: known(text(value.scene, 400)), stage: known(text(value.stage)), basis: known(text(value.basis))
    };
  }
  function normalizeNotes(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(plain).map(note => ({
      questionId: text(note.questionId, 120), dimension: text(note.dimension, 30),
      optionId: text(note.optionId, 120), label: text(note.label, 200),
      detail: text(note.detail, 1000), responseId: text(note.responseId, 100), important: note.important === true,
      contentKey: text(note.contentKey, 80)
    })).filter(note => ID.test(note.questionId) && ID.test(note.optionId) && DIMENSIONS.includes(note.dimension) && note.responseId && note.label).slice(-50);
  }
  function strictText(value, name, max, optional = false) {
    if (optional && value === undefined) return '';
    if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw new Error(`${name}格式无效或过长。`);
    return value.trim();
  }
  function strictId(value, name) {
    if (typeof value !== 'string' || !ID.test(value)) throw new Error(`${name}编号无效。`);
    return value;
  }
  function normalizeQuestions(raw, validTargetIds) {
    if (!Array.isArray(raw) || !raw.length || raw.length > 5) throw new Error('背景问题应为 1 至 5 题。');
    const valid = new Set(validTargetIds || []), ids = new Set();
    return raw.map(q => {
      if (!plain(q)) throw new Error('背景问题格式无效。');
      const id = strictId(q.id, '问题');
      if (ids.has(id)) throw new Error('背景问题编号重复。');
      ids.add(id);
      if (!DIMENSIONS.includes(q.dimension)) throw new Error('背景问题类型无效。');
      if (!Array.isArray(q.memberIds) || !q.memberIds.length || q.memberIds.length > 12) throw new Error('背景问题的关联记忆范围无效。');
      const memberIds = q.memberIds.map(value => strictId(value, '关联记忆'));
      if (new Set(memberIds).size !== memberIds.length || memberIds.some(value => !valid.has(value))) throw new Error('背景问题包含未知或重复的关联记忆。');
      if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 16) throw new Error('背景问题选项数量无效。');
      const options = q.options.map(option => {
        if (!plain(option)) throw new Error('背景问题选项格式无效。');
        return { id: strictId(option.id, '选项'), label: strictText(option.label, '选项文字', 200) };
      });
      const optionIds = new Set(options.map(option => option.id));
      if (optionIds.size !== options.length || !optionIds.has('unknown') || !optionIds.has('other')) throw new Error('背景问题选项重复或缺少“不确定 / 都不符合”。');
      return { id, dimension: q.dimension, prompt: strictText(q.prompt, '问题文字', 500),
        groupLabel: strictText(q.groupLabel, '分组标题', 200), memberIds, options, allowDetail: true };
    });
  }
  function normalizeAnswers(raw, questions) {
    if (!Array.isArray(raw) || raw.length !== questions.length) throw new Error('请完成本轮背景问题；不知道时可以选择“不确定”。');
    const map = new Map(questions.map(q => [q.id, q])), seen = new Set();
    return raw.map(answer => {
      if (!plain(answer)) throw new Error('背景答案格式无效。');
      const questionId = strictId(answer.questionId, '问题'), optionId = strictId(answer.optionId, '选项');
      const question = map.get(questionId);
      if (seen.has(questionId) || !question || !question.options.some(option => option.id === optionId)) throw new Error('背景答案包含重复问题、未知问题或未知选项。');
      seen.add(questionId);
      return { questionId, optionId, detail: strictText(answer.detail, '背景补充', 1000, true) };
    });
  }
  function hash(value) {
    let n = 2166136261;
    for (const char of value) { n ^= char.charCodeAt(0); n = Math.imul(n, 16777619); }
    return (n >>> 0).toString(36);
  }
  function createQuestions(memories, idForMemory, identity = {}) {
    const candidates = (Array.isArray(memories) ? memories : []).filter(memory => memory && text(memory.text, 5000));
    const groups = new Map();
    const priority = { P0: 0, P1: 1, P2: 2, P3: 3 };
    const sorted = [...candidates].sort((a, b) => (priority[a.priority] ?? 3) - (priority[b.priority] ?? 3) || (a.sourceOrder || 0) - (b.sourceOrder || 0));
    for (const memory of sorted) {
      const context = normalizeContext(memory.context), event = text(memory.eventGroup, 80), source = text(memory.sourceId);
      const subject = text(memory.subject, 80).toLowerCase() || 'unknown';
      // A shared keyword/theme is not enough. Different files, actors or known
      // stages/scenes never become a single contextual claim.
      const canGroup = event && source && !['source-unknown', 'manual'].includes(source);
      const key = canGroup ? JSON.stringify([event, source, subject, context.speaker, context.recipient, [...context.participants].sort(), context.stage, context.scene]) : `single:${memory.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(memory);
    }
    const buckets = [];
    const unknownOptions = [{ id: 'unknown', label: '暂不确定' }, { id: 'other', label: '都不符合（可选补充）' }];
    const addressed = (memory, dimension) => normalizeNotes(memory.participantContext).some(note => note.dimension === dimension && note.contentKey === contentKey(memory));
    for (const [key, group] of groups) {
      const questions = [];
      const add = (dimension, relevant, prompt, options) => {
        const members = relevant.filter(memory => !addressed(memory, dimension)).slice(0, 12);
        if (!members.length) return;
        const memberIds = members.map(idForMemory);
        const choices = typeof options === 'function' ? options(members) : options;
        questions.push({ id: `context-${dimension}-${hash(JSON.stringify([key, memberIds]))}`, dimension, prompt,
          groupLabel: text(group[0].eventGroup || group[0].title || '这段记忆', 200), memberIds,
          options: [...choices, ...unknownOptions], allowDetail: true });
      };
      const unknownActors = group.filter(memory => memory.subject === 'unknown');
      add('participants', unknownActors, '这些片段主要是在说谁与谁的互动？只补充对象，不代表确认其中所有描述。', [
        { id: 'pair', label: `${text(identity.user || '用户', 45)}与${text(identity.companion || 'AI 伴侣', 45)}` },
        { id: 'third_party', label: '涉及其他角色 / NPC' }, { id: 'mixed', label: '不止一组对象，不能统一归属' }
      ]);
      const phaseRelevant = group.filter(memory => memory.relationKind === 'status' || memory.relationKind === 'progress' || memory.relationKind === 'address' || /关系|相处|角色人设/.test(memory.type || ''));
      add('stage', phaseRelevant, '这部分更适用于哪个阶段？阶段不同可以保留区别，不必归成同一种相处方式。', [
        { id: 'initial', label: '初识时的表现' }, { id: 'past', label: '过去某个阶段，现在未必适用' },
        { id: 'current', label: '目前仍适用' }, { id: 'mixed', label: '包含不同阶段，不能统一套用' }
      ]);
      const uncertainBasis = group.filter(memory => ['hypothetical', 'request', 'promise', 'unknown'].includes(memory.utteranceKind) && /希望|想要|期待|承诺|答应|如果|以后/.test(memory.text));
      add('basis', uncertainBasis, '这里最需要区分的是已经发生的经历，还是期望 / 提议？说过某句话不等于事情已经实现。', [
        { id: 'past', label: '描述已经发生的经历' }, { id: 'expectation', label: '表达期望、提议或尚未兑现的承诺' },
        { id: 'mixed', label: '两者都有，不能合成一个事实' }
      ]);
      const patternRelevant = group.filter(memory => /角色人设|相处方式/.test(memory.type || '') && !['stable', 'one_off'].includes(memory.temporalScope));
      add('scope', patternRelevant, '这些表现是一次经历，还是在某些情况下经常出现？这里只补充适用范围。', [
        { id: 'single', label: '只知道这一次' }, { id: 'conditional', label: '特定对象或场景下常见' },
        { id: 'recurring', label: '平时也经常这样（不是每次都必须如此）' }, { id: 'mixed', label: '各条不同，不能一概而论' }
      ]);
      if (group.length > 1 && !group.some(memory => memory.participantImportant)) {
        add('importance', group, '这组内容里，你最希望我们优先保留什么？未选中的内容不会因此删除。', members => [
          ...members.map((memory, index) => ({ id: `focus-${index + 1}`, label: text(memory.title || memory.text, 150) })),
          { id: 'whole', label: '这组整体都重要' }, { id: 'none', label: '没有额外重点，保留已有内容即可' }
        ]);
      }
      if (questions.length) buckets.push(questions);
    }
    // Round-robin across events before taking a second question for one event.
    const result = [];
    for (let depth = 0; depth < 5 && result.length < 5; depth++) {
      for (const bucket of buckets) { if (bucket[depth]) result.push(bucket[depth]); if (result.length === 5) break; }
    }
    return result.length ? normalizeQuestions(result, candidates.map(idForMemory)) : [];
  }
  function notesForAnswers(answers, questions, responseId) {
    const normalized = normalizeAnswers(answers, questions), byId = new Map(questions.map(q => [q.id, q]));
    const records = [];
    for (const answer of normalized) {
      const q = byId.get(answer.questionId), option = q.options.find(value => value.id === answer.optionId);
      q.memberIds.forEach((targetId, index) => records.push({ targetId, note: {
        questionId: q.id, dimension: q.dimension, optionId: answer.optionId, label: option.label,
        detail: answer.detail, responseId: text(responseId, 100),
        important: q.dimension === 'importance' && (answer.optionId === 'whole' || answer.optionId === `focus-${index + 1}`)
      } }));
    }
    return records;
  }
  function describe(memory) {
    const notes = normalizeNotes(memory?.participantContext).filter(note => note.dimension !== 'importance' && note.contentKey === contentKey(memory));
    if (!notes.length) return '';
    // Candidate model metadata stays in the backup/UI, never masquerades as
    // verified context in a platform export. Keep all human versions, not last-win.
    const lines = notes.map(note => `${LABELS[note.dimension]}：${note.label}${note.detail ? `；本人补充：${note.detail}` : ''}`);
    return '本人补充的适用背景（仅针对本条，不等于再次确认全文；不同阶段或说法保留区别）：\n' + [...new Set(lines)].join('\n');
  }
  function contentKey(memory = {}) {
    return 'context-content-' + hash(JSON.stringify([memory.title || '', memory.text || '', memory.type || '', memory.subject || '',
      memory.sourceId || '', memory.eventGroup || '', memory.temporalScope || '', memory.utteranceKind || '']));
  }
  const api = Object.freeze({ normalizeContext, normalizeNotes, normalizeQuestions, normalizeAnswers, createQuestions, notesForAnswers, describe, contentKey });
  root.MemorbitContext = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
