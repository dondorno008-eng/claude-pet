// horse-pet: tells the desktop horse what this Claude session is doing, and
// submits the prompts the horse drops in its inbox. Protocol: docs/protocol.md.
//
// ~/.claude-pet/sessions/<sid>.json  written here: status, step, title
// ~/.claude-pet/inbox/<sid>.json     written by the horse: { id, text, newChat } or { id, stop }
// ~/.claude-pet/acks/<sid>.json      written here: { id, status }
// ~/.claude-pet/show.json            written here by /horse: the window shows itself
//
// Every hook only watches: `next(e)` decides, the pet never gates anything.
// $.fs has no delete, so an inbox file stays until the horse drops it; the
// ack's id guards against submitting it twice.
import type { EngineInterface, Register } from 'claude-code'

type Status = 'ready' | 'running' | 'needs-input' | 'blocked' | 'ended'

type Pet = {
  // null until the session is known to be shown to a person; in a -p run it
  // stays null and every hook is a bare pass-through.
  ctx: null | { base: string; sid: string; home: string }
  isStarting: boolean
  isPolling: boolean
  lastAckedId: string | null
  ticks: number
  launchedAt: number
  writing: Promise<void>
  pendingNewChat: null | { id: string; text: string; queuedAt: number }
  // the main loop's running turn, for ■ Stop
  turnId: string | null
  state: Record<string, unknown>
}

const POLL_MS = 1000
const PULSE_EVERY_TICKS = 15
const OVERLAY_STALE_MS = 60_000
const MAX_TEXT = 8000
const APP = 'HorsePet.app'

function fileName(path: unknown) {
  const s = typeof path === 'string' ? path : ''
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1)
}

// a tool call as the pet's one-line "current step"
function stepFor(e: Record<string, unknown>) {
  const tool = String(e.tool)
  if (tool === 'Read') return `Чтение ${fileName(e.file_path)}`
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return `Правка ${fileName(e.file_path ?? e.notebook_path)}`
  if (tool === 'Bash') {
    const cmd = String(e.command ?? '')
    return /(^|[\s|;&(])(grep|rg|find|ag|fd)\s/.test(cmd) ? 'Ищет в проекте…' : 'Выполняет команду…'
  }
  if (tool === 'Grep' || tool === 'Glob') return 'Ищет в проекте…'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'Ищет в интернете…'
  if (tool === 'Agent' || tool === 'Task') return 'Запускает помощника…'
  return `Работает: ${tool}`
}

function titleFrom(text: string) {
  return text.trim().split(/\s+/).slice(0, 6).join(' ').slice(0, 60)
}

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
  const text = JSON.stringify(P.state)
  P.writing = P.writing.then(() => $.fs.write(session, text)).catch(() => undefined)
  return P.writing
}

async function note($: EngineInterface, P: Pet, patch: Record<string, unknown>) {
  if (P.ctx === null) return
  Object.assign(P.state, patch, { updatedAt: await $.clock.now() })
  await flush($, P)
}

async function writeAck($: EngineInterface, P: Pet, ack: Record<string, unknown>) {
  if (P.ctx === null) return
  await $.fs.write(paths(P.ctx.base, P.ctx.sid).ack, JSON.stringify({ v: 1, ...ack })).catch(() => undefined)
}

function submit($: EngineInterface, P: Pet, id: string, text: string, queuedAt: number) {
  // Resolves when the submitted turn starts (a running turn makes it wait).
  void $.prompt
    .submit({ text, asUser: true })
    .then(async () => writeAck($, P, { id, status: 'started', queuedAt, startedAt: await $.clock.now() }))
    .catch((err: unknown) => writeAck($, P, { id, status: 'failed', queuedAt, error: String(err) }))
}

async function launchOverlay($: EngineInterface, P: Pet, force = false) {
  if (P.ctx === null) return false
  const now = await $.clock.now()
  if (!force && now - P.launchedAt < OVERLAY_STALE_MS) return true
  P.launchedAt = now
  try {
    const o = JSON.parse(String(await $.fs.read(`${P.ctx.base}/overlay.json`))) as { pulseAt?: unknown }
    if (typeof o.pulseAt === 'number' && now - o.pulseAt < OVERLAY_STALE_MS) return true
  } catch {
    // no overlay.json yet: the horse has never run
  }
  for (const app of [`${P.ctx.home}/Applications/${APP}`, `/Applications/${APP}`]) {
    if (!(await $.fs.exists(app))) continue
    await $.process.run(['open', '-g', app]).catch(() => undefined)
    return true
  }
  return false
}

