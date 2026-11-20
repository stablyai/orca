// Deterministic OMP ACP child for auxiliary-chat E2E: writes OMP v3 session files, streams
// a held parent reply, and logs provider-visible prompts/loads under the isolated account home.
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const logPath = process.argv[2]
const accountHome =
  process.env.PI_CODING_AGENT_DIR?.trim() ||
  path.join(process.env.HOME || os.homedir(), '.omp', 'agent')
const sessionsRoot = path.join(accountHome, 'sessions')
const eventsPath = logPath || path.join(accountHome, 'e2e-omp-acp-events.jsonl')

fs.mkdirSync(accountHome, { recursive: true })
function event(entry) {
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({ pid: process.pid, at: Date.now(), ...entry })}\n`
  )
}

const args = process.argv.slice(3)
event({ kind: 'launch', args, accountHome })

if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write('19.0.0\n')
  process.exit(0)
}

function write(frame) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
}
function reply(id, result) {
  write({ id, result })
}
function notify(method, params) {
  write({ method, params })
}
function fail(id, code, message) {
  write({ id, error: { code, message } })
}

const E2E_MODEL_ID = 'anthropic/claude-e2e'
const sessionModels = () => ({
  availableModels: [{ modelId: E2E_MODEL_ID, name: 'E2E model' }],
  currentModelId: E2E_MODEL_ID
})
const isoStamp = () => new Date().toISOString()
const fileSafeTimestamp = () => isoStamp().replace(/[:.]/g, '-')
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((block) => (block?.type === 'text' ? [block.text] : [])).join('')
      : ''

function canonicalPath(value) {
  try {
    return fs.realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}
function relativeBucket(root, cwd, prefix) {
  const relative = path.relative(root, cwd)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  const encoded = relative.replace(/[/\\:]/g, '-')
  return encoded ? `${prefix}-${encoded}` : prefix
}
function launchTempDir(env) {
  return env.TMPDIR || env.TMP || env.TEMP || '/tmp'
}
// Mirrors src/main/omp/omp-session-cwd-lookup.ts: host lookup picks any of these cwd buckets.
function cwdBuckets(cwd) {
  const env = process.env
  const canonicalCwd = canonicalPath(cwd)
  const canonicalHome = canonicalPath(env.HOME || os.homedir())
  const canonicalTemp = canonicalPath(launchTempDir(env))
  const homeBucket = relativeBucket(canonicalHome, canonicalCwd, '-')
  const tempBucket = relativeBucket(canonicalTemp, canonicalCwd, '-tmp')
  const encode = (value) => {
    const trimmed = value.length > 1 ? value.replace(/[/\\]+$/, '') : value
    return `--${trimmed.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}`
  }
  const legacy = [cwd, canonicalCwd].flatMap((value) =>
    [encode(value.normalize('NFC')), encode(value)].map((prefix) => `${prefix}--`)
  )
  const scope = tempBucket !== null ? 'tmp' : homeBucket !== null ? 'home' : 'abs'
  const readable = path
    .basename(canonicalCwd)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(-80)
  const digest = createHash('sha256').update(canonicalCwd.replaceAll('\\', '/')).digest('hex')
  return [
    ...new Set([tempBucket, homeBucket, ...legacy, `${scope}-${readable || 'project'}-${digest}`])
  ].filter((name) => name !== null)
}

const sessions = new Map()
const pendingPrompts = new Map()

function messageText(message) {
  return textOf(message?.content)
}
function userEntry(text, timestamp = Date.now()) {
  return {
    type: 'message',
    id: randomUUID(),
    parentId: null,
    timestamp: isoStamp(),
    message: { role: 'user', content: text, timestamp }
  }
}
function assistantEntry(text, timestamp = Date.now()) {
  return {
    type: 'message',
    id: randomUUID(),
    parentId: null,
    timestamp: isoStamp(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic',
      provider: 'anthropic',
      model: 'claude-e2e-stub',
      usage: { input: 12, output: 8, totalTokens: 20, cacheRead: 0, cacheWrite: 0 },
      stopReason: 'end_turn',
      timestamp
    }
  }
}

function sessionFilesFor(cwd, sessionId) {
  const name = `${fileSafeTimestamp()}_${sessionId}.jsonl`
  return [
    ...cwdBuckets(cwd).map((bucket) => path.join(sessionsRoot, bucket, name)),
    path.join(sessionsRoot, name)
  ]
}
function createSession(cwd, sessionId) {
  const files = sessionFilesFor(cwd, sessionId)
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: sessionId,
    timestamp: isoStamp(),
    cwd
  })
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${header}\n`)
  }
  const state = { id: sessionId, cwd, files, lastId: null, entries: [] }
  sessions.set(sessionId, state)
  event({ kind: 'session/new', sessionId, filePath: files[0], fileCount: files.length })
  return state
}
function appendEntry(state, entry) {
  entry.parentId = state.lastId
  state.lastId = entry.id
  state.entries.push(entry)
  for (const file of state.files) {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
  }
  return entry
}
function findSessionFile(sessionId) {
  const stack = [sessionsRoot]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.jsonl') {
        continue
      }
      const stem = path.basename(entry.name, '.jsonl')
      if (stem === sessionId || stem.endsWith(`_${sessionId}`)) {
        return full
      }
    }
  }
  return null
}
function readLoadContext(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    let header = null
    const messages = []
    const customTypes = []
    for (const line of lines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (!header && entry.type === 'session') {
        header = entry
        continue
      }
      if (entry.type === 'message') {
        messages.push({ role: entry.message?.role ?? null, text: messageText(entry.message) })
      } else if (entry.type === 'custom_message') {
        customTypes.push(entry.customType)
        if (entry.display !== false) {
          messages.push({ role: 'custom', text: textOf(entry.content) })
        }
      }
    }
    return { header, messages, customTypes }
  } catch (error) {
    return { error: String(error) }
  }
}

