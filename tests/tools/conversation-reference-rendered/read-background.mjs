import { forkProcess } from '@orca/process-host/fork-process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import assert from 'node:assert/strict'

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1')
const directory = await mkdtemp(join(tmpdir(), 'orca-conversation-service-'))
const sessionId = '12345678-1234-4234-8234-123456789abc'
const filePath = join(directory, `${sessionId}.jsonl`)
const original = 'source conversation '.repeat(18000)
await writeFile(
  filePath,
  `${JSON.stringify({ role: 'user', content: original })}\n${JSON.stringify({ role: 'assistant', content: 'needle in source reply' })}\n`
)
const child = forkProcess({
  modulePath: join(process.cwd(), 'out/main/session-scanner-service-entry.js'),
  execPath: process.execPath,
  env: process.env,
  stdio: ['ignore', 'ignore', 'pipe', 'ipc']
})
let id = 0
const pending = new Map()
child.on('message', (message) => {
  if (message.type === 'result' || message.type === 'error') {
    const request = pending.get(message.id)
    if (request) {
      pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.type === 'error') {
        request.reject(new Error(message.message))
      } else {
        request.resolve(message.value)
      }
    }
  }
})
const read = (query, cursor) =>
  new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(
      () => reject(new Error('Background conversation read timed out')),
      30000
    )
    pending.set(requestId, { resolve, reject, timer })
    child.send({
      type: 'request',
      id: requestId,
      operation: 'conversationRead',
      request: {
        id: sessionId,
        source: { kind: 'transcript', agent: 'cursor', sessionId, filePath },
        request: {
          reference: `orca-conversation://reference/${sessionId}?host=local`,
          ...(query ? { query } : {}),
          ...(cursor ? { cursor } : {})
        }
      }
    })
  })
try {
  const ready = once(child, 'message')
  child.send({ type: 'init', protocol: 1, sessionParseCache: null, sessionSearch: null })
  assert.equal((await ready)[0].type, 'ready')
  const text = []
  let cursor
  do {
    const page = await read(undefined, cursor)
    text.push(...page.messages.map((message) => message.text))
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(text.join(''), `${original}needle in source reply`)
  const found = await read('needle')
  assert.deepEqual(
    found.messages.map((message) => message.text),
    ['needle in source reply']
  )
  console.log(
    'PASS: compiled background service reads a long source without an index and searches only the referenced conversation'
  )
} finally {
  const exited = once(child, 'exit')
  child.send({ type: 'shutdown' })
  await exited
  await rm(directory, { recursive: true, force: true })
}