// /horse: the window comes back (shown, input open), started first if it is not running
async function summon($: EngineInterface, P: Pet) {
  if (P.ctx === null) return 'Лошадка живёт только в открытой сессии Claude Code.'
  await $.fs.write(`${P.ctx.base}/show.json`, JSON.stringify({ v: 1, at: await $.clock.now() })).catch(() => undefined)
  if (!(await launchOverlay($, P, true))) return `Лошадка не установлена: нет ${APP} в ~/Applications и /Applications.`
  return 'Лошадка здесь — пишите в строку под ней.'
}

async function stop($: EngineInterface, P: Pet, id: string) {
  const at = await $.clock.now()
  const turnId = P.turnId
  if (turnId !== null) {
    const err = await $.turn.abort({ turnId }).then(() => null, (e: unknown) => String(e))
    if (err !== null) return writeAck($, P, { id, status: 'failed', queuedAt: at, error: err })
  }
  await writeAck($, P, { id, status: 'stopped', queuedAt: at, stoppedAt: at })
}

async function readInbox($: EngineInterface, P: Pet) {
  if (P.ctx === null) return
  const { inbox } = paths(P.ctx.base, P.ctx.sid)
  if (!(await $.fs.exists(inbox))) return
  let msg: { id?: unknown; text?: unknown; newChat?: unknown; stop?: unknown }
  try {
    msg = JSON.parse(String(await $.fs.read(inbox)))
  } catch {
    return // junk: the horse replaces the file atomically
  }
  if (typeof msg.id !== 'string' || msg.id === P.lastAckedId) return
  if (msg.stop === true) {
    P.lastAckedId = msg.id
    return stop($, P, msg.id)
  }
  if (typeof msg.text !== 'string') return
  const id = msg.id
  const text = msg.text.slice(0, MAX_TEXT)
  P.lastAckedId = id
  const queuedAt = await $.clock.now()
  await writeAck($, P, { id, status: 'queued', queuedAt })
  if (msg.newChat === true) {
    // "new chat" = /clear in this window, then the prompt. The session id
    // changes; session.end(clear) rebinds the files to the new id.
    P.pendingNewChat = { id, text, queuedAt }
    void $.command
      .run({ command: 'clear', args: '' })
      .catch((err: unknown) => writeAck($, P, { id, status: 'failed', queuedAt, error: String(err) }))
    return
  }
  submit($, P, id, text, queuedAt)
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
    await readInbox($, P)
  } catch {
    // a failed tick is retried by the next one
  } finally {
    P.isPolling = false
  }
}

async function makeDirs($: EngineInterface, base: string) {
  // 0700 on the shared folder; $.fs.write would make it with the umask.
  const dirs = [base, `${base}/sessions`, `${base}/inbox`, `${base}/acks`]
  await $.process.run(['mkdir', '-p', '-m', '700', ...dirs]).catch(() => undefined)
  await $.process.run(['chmod', '700', ...dirs]).catch(() => undefined)
}

async function readLastAck($: EngineInterface, ack: string) {
  try {
    const prev = JSON.parse(String(await $.fs.read(ack))) as { id?: unknown }
    return typeof prev.id === 'string' ? prev.id : null
  } catch {
    return null
  }
}

async function rebind($: EngineInterface, P: Pet) {
  // After /clear the process goes on under a new session id, without session.start.
  if (P.ctx === null) return
  const sid = await $.session.id()
  if (sid === P.ctx.sid) return
  const old = P.ctx.sid
  await note($, P, { status: 'ended' as Status, step: null, continuedAs: sid })
  P.ctx = { ...P.ctx, sid }
  const now = await $.clock.now()
  P.state = { ...P.state, sessionId: sid, status: 'ready', continuedFrom: old, continuedAs: null, title: null, step: null, doneAt: null, startedAt: now }
  P.lastAckedId = await readLastAck($, paths(P.ctx.base, sid).ack)
  await note($, P, {})
  const pending = P.pendingNewChat
  P.pendingNewChat = null
  if (pending === null) return
  // The ack goes to the new id's file; the old inbox file is the horse's to drop.
  P.lastAckedId = pending.id
  await writeAck($, P, { id: pending.id, status: 'queued', queuedAt: pending.queuedAt, from: old })
  submit($, P, pending.id, pending.text, pending.queuedAt)
}