function startPrompt(frame, text) {
  const sessionId = frame.params?.sessionId
  const state = sessions.get(sessionId)
  const prompt = text.trim()
  event({ kind: 'prompt', sessionId, text: prompt, params: frame.params })
  if (state) {
    appendEntry(state, userEntry(prompt))
  }
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } }
  })
  const answer = (replyText) => {
    pendingPrompts.delete(frame.id)
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replyText } }
    })
    reply(frame.id, { stopReason: 'end_turn' })
  }
  pendingPrompts.set(frame.id, { sessionId, answer })
  if (prompt.includes('PARENT-WARMUP')) {
    setTimeout(() => {
      if (state) {
        appendEntry(state, assistantEntry('PARENT-STABLE-REPLY'))
      }
      answer('PARENT-STABLE-REPLY')
    }, 120)
    return
  }
  if (prompt.includes('SLOW-PARENT')) {
    setTimeout(() => {
      if (!pendingPrompts.has(frame.id)) {
        return
      }
      // A working parent file records the optimistic assistant row; the snapshot keeps only the user.
      if (state) {
        appendEntry(state, assistantEntry('PARENT-UNFINISHED-DELTA'))
      }
      for (const chunk of ['PARENT-STREAM-', 'SELECTED FIRST ', 'PARENT-SECOND-SELECTED']) {
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } }
        })
      }
    }, 60)
    return
  }
  if (prompt.includes('SLOW-CHILD')) {
    setTimeout(
      () =>
        notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'CHILD-WORKING' }
          }
        }),
      40
    )
    return
  }
  setTimeout(() => answer('Stub child reply.'), 80)
}

function onRequest(frame) {
  const method = frame.method
  event({ kind: 'request', id: frame.id, method, params: frame.params })
  if (method === 'initialize') {
    reply(frame.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      agentInfo: { name: 'OMP E2E stub', version: '19.0.0' }
    })
    return
  }
  if (method === 'authenticate') {
    reply(frame.id, {})
    return
  }
  if (method === 'session/new') {
    const state = createSession(frame.params?.cwd, randomUUID())
    reply(frame.id, { sessionId: state.id, models: sessionModels() })
    return
  }
  if (method === 'session/load') {
    const sessionId = frame.params?.sessionId
    const filePath = findSessionFile(sessionId)
    const context = filePath ? readLoadContext(filePath) : null
    event({ kind: 'session/load', sessionId, filePath, context })
    sessions.set(sessionId, {
      id: sessionId,
      cwd: frame.params?.cwd,
      files: [],
      lastId: null,
      entries: []
    })
    reply(frame.id, { models: sessionModels() })
    return
  }
  if (method === 'session/prompt') {
    startPrompt(frame, textOf(frame.params?.prompt) || '')
    return
  }
  if (method === 'session/set_config_option') {
    reply(frame.id, { configOptions: [] })
    return
  }
  if (method === 'session/set_model' || method === 'session/set_mode') {
    reply(frame.id, {})
    return
  }
  if (method.startsWith('_')) {
    fail(frame.id, -32601, `Unknown ACP extension: ${method}`)
    return
  }
  reply(frame.id, {})
}

function onNotification(frame) {
  event({ kind: 'notification', method: frame.method, params: frame.params })
  if (frame.method !== 'session/cancel') {
    return
  }
  const sessionId = frame.params?.sessionId
  for (const [id, pending] of pendingPrompts) {
    if (pending.sessionId !== sessionId) {
      continue
    }
    pendingPrompts.delete(id)
    event({ kind: 'cancelled', sessionId, promptId: id })
    reply(id, { stopReason: 'cancelled' })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) {
      continue
    }
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      event({ kind: 'garbled', line: line.slice(0, 500) })
      continue
    }
    if (frame.method && frame.id !== undefined) {
      onRequest(frame)
    } else if (frame.method) {
      onNotification(frame)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
