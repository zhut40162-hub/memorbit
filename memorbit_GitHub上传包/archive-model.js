(function (root) {
  'use strict';

  // This module does not decide whether a memory is true, call a model, or mutate
  // an archive. It only normalizes identities and serializes locally grounded
  // context. A caller must never pass model output as a user scopeConfirmation.
  const KINDS = ['user_self', 'user_character', 'companion', 'npc', 'unknown'];
  const ID = /^[a-zA-Z0-9_-]{1,120}$/;
  const SCOPE_FIELDS = ['speakerId', 'recipientIds', 'participantIds', 'world', 'scene', 'stage'];
  const NOTE_LABELS = { participants: '涉及对象', stage: '适用阶段', scope: '适用范围', basis: '内容性质' };
  const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const str = (value, limit = 400) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
  const known = value => /^(?:unknown|unspecified|未知|不详|不确定|未说明|待确认|待核对|无)$/i.test(value) ? '' : value;
  const text = (value, limit = 400) => known(str(value, limit));
  const list = (value, limit = 100) => Array.isArray(value) ? [...new Set(value.map(item => text(item, 120)).filter(Boolean))].slice(0, limit) : [];
  const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Retain only one active immutable source (including its identity). Small,
  // bounded child caches avoid reparsing a large source for each extracted item.
  // Public results are copied: editing them must never alter later validation.
  let activeSourceCache = null;
  function sourceCache(sourceText, sourceId = '') {
    const source = typeof sourceText === 'string' ? sourceText : '', id = text(sourceId, 120);
    if (!activeSourceCache || activeSourceCache.sourceText !== source || activeSourceCache.sourceId !== id) {
      activeSourceCache = { sourceText: source, sourceId: id, blocks: null,
        declarations: new Map(), actors: new Map(), contexts: new Map() };
    }
    return activeSourceCache;
  }
  function cachedValue(cache, key, limit, compute) {
    if (cache.has(key)) {
      const value = cache.get(key); cache.delete(key); cache.set(key, value); return value;
    }
    const value = compute(); cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return value;
  }
  function copyReadResult(value) {
    if (Array.isArray(value)) return value.map(copyReadResult);
    if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyReadResult(item)]));
    return value;
  }
  function actorsCacheKey(actors) {
    // Include every field consumed by scope/name resolution, not just actor ID
    // or object identity: callers may update aliases or source bindings in place.
    return JSON.stringify(actors.map(actor => [actor.id, actor.kind, actor.name, actor.aliases || [],
      actor.world, actor.sourceId, actor.dialogueRole,
      actor.sourceEvidence ? [actor.sourceEvidence.quote, actor.sourceEvidence.start] : null]));
  }
  function sourceBlocks(sourceText, sourceId = '') {
    if (typeof sourceText !== 'string') return [];
    const cache = sourceCache(sourceText, sourceId);
    if (!cache.blocks) cache.blocks = parseSourceBlocksUncached(sourceText, sourceId);
    return cache.blocks;
  }
  function hash(value) {
    let n = 2166136261;
    for (const char of value) { n ^= char.charCodeAt(0); n = Math.imul(n, 16777619); }
    return (n >>> 0).toString(36);
  }
  function normalizeActors(raw, identity = {}) {
    const rows = Array.isArray(raw) ? raw : plain(raw) && Array.isArray(raw.actors) ? raw.actors : [];
    if (rows.length > 100) throw new Error('人物超过 100 个，请拆分世界或项目；没有静默丢弃人物。');
    const result = [], ids = new Set();
    const fresh = base => { let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; return id; };
    rows.forEach(value => {
      if (!plain(value)) return;
      const kind = KINDS.includes(value.kind) ? value.kind : 'unknown';
      const name = text(value.name, 120), world = text(value.world, 200), sourceId = text(value.sourceId, 120);
      if (!name && !ID.test(value.id || '')) return;
      let id = ID.test(value.id || '') ? value.id : fresh(`actor-${hash(JSON.stringify([kind, name, world, sourceId, str(value.description, 2000)]))}`);
      // Duplicate IDs are an identity conflict, not an invitation to merge names.
      if (ids.has(id)) throw new Error(`人物编号重复：${id}。请保留独立编号，不按同名合并。`);
      ids.add(id);
      result.push({ id, kind, name, aliases: list([name, ...(Array.isArray(value.aliases) ? value.aliases : [])], 30), world,
        description: str(value.description, 2000), sourceId, dialogueRole: value.dialogueRole === 'user' ? 'user' : '',
        sourceEvidence: normalizeActorEvidence(value.sourceEvidence) });
    });
    const ensure = (kind, base, name, aliases) => {
      const existing = result.filter(actor => actor.kind === kind);
      if (existing.length) return;
      const id = fresh(base); ids.add(id);
      result.push({ id, kind, name, aliases: list([name, ...aliases], 30), world: '', description: '', sourceId: '', dialogueRole: '', sourceEvidence: null });
    };
    ensure('user_self', 'actor-user-self', text(identity.userName || identity.user, 120) || '用户', ['用户', 'user']);
    ensure('companion', 'actor-companion', text(identity.companionName || identity.companion, 120) || 'AI 伴侣', ['AI 伴侣', 'AI伴侣', 'assistant']);
    return result;
  }
  function normalizeScope(raw) {
    const value = plain(raw) ? raw : {};
    return { speakerId: ID.test(value.speakerId || '') ? value.speakerId : '',
      recipientIds: list(value.recipientIds).filter(id => ID.test(id)),
      participantIds: list(value.participantIds).filter(id => ID.test(id)),
      world: text(value.world, 200), scene: text(value.scene, 400), stage: text(value.stage, 200) };
  }
  function actorList(raw) { return Array.isArray(raw) ? raw.filter(actor => plain(actor) && ID.test(actor.id || '')) : []; }
  function normalizeActorEvidence(value) {
    if (!plain(value) || typeof value.quote !== 'string' || !value.quote.trim() || value.quote.length > 5000) return null;
    return { sourceId: text(value.sourceId, 120), quote: value.quote,
      start: Number.isSafeInteger(value.start) && value.start >= 0 ? value.start : -1,
      end: Number.isSafeInteger(value.end) && value.end >= 0 ? value.end : -1,
      declarationKind: ['user_character', 'companion', 'npc', 'unknown'].includes(value.declarationKind) ? value.declarationKind : 'unknown', sourceStatus: 'source_declaration' };
  }
  function resolveActor(label, actors) {
    const value = text(label, 120).replace(/^(?:第三方|NPC|npc)\s*[:：]\s*/, '');
    if (!value || /^(?:未知人物|unknown|system|系统)$/i.test(value)) return '';
    if (/^(?:用户|user)$/i.test(value)) {
      const bound = actors.filter(actor => actor._canonicalUserForSource === true);
      if (bound.length === 1) return bound[0].id;
    }
    const direct = actors.filter(actor => actor.id === value);
    if (direct.length === 1) return direct[0].id;
    const matches = actors.filter(actor => [actor.name, ...(actor.aliases || [])].includes(value));
    // Canonical "用户" can mean the player's fictional role. Without explicit
    // role-labelled dialogue, never reclassify that dialogue as real-life self.
    if (/^(?:用户|user)$/i.test(value) && actors.some(actor => actor.kind === 'user_character') && matches.some(actor => actor.kind === 'user_self')) return '';
    return matches.length === 1 ? matches[0].id : '';
  }
  function candidateScope(memory, actors) {
    const scope = normalizeScope(memory.scope), context = plain(memory.context) ? memory.context : {};
    const validIds = new Set(actors.map(actor => actor.id));
    scope.speakerId = validIds.has(scope.speakerId) ? scope.speakerId : resolveActor(context.speaker, actors);
    scope.recipientIds = scope.recipientIds.filter(id => validIds.has(id));
    if (!scope.recipientIds.length && text(context.recipient)) scope.recipientIds = [resolveActor(context.recipient, actors)].filter(Boolean);
    scope.participantIds = scope.participantIds.filter(id => validIds.has(id));
    if (!scope.participantIds.length && Array.isArray(context.participants)) scope.participantIds = [...new Set(context.participants.map(label => resolveActor(label, actors)).filter(Boolean))];
    scope.world ||= text(context.world, 200);
    scope.scene ||= text(context.scene, 400);
    scope.stage ||= text(context.stage, 200);
    return scope;
  }
  function scopeKey(memory = {}) {
    const c = plain(memory.context) ? memory.context : {};
    return 'archive-scope-' + hash(JSON.stringify([memory.id || '', memory.title || '', memory.text || '', memory.type || '', memory.subject || '',
      memory.sourceId || '', memory.evidence || '', memory.eventGroup || '', memory.temporalScope || '', memory.utteranceKind || '',
      normalizeScope(memory.scope), [c.speaker || '', c.recipient || '', list(c.participants), c.world || '', c.scene || '', c.stage || '']]));
  }
  function currentParticipantKey(memory = {}) {
    // Exact B05 key algorithm, so legacy human notes remain bound to their text.
    return 'context-content-' + hash(JSON.stringify([memory.title || '', memory.text || '', memory.type || '', memory.subject || '',
      memory.sourceId || '', memory.eventGroup || '', memory.temporalScope || '', memory.utteranceKind || '']));
  }
  function literalLocation(quote, source) {
    if (typeof quote !== 'string' || typeof source !== 'string' || !quote.trim() || quote.length > 20000) return -1;
    const first = source.indexOf(quote);
    return first >= 0 && source.indexOf(quote, first + 1) < 0 ? first : -1;
  }
  const META = {
    speakerId: ['说话者', '说话人', 'speaker'], recipientIds: ['接收者', '对谁说', '对象', 'recipient', 'recipients'],
    participantIds: ['在场者', '在场', '参与者', 'participants'], world: ['世界', '世界观', 'world'],
    scene: ['场景', 'scene'], stage: ['阶段', '关系阶段', 'stage']
  };
  function metadataValues(quote, field) {
    const labels = META[field].map(escapeRE).join('|');
    const pattern = new RegExp(`(?:^|[\\n;；|｜【\\[（(])\\s*(?:${labels})\\s*[:：]\\s*([^\\n;；|｜】\\]）)]+)(?=$|[\\n;；|｜】\\]）)])`, 'gi');
    return [...quote.matchAll(pattern)].map(match => match[1].trim());
  }
  function sourceLines(sourceText) {
    const lines = []; let start = 0;
    for (const raw of sourceText.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      lines.push({ raw: line, start, end: start + line.length }); start += raw.length + 1;
    }
    return lines;
  }
  function parseSourceBlocks(sourceText, sourceId = '') {
    return copyReadResult(sourceBlocks(sourceText, sourceId));
  }
  function parseSourceBlocksUncached(sourceText, sourceId = '') {
    if (typeof sourceText !== 'string') return [];
    const blocks = [];
    sourceLines(sourceText).forEach(line => {
      // Any standalone structural header ends the previous scope. A speaker-
      // prefixed header is a boundary only, never proof that its metadata is true.
      const clean = line.raw.match(/^\s*(?:\[结构标记\]\s*)?(【[^\r\n]*】)\s*$/);
      const boundary = clean || line.raw.match(/^\s*\[[^\]\r\n]+\]\s*(【[^\r\n]*】)\s*$/) || line.raw.match(/^\s*#{1,6}\s+.+$/);
      if (!boundary) return;
      if (blocks.length) blocks[blocks.length - 1].end = line.start;
      const quote = clean ? clean[1] : '', headerStart = quote ? line.start + line.raw.indexOf(quote) : line.start;
      const fields = {}, fieldLocations = {};
      if (quote) for (const field of SCOPE_FIELDS) {
        const values = [...new Set(metadataValues(quote, field).map(value => text(value, 500)).filter(Boolean))];
        if (values.length === 1) {
          fields[field] = values[0]; fieldLocations[field] = { quote, start: headerStart, end: headerStart + quote.length };
        }
      }
      blocks.push({ sourceId: text(sourceId, 120), start: line.start, headerStart, headerEnd: line.end, contentStart: Math.min(sourceText.length, line.end + (sourceText[line.end] === '\r' ? 2 : 1)),
        end: sourceText.length, header: quote, isRoleBlock: !!quote && /角色设定|角色资料|人物设定|用户扮演角色/.test(quote), fields, fieldLocations });
    });
    // Within an explicitly declared role-information block, a leading 世界：
    // field is structural data, not a fictional speaker named "世界".
    for (const block of blocks) {
      if (!block.isRoleBlock || block.fields.world) continue;
      const body = sourceText.slice(block.contentStart, block.end);
      const worlds = [...body.matchAll(/(?:^|\n)\s*(世界|世界观)\s*[:：]\s*([^\r\n。；;]+)/g)];
      const values = [...new Set(worlds.map(match => text(match[2], 200)).filter(Boolean))];
      if (values.length !== 1) continue;
      const match = worlds.find(row => text(row[2], 200) === values[0]), quote = match[0].trim();
      const start = block.contentStart + match.index + match[0].indexOf(quote);
      block.fields.world = values[0]; block.fieldLocations.world = { quote, start, end: start + quote.length };
    }
    return blocks;
  }
  function declaredPerson(clause, companionName = '') {
    if (/不是|并非|不再是|假如|假设|如果|可能|也许|待定|不确定/.test(clause)) return null;
    let name = '', description = '', kind = '';
    const labelled = clause.match(/^(?:用户扮演角色|用户角色)\s*[:：]\s*([\p{L}\p{N}·._ -]{1,40})$/u);
    if (labelled) { name = labelled[1].trim(); description = '用户扮演角色'; kind = 'user_character'; }
    else {
      const match = clause.match(/^([\p{L}\p{N}·._ -]{1,40})是(?:\d{1,3}岁(?:的)?)?([^\r\n]{2,120})$/u);
      if (!match) return null;
      name = match[1].trim(); description = match[2].trim();
      if (/不是|并非|不再|假如|假设|如果|可能|也许|待定/.test(description)) return null;
      kind = /^(?:用户扮演角色|用户的扮演角色|用户角色)$/.test(description) ? 'user_character'
        : /^(?:AI\s*伴侣|伴侣角色)$/.test(description) || (companionName && name === companionName) ? 'companion'
        : /^(?:NPC|非玩家角色|普通客户|普通顾客|路人|配角)$/i.test(description) ? 'npc' : 'unknown';
    }
    return name ? { name, kind, description } : null;
  }
  function sourceDeclarations(sourceText, sourceId, identity = {}) {
    const cache = sourceCache(sourceText, sourceId), key = text(identity.companionName || identity.companion, 120);
    return cachedValue(cache.declarations, key, 4, () => sourceDeclarationsUncached(sourceText, sourceId, identity));
  }
  function sourceDeclarationsUncached(sourceText, sourceId, identity = {}) {
    const declarations = [], settings = [];
    for (const block of sourceBlocks(sourceText, sourceId)) {
      if (!block.isRoleBlock) continue;
      const regions = [{ start: block.contentStart, text: sourceText.slice(block.contentStart, block.end) },
        { start: block.headerStart + 1, text: block.header.slice(1, -1) }];
      for (const region of regions) for (const match of region.text.matchAll(/[^，,。；;\r\n]+/g)) {
        const quote = match[0].trim(), value = declaredPerson(quote, text(identity.companionName || identity.companion, 120));
        if (!value) continue;
        const start = region.start + match.index + match[0].indexOf(quote);
        declarations.push({ ...value, world: block.fields.world || '', sourceId: text(sourceId, 120), quote, start, end: start + quote.length, blockStart: block.start });
      }
      // Only whole setting lines explicitly beginning with a declared person's
      // name are collected. Unlabelled continuation prose is not guessed.
      const body = sourceText.slice(block.contentStart, block.end);
      sourceLines(body).forEach(line => {
        const quote = line.raw.trim();
        const owners = declarations.filter(row => row.blockStart === block.start && quote.startsWith(row.name) && /^(?:说话|的|通常|总是|习惯|重视|不喜欢|喜欢|擅长|性格)/.test(quote.slice(row.name.length)));
        if (owners.length !== 1 || !quote || /^\s*[\[“"「]/.test(line.raw)) return;
        const start = block.contentStart + line.start + line.raw.indexOf(quote);
        settings.push({ declarationStart: owners[0].start, sourceId: text(sourceId, 120), world: block.fields.world || '', quote, start, end: start + quote.length });
      });
    }
    return { declarations, settings };
  }
  function registerSourceActors(sourceText, identity = {}, options = {}) {
    const sourceId = text(options.sourceId, 120), parsed = sourceDeclarations(typeof sourceText === 'string' ? sourceText : '', sourceId, identity);
    const rpMatchesUser = parsed.declarations.some(row => row.kind === 'user_character' && row.name === text(identity.userName || identity.user, 120));
    const existing = actorList(options.actors).map(actor => ({ ...actor, aliases: [...(actor.aliases || [])] }));
    if (rpMatchesUser) existing.forEach(actor => {
      if (actor.id === 'actor-user-self' && actor.kind === 'user_self' && !actor.sourceId && !actor.sourceEvidence && !actor.description && actor.name === text(identity.userName || identity.user, 120)) {
        actor.name = '用户本人（姓名未提供）'; actor.aliases = ['用户本人'];
      }
    });
    const actors = normalizeActors(existing, { ...identity, ...(rpMatchesUser ? { userName: '用户本人（姓名未提供）', user: '' } : {}) });
    const declarations = [], settings = [], warnings = [];
    for (const row of parsed.declarations) {
      const id = `actor-source-${hash(JSON.stringify([sourceId, row.start, row.name, row.kind, row.world]))}`;
      let actor = actors.find(value => value.id === id);
      // The companion identity is an explicit user mapping, not name-based NPC
      // deduplication. A different world still creates a separate record.
      if (!actor && row.kind === 'companion' && row.name === text(identity.companionName || identity.companion, 120)) {
        const candidates = actors.filter(value => value.kind === 'companion' && value.name === row.name && (!value.world || value.world === row.world) && (!value.sourceEvidence || (value.sourceEvidence.sourceId === sourceId && value.sourceEvidence.start === row.start)));
        if (candidates.length === 1) actor = candidates[0];
      }
      const binding = row.kind === 'user_character' && row.name === text(identity.userName || identity.user, 120);
      const evidence = { sourceId, quote: row.quote, start: row.start, end: row.end, declarationKind: row.kind, sourceStatus: 'source_declaration' };
      if (!actor) {
        actor = { id, kind: row.kind, name: row.name, aliases: [row.name], world: row.world, description: row.description, sourceId, dialogueRole: binding ? 'user' : '', sourceEvidence: evidence };
        actors.push(actor);
      } else if (!actor.sourceEvidence) {
        Object.assign(actor, { world: row.world, sourceId, sourceEvidence: evidence, dialogueRole: binding ? 'user' : actor.dialogueRole || '' });
      }
      declarations.push({ ...row, actorId: actor.id, sourceStatus: 'source_declaration' });
      settings.push({ id: `setting-${hash(JSON.stringify([sourceId, row.start, row.end]))}`, actorId: actor.id, sourceId, world: row.world,
        quote: row.quote, start: row.start, end: row.end, category: 'persona', sourceStatus: 'source_grounded', scopeNote: '原文角色设定，仅在该虚构角色/世界中成立，不是现实用户履历。' });
    }
    for (const item of parsed.settings) {
      const declaration = declarations.find(row => row.start === item.declarationStart);
      if (declaration) settings.push({ id: `setting-${hash(JSON.stringify([sourceId, item.start, item.end]))}`, ...item, actorId: declaration.actorId,
        category: /说话|语气|称|对.+/.test(item.quote) ? 'interaction' : 'persona', sourceStatus: 'source_grounded',
        scopeNote: '原文角色设定；保留原有对象与阶段限定，不推广为任何场景下都如此。' });
    }
    const dialogueUsers = actors.filter(actor => actor.kind === 'user_character' && actor.dialogueRole === 'user' && actor.sourceId === sourceId);
    if (dialogueUsers.length > 1) warnings.push('同一来源存在多个用户扮演角色；须按明确世界/参与者定位，不能全局代入一个角色。');
    return { actors: normalizeActors(actors, identity), declarations, settings,
      dialogueUserActorId: dialogueUsers.length === 1 ? dialogueUsers[0].id : '', warnings };
  }
  function actorsForSource(actors, sourceText, sourceId, block = null) {
    const cache = sourceCache(sourceText, sourceId);
    const key = JSON.stringify([actorsCacheKey(actors), block?.fields?.world || '', block?.fields?.speakerId || '',
      block?.fields?.recipientIds || '', block?.fields?.participantIds || '']);
    return cachedValue(cache.actors, key, 32, () => actorsForSourceUncached(actors, sourceText, sourceId, block));
  }
  function actorsForSourceUncached(actors, sourceText, sourceId, block = null) {
    const world = block?.fields?.world || '';
    const scoped = actors.filter(actor => !world || !actor.world || actor.world === world);
    const declared = sourceDeclarations(sourceText, sourceId).declarations;
    let roles = scoped.filter(actor => actor.kind === 'user_character' && actor.dialogueRole === 'user' && actor.sourceId === sourceId && actor.sourceEvidence
      && declared.some(row => row.kind === 'user_character' && row.name === actor.name && row.world === actor.world && row.quote === actor.sourceEvidence.quote && row.start === actor.sourceEvidence.start)
      && literalLocation(actor.sourceEvidence.quote, sourceText) === actor.sourceEvidence.start);
    const named = [block?.fields?.speakerId || '', block?.fields?.recipientIds || '', block?.fields?.participantIds || ''].flatMap(value => value.split(/[,，、]/)).map(value => value.trim()).filter(Boolean);
    if (named.length) roles = roles.filter(actor => named.some(name => [actor.name, ...(actor.aliases || [])].includes(name)));
    const bound = roles.length === 1 ? roles[0].id : '';
    return scoped.map(actor => ({ ...actor, aliases: [...(actor.aliases || [])],
      sourceEvidence: plain(actor.sourceEvidence) ? { ...actor.sourceEvidence } : actor.sourceEvidence,
      _canonicalUserForSource: !!bound && actor.id === bound }));
  }
  function contextFromSource(memory = {}, sourceText = '', rawActors = []) {
    const sourceId = text(memory.sourceId, 120), cache = sourceCache(sourceText, sourceId);
    const actors = actorList(rawActors), quote = typeof memory.evidence === 'string' ? memory.evidence : '';
    // Unusable/oversized quotes cannot yield a valid context and should not be
    // retained as large keys. Preserve the uncached validator's exact result.
    if (!quote.trim() || quote.length > 20000) return contextFromSourceUncached(memory, sourceText, actors);
    const key = JSON.stringify([quote, actorsCacheKey(actors)]);
    return copyReadResult(cachedValue(cache.contexts, key, 64, () => contextFromSourceUncached(memory, sourceText, actors)));
  }
  function contextFromSourceUncached(memory = {}, sourceText = '', rawActors = []) {
    const scope = normalizeScope({}), fieldEvidence = {}, sourceId = text(memory.sourceId, 120);
    const quote = typeof memory.evidence === 'string' ? memory.evidence : '', start = literalLocation(quote, sourceText);
    const output = { scope, fieldEvidence, sourceStatus: 'unknown', block: null, evidenceLocation: null, reason: '' };
    if (start < 0 || !sourceId || ['manual', 'source-unknown'].includes(sourceId)) return { ...output, reason: 'unlocated_or_ambiguous_evidence' };
    const end = start + quote.length;
    output.evidenceLocation = { sourceId, quote, start, end };
    const blocks = sourceBlocks(sourceText, sourceId), block = [...blocks].reverse().find(value => value.start <= start);
    if (!block) return { ...output, reason: 'missing_header' };
    if (end > block.end) return { ...output, reason: 'cross_block' };
    if (!block.header || !Object.keys(block.fields).length) return { ...output, reason: 'no_explicit_scope' };
    output.block = block;
    const actors = actorsForSource(actorList(rawActors), sourceText, sourceId, block);
    for (const field of SCOPE_FIELDS) {
      const raw = block.fields[field]; if (!raw) continue;
      let value = raw;
      if (field === 'speakerId') value = resolveActor(raw, actors);
      if (field === 'recipientIds' || field === 'participantIds') {
        const ids = raw.split(/[,，、]/).map(label => resolveActor(label.trim(), actors));
        value = ids.every(Boolean) ? [...new Set(ids)] : [];
      }
      if (Array.isArray(value) ? !value.length : !value) continue;
      scope[field] = value;
      fieldEvidence[field] = { sourceStatus: 'source_grounded', sourceId, ...block.fieldLocations[field], association: 'same_explicit_block',
        memoryEvidence: { sourceId, quote, start, end } };
    }
    output.sourceStatus = Object.keys(fieldEvidence).length ? 'source_grounded' : 'unknown';
    return output;
  }
  function rawDialogueLines(quote, actors) {
    const lines = quote.split(/\r?\n/), turns = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      // Standalone context headers may precede an exact dialogue block.
      if (/^\s*【[^\n]+】\s*$/.test(raw)) continue;
      const match = raw.match(/^\s*\[([^\]\n]{1,120})\]\s*(.+)$/) || raw.match(/^\s*([^\n:：]{1,120})\s*[:：]\s*(.+)$/);
      if (!match) return null;
      const speakerId = resolveActor(match[1].trim(), actors);
      if (!speakerId || !match[2].trim()) return null;
      // Embedded labelled speakers on the same line are not a single voice.
      if (/\[(?:用户|AI\s*伴侣|第三方|NPC|未知人物)[^\]]*\]/i.test(match[2])) return null;
      const nested = match[2].match(/^\s*(?:\[([^\]\n]{1,120})\]|([^\n:：]{1,120})\s*[:：])/);
      if (nested && resolveActor(nested[1] || nested[2], actors)) return null;
      turns.push({ speakerId, text: match[2], raw });
    }
    return turns.length ? turns : null;
  }
  function validProof(field, proposed, quote, actors) {
    const values = metadataValues(quote, field);
    if (['world', 'scene', 'stage'].includes(field)) return !!proposed && values.includes(proposed);
    const mapped = values.map(value => value.split(/[,，、]/).map(label => resolveActor(label.trim(), actors)));
    if (field === 'speakerId') {
      if (mapped.some(ids => ids.length === 1 && ids[0] === proposed)) return true;
      const turns = rawDialogueLines(quote, actors);
      return !!proposed && !!turns && turns.length === 1 && turns[0].speakerId === proposed;
    }
    const expected = Array.isArray(proposed) ? proposed : [];
    if (!expected.length) return false;
    return mapped.some(ids => ids.length === expected.length && ids.every(Boolean) && new Set(ids).size === ids.length && expected.every(id => ids.includes(id)));
  }
  function validatedContext(memory = {}, sourceText = '', rawActors = []) {
    const linked = contextFromSource(memory, sourceText, rawActors);
    const actors = actorsForSource(actorList(rawActors), sourceText, text(memory.sourceId, 120), linked.block), scope = normalizeScope({}), fieldEvidence = {};
    const approval = plain(memory.scopeConfirmation) ? memory.scopeConfirmation : {};
    const userApproved = approval.source === 'user' && ID.test(approval.revisionId || '') && approval.contentKey === scopeKey(memory);
    // A human scope edit covers only the explicit scope fields. It must not
    // accidentally bless old model context that the editor did not display.
    const proposed = userApproved ? normalizeScope(memory.scope) : candidateScope(memory, actors);
    const validIds = new Set(actors.map(actor => actor.id));
    if (!validIds.has(proposed.speakerId)) proposed.speakerId = '';
    proposed.recipientIds = proposed.recipientIds.filter(id => validIds.has(id));
    proposed.participantIds = proposed.participantIds.filter(id => validIds.has(id));
    const quote = typeof memory.evidence === 'string' ? memory.evidence : '';
    const sourceId = text(memory.sourceId, 120), at = literalLocation(quote, sourceText);
    const sourceAllowed = at >= 0 && linked.reason !== 'cross_block' && !!sourceId && !['manual', 'source-unknown'].includes(sourceId) && memory.provenance !== 'conflict' && memory.status !== 'conflict';
    const proofs = plain(memory.contextEvidence) ? memory.contextEvidence : {};
    const aliases = { speakerId: 'speaker', recipientIds: 'recipient', participantIds: 'participants' };
    for (const field of SCOPE_FIELDS) {
      const value = proposed[field];
      if (Array.isArray(value) ? !value.length : !value) continue;
      if (userApproved) {
        scope[field] = Array.isArray(value) ? [...value] : value;
        fieldEvidence[field] = { sourceStatus: 'user_confirmed', revisionId: approval.revisionId, sourceId: 'manual', quote: '' };
      } else if (sourceAllowed) {
        // The model may point to a quote, but cannot self-assert its validity.
        const rawProof = proofs[field] ?? proofs[aliases[field]];
        const proof = typeof rawProof === 'string' ? rawProof : quote;
        if (!proof || proof.length > 20000 || !quote.includes(proof) || !validProof(field, value, proof, actors)) continue;
        scope[field] = Array.isArray(value) ? [...value] : value;
        fieldEvidence[field] = { sourceStatus: 'source_grounded', sourceId, quote: proof, start: at + quote.indexOf(proof), end: at + quote.indexOf(proof) + proof.length };
      }
    }
    // Local, explicit block metadata is independent of model-proposed fields.
    // Keep its proof separate; never splice a header into the dialogue evidence.
    if (sourceAllowed && !userApproved) for (const field of SCOPE_FIELDS) {
      const present = Array.isArray(scope[field]) ? scope[field].length > 0 : !!scope[field];
      const proposedPresent = Array.isArray(proposed[field]) ? proposed[field].length > 0 : !!proposed[field];
      const matchesHeader = Array.isArray(proposed[field]) ? [...proposed[field]].sort().join('\n') === [...linked.scope[field]].sort().join('\n') : proposed[field] === linked.scope[field];
      if (!present && linked.fieldEvidence[field] && (!proposedPresent || matchesHeader)) {
        scope[field] = Array.isArray(linked.scope[field]) ? [...linked.scope[field]] : linked.scope[field];
        fieldEvidence[field] = linked.fieldEvidence[field];
      }
    }
    const actorName = id => actors.find(actor => actor.id === id)?.name || id;
    return { scope,
      context: { speaker: actorName(scope.speakerId), recipient: scope.recipientIds.map(actorName).join('、'), participants: scope.participantIds.map(actorName), world: scope.world, scene: scope.scene, stage: scope.stage },
      fieldEvidence, sourceStatus: Object.keys(fieldEvidence).length ? (userApproved ? 'user_confirmed' : 'source_grounded') : 'unknown' };
  }
  function validParticipantNotes(memory) {
    const notes = Array.isArray(memory.participantContext) ? memory.participantContext : [];
    return notes.filter(note => plain(note) && NOTE_LABELS[note.dimension] && ID.test(note.questionId || '') && ID.test(note.optionId || '')
      && str(note.responseId, 100) && str(note.label, 200) && note.contentKey === currentParticipantKey(memory)).slice(-50);
  }
  function describeMemory(memory = {}, options = {}) {
    const body = typeof memory.text === 'string' ? memory.text : '';
    const lines = options.includeTitle && str(memory.title) ? [str(memory.title, 500), body] : [body];
    const validated = validatedContext(memory, options.sourceText || '', options.actors || []), c = validated.context;
    const values = [['说话者', c.speaker], ['接收者', c.recipient], ['在场者', c.participants.join('、')], ['世界', c.world], ['场景', c.scene], ['阶段', c.stage]].filter(([, value]) => value);
    if (values.length) lines.push(`${validated.sourceStatus === 'user_confirmed' ? '本人明确修订的适用情境' : '原文明确标注的适用情境'}（仅本条，不扩展为永久性格或所有对象）：\n${values.map(([label, value]) => `${label}：${value}`).join('\n')}`);
    const notes = validParticipantNotes(memory);
    if (notes.length) lines.push('本人补充的适用背景（仅针对本条，不等于确认全文；不同阶段保留区别）：\n' + [...new Set(notes.map(note => `${NOTE_LABELS[note.dimension]}：${str(note.label, 200)}${str(note.detail, 1000) ? `；本人补充：${str(note.detail, 1000)}` : ''}`))].join('\n'));
    return lines.filter(Boolean).join('\n\n');
  }
  function sourceFor(sources, sourceId) {
    if (!sourceId || ['manual', 'source-unknown'].includes(sourceId)) return '';
    if (sources instanceof Map) {
      const entry = sources.get(sourceId); return typeof entry === 'string' ? entry : plain(entry) && typeof entry.text === 'string' ? entry.text : '';
    }
    if (Array.isArray(sources)) {
      const rows = sources.filter(entry => plain(entry) && (entry.sourceId || entry.id) === sourceId);
      return rows.length === 1 && typeof rows[0].text === 'string' ? rows[0].text : '';
    }
    if (plain(sources) && Object.prototype.hasOwnProperty.call(sources, sourceId)) {
      const entry = sources[sourceId]; return typeof entry === 'string' ? entry : plain(entry) && typeof entry.text === 'string' ? entry.text : '';
    }
    return '';
  }
  function sampleEligible(memory) {
    return plain(memory) && memory.confirmed === true && (!memory.status || memory.status === 'current')
      && memory.provenance === 'direct' && memory.evidenceVerified !== false && (memory.subject !== 'unknown' || memory.type === '片段记忆')
      && typeof memory.evidence === 'string' && !!memory.evidence.trim();
  }
  function selectDialogueSamples(memories, rawActors, sources, options = {}) {
    const actors = actorList(rawActors), maxSamples = Number.isInteger(options.maxSamples) ? Math.max(0, Math.min(20, options.maxSamples)) : 6;
    const maxChars = Number.isInteger(options.maxChars) ? Math.max(20, Math.min(2000, options.maxChars)) : 800;
    const maxTurns = Number.isInteger(options.maxTurns) ? Math.max(2, Math.min(12, options.maxTurns)) : 6;
    const targets = Array.isArray(options.targetActorIds) ? new Set(options.targetActorIds) : new Set(actors.filter(actor => actor.kind === 'companion').map(actor => actor.id));
    const result = [], seen = new Set();
    for (const memory of Array.isArray(memories) ? memories : []) {
      if (result.length >= maxSamples) break;
      if (!sampleEligible(memory)) continue;
      const quote = memory.evidence;
      if (quote.length > maxChars) continue; // Never truncate a quote into a fake shorter conversation.
      const sourceId = text(memory.sourceId, 120), source = sourceFor(sources, sourceId), start = literalLocation(quote, source);
      if (start < 0) continue;
      // A label in the middle of another line is not reliable speaker attribution.
      if (start > 0 && source[start - 1] !== '\n' && source[start - 1] !== '\r') continue;
      const end = start + quote.length;
      if (end < source.length && source[end] !== '\n' && source[end] !== '\r') continue;
      const linked = contextFromSource(memory, source, actors);
      if (linked.reason === 'cross_block') continue;
      const turns = rawDialogueLines(quote, actorsForSource(actors, source, sourceId, linked.block));
      if (!turns || turns.length < 2 || turns.length > maxTurns || new Set(turns.map(turn => turn.speakerId)).size < 2 || !turns.some(turn => targets.has(turn.speakerId))) continue;
      // Legacy subject cannot represent NPCs. Explicit NPC + companion dialogue
      // is still a usable sample, without upgrading the event's subject.
      if (memory.subject === 'unknown' && !turns.some(turn => actors.some(actor => actor.id === turn.speakerId && actor.kind === 'npc'))) continue;
      const key = `${sourceId}:${start}:${end}`;
      if (seen.has(key)) continue;
      const verified = validatedContext(memory, source, actors);
      // A user may correct an old companion-attributed event to an NPC. Keep
      // the original quote in the archive, but do not reuse its old labels as
      // the companion's voice. Re-attributing that quote needs a separate UI.
      if (verified.sourceStatus === 'user_confirmed' && verified.scope.speakerId && !targets.has(verified.scope.speakerId)) continue;
      seen.add(key);
      result.push({ id: `dialogue-${hash(key)}`, memoryId: str(memory.id, 120), quote,
        turns, scope: verified.scope, context: verified.context, fieldEvidence: verified.fieldEvidence,
        sourceId, start, end, sourceStatus: 'source_grounded', attribution: 'explicit_speaker_labels',
        scopeNote: '仅代表这一段原话；未标注的接收者、场景和阶段保持未知，不扩展成固定回答。' });
    }
    return result;
  }
  function exclusionReason(memory) {
    if (!plain(memory)) return 'invalid_record';
    if (memory.status === 'deleted') return 'deleted';
    if (memory.status === 'conflict' || memory.provenance === 'conflict') return 'conflict';
    if (memory.status && memory.status !== 'current') return 'not_current';
    if (memory.confirmed !== true) return 'not_confirmed';
    if (typeof memory.text !== 'string' || !memory.text.trim()) return 'empty_content';
    return '';
  }
  function buildCoverage(memories, selectedIds) {
    const rows = Array.isArray(memories) ? memories : [], counts = new Map();
    rows.forEach(memory => { const id = str(memory?.id, 120); if (id) counts.set(id, (counts.get(id) || 0) + 1); });
    const chosen = Array.isArray(selectedIds) ? [...new Set(selectedIds.filter(id => typeof id === 'string'))] : [];
    const selected = new Set(chosen), exportedIds = [], excluded = [];
    let eligibleCount = 0;
    rows.forEach((memory, index) => {
      const id = str(memory?.id, 120);
      let reason = !id ? 'missing_id' : counts.get(id) > 1 ? 'duplicate_id' : exclusionReason(memory);
      if (!reason) { eligibleCount++; if (selected.has(id)) exportedIds.push(id); else reason = 'not_selected_for_this_export'; }
      if (reason) excluded.push({ id, index, title: str(memory?.title, 500), reason });
    });
    return { totalCount: rows.length, eligibleCount, selectedCount: chosen.length, exportedCount: exportedIds.length,
      excludedCount: excluded.length, exportedIds, excluded, unknownSelectedIds: chosen.filter(id => !counts.has(id)),
      unit: 'memory_entry', semanticCompleteness: 'not_assessed',
      note: '这里只统计条目带入情况，不代表原始材料已全部提取，也不代表每条语义、人物或情境完整。未选中条目仍应保留在完整主档中。' };
  }

  const api = Object.freeze({ normalizeActors, normalizeScope, parseSourceBlocks, contextFromSource, registerSourceActors,
    validatedContext, describeMemory, selectDialogueSamples, buildCoverage, scopeKey, currentParticipantKey });
  root.MemorbitArchive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
