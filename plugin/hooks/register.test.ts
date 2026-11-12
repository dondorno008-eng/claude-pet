import { expect, mock, test } from 'claude-code/testing'

const OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

function world(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, string>) {
  const writes: string[] = []
  const submits: unknown[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('env.get', () => ({ value: '/h' }))
  on('process.run', () => ({ value: OK }))
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
  return { writes, submits }
}

test('a -p run writes nothing', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>([['/h/.claude-pet/inbox/S1.json', '{"id":"m1","text":"hi"}']])
  const w = world(on, files)
  await $.session.start({ cwd: '/p', surface: null, isInteractive: false })
  await clock.advance(3000)
  expect(w.writes).toEqual([])
  expect(w.submits).toEqual([])
})

test('an inbox message is submitted once, as the user, and acked', async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const w = world(on, files)
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files.get('/h/.claude-pet/sessions/S1.json') ?? '{}').status).toBe('ready')

  files.set('/h/.claude-pet/inbox/S1.json', '{"id":"m1","text":"hi"}')
  await clock.advance(3500)
  expect(w.submits.length).toBe(1)
  expect(JSON.parse(files.get('/h/.claude-pet/acks/S1.json') ?? '{}').id).toBe('m1')

  files.set('/h/.claude-pet/inbox/S1.json', '{"id":"m2","text":"again"}')
  await clock.advance(1500)
  expect(w.submits.length).toBe(2)
})

test('a tool call becomes the current step', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  world(on, files)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/p/docs/safety.md' })
  expect(JSON.parse(files.get('/h/.claude-pet/sessions/S1.json') ?? '{}').step).toBe('Чтение safety.md')
})
