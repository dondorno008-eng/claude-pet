// Spike S1: the pet's mod. Throwaway code: proves the mechanisms only.
//
// ~/.claude-pet/sessions/<sid>.json  written here: status, cwd, flags, log
// ~/.claude-pet/inbox/<sid>.json     written by the overlay: { id, text }
// ~/.claude-pet/acks/<sid>.json      written here: { id, status, ... }
//
// $.fs has no delete, so the inbox file stays; the ack's id is the guard
// against submitting the same message twice (the overlay removes the file).
import type { EngineInterface, Register } from 'claude-code'

type Status = 'starting' | 'running' | 'needs-input' | 'ready' | 'blocked' | 'ended'

type LogRow = { at: number; event: string; detail?: unknown }

type Pet = {
  // null until the session is known to be interactive; in a -p run it stays
  // null and every hook is a bare pass-through.
  ctx: null | { base: string; sid: string }
  isStarting: boolean
  isPolling: boolean
  lastAckedId: string | null
  ticks: number
  writing: Promise<void>
  pendingNewChat: null | { id: string; text: string; queuedAt: number }
  state: Record<string, unknown> & { log: LogRow[] }
}

function fileName(path: unknown) {
  const s = typeof path === 'string' ? path : ''
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1)
}

// Spike (e): a tool call as the pet's one-line "current step".
function stepFor(e: Record<string, unknown>) {
  const tool = String(e.tool)
  if (tool === 'Read') return `Чтение ${fileName(e.file_path)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return `Правка ${fileName(e.file_path ?? e.notebook_path)}`
  if (tool === 'Bash') return 'Выполняет команду…'
  if (tool === 'Grep' || tool === 'Glob') return 'Ищет в проекте…'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Ищет в интернете…'
  if (tool === 'Agent' || tool === 'Task') return 'Запускает помощника…'
  return `Работает: ${tool}`
}

function titleFrom(text: string) {
  return text.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60)
}

const POLL_MS = 1000
const PULSE_EVERY_TICKS = 15
const LOG_KEEP = 40

function paths(base: string, sid: string) {
  return {
    session: `${base}/sessions/${sid}.json`,
    inbox: `${base}/inbox/${sid}.json`,
    ack: `${base}/acks/${sid}.json`,
  }
}

function flush($: EngineInterface, P: Pet) {
  if (P.ctx === null) return P.writing
  const { session } = paths(P.ctx.base, P.ctx.sid)
  const text = JSON.stringify(P.state, null, 2)
  P.writing = P.writing.then(() => $.fs.write(session, text)).catch(() => undefined)
  return P.writing
}

async function note($: EngineInterface, P: Pet, event: string, patch: Record<string, unknown>, detail?: unknown) {
  if (P.ctx === null) return
  const now = await $.clock.now()
  Object.assign(P.state, patch, { updatedAt: now })
  P.state.log = [...P.state.log, { at: now, event, detail }].slice(-LOG_KEEP)
  await flush($, P)
}

async function writeAck($: EngineInterface, P: Pet, ack: Record<string, unknown>) {
  if (P.ctx === null) return
  await $.fs.write(paths(P.ctx.base, P.ctx.sid).ack, JSON.stringify(ack))
}

async function submitted($: EngineInterface, P: Pet, id: string, queuedAt: number) {
  const startedAt = await $.clock.now()
  await writeAck($, P, { id, status: 'started', queuedAt, startedAt })
  await note($, P, 'inbox.started', {}, { id, waitedMs: startedAt - queuedAt })
}

async function failed($: EngineInterface, P: Pet, id: string, queuedAt: number, err: unknown) {
  await writeAck($, P, { id, status: 'failed', queuedAt, error: String(err) })
  await note($, P, 'inbox.failed', {}, { id, error: String(err) })
}

async function poll($: EngineInterface, P: Pet) {
  if (P.ctx === null || P.isPolling) return
  P.isPolling = true
  try {
    P.ticks += 1
    if (P.ticks % PULSE_EVERY_TICKS === 0) {
      P.state.pulseAt = await $.clock.now()
      await flush($, P)
    }
    const { inbox } = paths(P.ctx.base, P.ctx.sid)
    if (!(await $.fs.exists(inbox))) return
    let msg: { id?: unknown; text?: unknown }
    try {
      msg = JSON.parse(String(await $.fs.read(inbox)))
    } catch {
      return // half-written or junk: the overlay replaces atomically
    }
    if (typeof msg.id !== 'string' || typeof msg.text !== 'string') return
    if (msg.id === P.lastAckedId) return
    const id = msg.id
    P.lastAckedId = id
    const queuedAt = await $.clock.now()
    await writeAck($, P, { id, status: 'queued', queuedAt })
    await note($, P, 'inbox.submit', {}, { id, queuedAt, statusAtQueue: P.state.status })
    if ((msg as { newChat?: unknown }).newChat === true) {
      // Spike (g): "new chat" = /clear in this window, then the prompt. The
      // session id changes; session.end(clear) rebinds the files to the new id.
      P.pendingNewChat = { id, text: msg.text, queuedAt }
      void $.command.run({ command: 'clear', args: '' }).catch((err: unknown) => failed($, P, id, queuedAt, err))
      return
    }
    // Resolves when the submitted turn starts, not when it ends; a running
    // turn makes it wait. Not awaited by the tick, so the poll goes on.
    void $.prompt
      .submit({ text: msg.text, asUser: true })
      .then(() => submitted($, P, id, queuedAt))
      .catch((err: unknown) => failed($, P, id, queuedAt, err))
  } catch (err) {
    await note($, P, 'poll.error', {}, String(err))
  } finally {
    P.isPolling = false
  }
}

async function makeDirs($: EngineInterface, base: string) {
  // 0700 on the shared folder; $.fs.write would make it with the umask.
  const dirs = [base, `${base}/sessions`, `${base}/inbox`, `${base}/acks`]
  try {
    const made = await $.process.run(['mkdir', '-p', '-m', '700', ...dirs])
    const mod = await $.process.run(['chmod', '700', ...dirs])
    return { mkdir: made.exitCode, chmod: mod.exitCode, stderr: made.stderr + mod.stderr }
  } catch (err) {
    return { error: String(err) }
  }
}

async function readLastAck($: EngineInterface, ack: string) {
  try {
    const prev = JSON.parse(String(await $.fs.read(ack))) as { id?: unknown }
    return typeof prev.id === 'string' ? prev.id : null
  } catch {
    return null
  }
}

async function spikeOpen($: EngineInterface, base: string) {
  // Spike (d): open TextEdit once, only when the flag file asks for it.
  if (!(await $.fs.exists(`${base}/spike-open-textedit`))) return undefined
  try {
    const r = await $.process.run(['open', '-a', 'TextEdit'])
    return { exitCode: r.exitCode, stderr: r.stderr }
  } catch (err) {
    return { error: String(err) }
  }
}

async function spikeHold($: EngineInterface, P: Pet, where: string) {
  // Spike (b): keep a turn running for 12 s without a model, so an inbox
  // message lands mid-turn. A `$` call in flight does not spend the budget.
  if (P.ctx === null || !(await $.fs.exists(`${P.ctx.base}/spike-hold-${where}`))) return
  await note($, P, `hold.${where}.begin`, {})
  await $.process.run(['sleep', '12'])
  await note($, P, `hold.${where}.end`, {})
}

async function rebind($: EngineInterface, P: Pet) {
  // After /clear the process goes on under a new session id.
  if (P.ctx === null) return
  const sid = await $.session.id()
  if (sid === P.ctx.sid) return
  const old = P.ctx.sid
  await note($, P, 'rebind', { status: 'ended' as Status, continuedAs: sid })
  P.ctx = { base: P.ctx.base, sid }
  const now = await $.clock.now()
  P.state = { ...P.state, sessionId: sid, continuedFrom: old, continuedAs: undefined, title: undefined, step: null, startedAt: now, log: [] }
  P.lastAckedId = await readLastAck($, paths(P.ctx.base, sid).ack)
  await note($, P, 'session.cleared', { status: 'ready' as Status })
  const pending = P.pendingNewChat
  P.pendingNewChat = null
  if (pending === null) return
  // The ack goes to the new id's file; the old inbox file is the overlay's to drop.
  P.lastAckedId = pending.id
  await writeAck($, P, { id: pending.id, status: 'queued', queuedAt: pending.queuedAt, from: old })
  void $.prompt
    .submit({ text: pending.text, asUser: true })
    .then(() => submitted($, P, pending.id, pending.queuedAt))
    .catch((err: unknown) => failed($, P, pending.id, pending.queuedAt, err))
}

function later($: EngineInterface, P: Pet) {
  void rebind($, P)
}

function tick($: EngineInterface, P: Pet) {
  void poll($, P)
}

async function start($: EngineInterface, P: Pet, isInteractive: boolean | null, cwd: string) {
  if (P.ctx !== null || P.isStarting) return
  P.isStarting = true
  try {
    const surfaces = await $.session.surfaces()
    // -p and headless SDK runs: no surface draws the session, the mod stays silent.
    // The desktop app drives the session through the SDK (isInteractive may be false) but attaches a surface.
    if (surfaces.length === 0 && isInteractive !== true) return
    const home = await $.env.get('HOME')
    if (home === undefined) return
    const base = `${home}/.claude-pet`
    const sid = await $.session.id()
    const mkdir = await makeDirs($, base)
    P.lastAckedId = await readLastAck($, paths(base, sid).ack)
    const spike = await spikeOpen($, base)
    P.ctx = { base, sid }
    const now = await $.clock.now()
    Object.assign(P.state, { sessionId: sid, cwd, isInteractive, surfaces, startedAt: now, mkdir, spikeOpen: spike })
    await note($, P, 'session.start', { status: 'ready' as Status })
    $.clock.every(POLL_MS, () => tick($, P))
  } finally {
    P.isStarting = false
  }
}

export const register: Register = on => {
  const P: Pet = {
    ctx: null,
    isStarting: false,
    isPolling: false,
    lastAckedId: null,
    ticks: 0,
    writing: Promise.resolve(),
    pendingNewChat: null,
    state: { status: 'starting' as Status, log: [] },
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await start($, P, e.isInteractive, e.cwd)
    return r
  })

  on('turn.start', async ($, e, next) => {
    // After a hot reload no session.start comes: start from the first turn.
    if (P.ctx === null) await start($, P, null, await $.session.cwd())
    if (P.ctx !== null && e.agentId === undefined) {
      const title = P.state.title ?? (e.text === '' || e.text.startsWith('<bash-') ? undefined : titleFrom(e.text))
      void note($, P, 'turn.start', { status: 'running' as Status, step: 'Размышление…', title, lastPrompt: e.text.slice(0, 80) }, { turnId: e.turnId })
      await spikeHold($, P, 'start')
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (P.ctx !== null && e.agentId === undefined) await spikeHold($, P, 'step')
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (P.ctx !== null && e.agentId === undefined) {
      const status: Status = e.reason === 'error' || e.reason === 'refusal' ? 'blocked' : 'ready'
      void note($, P, 'turn.complete', { status, step: null }, { turnId: e.turnId, reason: e.reason, ms: e.durationMs })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (P.ctx !== null && (e as { agentId?: string }).agentId === undefined) {
      const step = stepFor(e as unknown as Record<string, unknown>)
      void note($, P, 'tool.call', { step }, { tool: String(e.tool), step })
      const r = await next(e)
      if (P.state.status === 'needs-input') void note($, P, 'tool.done', { status: 'running' as Status }, { tool: String(e.tool) })
      return r
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    // Read the verdict, never change it: `ask` may mean a dialog for the person.
    const verdict = await next(e)
    // classic.Notification is bypassed under managed settings: `ask` is our only sign of a dialog.
    const asking = verdict.decision === 'ask' ? { status: 'needs-input' as Status, step: 'Ждёт вашего ответа' } : {}
    if (P.ctx !== null) void note($, P, 'tool.check', asking, { tool: String(e.tool), decision: verdict.decision })
    return verdict
  })

  on('classic.SessionStart', async ($, e, next) => {
    // A resumed session carries its title; a new one has none yet.
    if (P.ctx !== null && e.session_title) void note($, P, 'classic.SessionStart', { title: e.session_title }, { source: e.source })
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (P.ctx !== null) {
      const type = e.notification_type
      const isAsking = type === 'permission_prompt' || type === 'elicitation_dialog'
      void note($, P, 'notification', isAsking ? { status: 'needs-input' as Status, step: 'Ждёт вашего ответа' } : {}, {
        type,
        title: e.title,
        message: e.message,
      })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (P.ctx !== null) {
      void note($, P, 'prompt.submit', {}, { origin: e.origin, text: String(e.text ?? '').slice(0, 60) })
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (P.ctx !== null) await note($, P, 'session.end', { status: 'ended' as Status }, { reason: e.reason })
    if (P.ctx !== null && e.reason === 'clear') $.clock.after(300, () => later($, P))
    return next(e)
  })
}