async function start($: EngineInterface, P: Pet, isInteractive: boolean | null, cwd: string) {
  if (P.ctx !== null || P.isStarting) return
  P.isStarting = true
  try {
    const surfaces = await $.session.surfaces()
    // -p and headless SDK runs: no surface draws the session, the mod stays silent.
    // The desktop app drives the session through the SDK but attaches a surface.
    if (surfaces.length === 0 && isInteractive !== true) return
    const home = await $.env.get('HOME')
    if (home === undefined) return
    const base = `${home}/.claude-pet`
    const sid = await $.session.id()
    await makeDirs($, base)
    P.lastAckedId = await readLastAck($, paths(base, sid).ack)
    P.ctx = { base, sid, home }
    const now = await $.clock.now()
    Object.assign(P.state, {
      v: 1,
      sessionId: sid,
      cwd,
      project: fileName(cwd.replace(/[/\\]+$/, '')) || cwd,
      title: null,
      status: 'ready' as Status,
      step: null,
      startedAt: now,
      pulseAt: now,
      doneAt: null,
      continuedFrom: null,
      continuedAs: null,
    })
    await note($, P, {})
    await $.command.register({ name: 'horse', description: 'Позвать лошадку: окно с строкой ввода' }).catch(() => undefined)
    $.clock.every(POLL_MS, () => void poll($, P))
    await launchOverlay($, P)
  } finally {
    P.isStarting = false
  }
}

const isMain = (e: unknown) => (e as { agentId?: string }).agentId === undefined

export const register: Register = on => {
  const P: Pet = {
    ctx: null,
    isStarting: false,
    isPolling: false,
    lastAckedId: null,
    ticks: 0,
    launchedAt: -Infinity,
    writing: Promise.resolve(),
    pendingNewChat: null,
    turnId: null,
    state: {},
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await start($, P, e.isInteractive, e.cwd)
    return r
  })

  on('turn.start', async ($, e, next) => {
    // After a hot reload no session.start comes: start from the first turn.
    if (P.ctx === null) await start($, P, null, await $.session.cwd())
    if (isMain(e)) P.turnId = e.turnId
    if (P.ctx !== null && isMain(e)) {
      const fresh = e.text !== '' && !e.text.startsWith('<bash-')
      const title = P.state.title ?? (fresh ? titleFrom(e.text) : null)
      void note($, P, { status: 'running' as Status, step: 'Размышление…', title })
      void launchOverlay($, P)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (isMain(e)) P.turnId = null
    if (P.ctx !== null && isMain(e)) {
      const now = await $.clock.now()
      const patch =
        e.reason === 'error' || e.reason === 'refusal'
          ? { status: 'blocked' as Status }
          : e.reason === 'aborted'
            ? { status: 'ready' as Status, stoppedAt: now }
            : { status: 'ready' as Status, doneAt: now }
      void note($, P, { ...patch, step: null })
    }
    return next(e)
  })

  on('command.run', { command: 'horse' }, async $ => ({ text: await summon($, P) }))

  on('tool.call', async ($, e, next) => {
    if (P.ctx === null || !isMain(e)) return next(e)
    void note($, P, { status: 'running' as Status, step: stepFor(e as unknown as Record<string, unknown>) })
    const r = await next(e)
    if (P.state.status === 'needs-input') void note($, P, { status: 'running' as Status })
    return r
  })

  on('tool.check', async ($, e, next) => {
    // Read the verdict, never change it. classic.Notification does not reach a
    // mod under managed settings, so `ask` is the only sign of a permission dialog.
    const verdict = await next(e)
    if (P.ctx !== null && isMain(e) && verdict.decision === 'ask') {
      void note($, P, { status: 'needs-input' as Status, step: 'Ждёт вашего ответа' })
    }
    return verdict
  })

  on('session.end', async ($, e, next) => {
    if (P.ctx !== null) await note($, P, { status: 'ended' as Status, step: null })
    if (P.ctx !== null && e.reason === 'clear') $.clock.after(300, () => void rebind($, P))
    return next(e)
  })
}
