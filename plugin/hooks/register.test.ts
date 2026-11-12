import { expect, mock, test } from 'claude-code/testing'

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const SESSION = '/h/.claude-pet/sessions/S1.json'
const read = (files: Map<string, string>, p: string) => JSON.parse(files.get(p) ?? '{}')

function world(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>, surfaces = ['desktop']) {
  const writes: string[] = []
  const submits: unknown[] = []
  const runs: string[][] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: OK }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.write', (_, e) => {
    writes.push(e.path)
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    submits.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  return { writes, submits, runs }
}

test('a -p run writes nothing', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>([['/h/.claude-pet/inbox/S1.json', '{"id":"m1","text":"hi"}']])
  const w = world(on, files, [])
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(3000)
  expect(w.writes).toEqual([])
  expect(w.submits).toEqual([])
})

test('a session file follows the protocol, and the horse app is launched', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>([['/h/Applications/HorsePet.app', '']])
  const w = world(on, files)
  await $.session.start({ cwd: '/Users/n/news/', surface: null, isInteractive: false })
  const s = read(files, SESSION)
  expect(s.v).toBe(1)
  expect(s.status).toBe('ready')
  expect(s.project).toBe('news')
  expect(w.runs.some(a => a[0] === 'open' && a[2] === '/h/Applications/HorsePet.app')).toBe(true)
})

test('an inbox message is submitted once, as the user, and acked', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const w = world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  files.set('/h/.claude-pet/inbox/S1.json', '{"v":1,"id":"m1","text":"hi","newChat":false}')
  await clock.advance(3500)
  expect(w.submits.length).toBe(1)
  const ack = read(files, '/h/.claude-pet/acks/S1.json')
  expect(ack.id).toBe('m1')
  expect(ack.v).toBe(1)

  files.set('/h/.claude-pet/inbox/S1.json', '{"v":1,"id":"m2","text":"again"}')
  await clock.advance(1500)
  expect(w.submits.length).toBe(2)
})

test('tool calls become the current step', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  world(on, files)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/p/docs/safety.md' })
  expect(read(files, SESSION).step).toBe('Чтение safety.md')
  await $.tool.call({ tool: 'Bash', command: 'grep -rn horse plugin' })
  expect(read(files, SESSION).step).toBe('Ищет в проекте…')
  await $.tool.call({ tool: 'Bash', command: 'echo hi' })
  expect(read(files, SESSION).step).toBe('Выполняет команду…')
})
