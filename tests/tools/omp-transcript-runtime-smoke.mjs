// Run with Bun and a read-only OMP checkout path as the first argument.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getPiAgentStatusExtensionSource } from '../../src/main/pi/agent-status-extension-source.ts'
import {
  extractAgentProviderSession,
  getAgentResumeArgv
} from '../../src/shared/agent-session-resume.ts'
import { readNativeChatTranscript } from '../../src/main/native-chat/transcript-reader.ts'

const reference = process.argv[2]
assert.ok(reference, 'Pass the read-only oh-my-pi source checkout path')
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-transcript-'))
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.OMP_CODING_AGENT_DIR = join(scratch, 'agent')
await mkdir(process.env.HOME, { recursive: true })
const source = (path) =>
  pathToFileURL(join(resolve(reference), 'packages/coding-agent/src', path)).href
const { loadExtensions } = await import(source('extensibility/extensions/loader.ts'))
const { EventBus } = await import(source('utils/event-bus.ts'))
const { SessionManager } = await import(source('session/session-manager.ts'))
const posts = []
const server = createServer(async (request, response) => {
  let body = ''
  for await (const chunk of request) {
    body += chunk
  }
  posts.push(JSON.parse(body).payload)
  response.writeHead(200).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const managers = []
const transcripts = []
try {
  process.env.ORCA_AGENT_HOOK_PORT = String(server.address().port)
  process.env.ORCA_AGENT_HOOK_TOKEN = 'test-token'
  delete process.env.ORCA_AGENT_HOOK_ENDPOINT
  delete process.env.ORCA_PI_STATUS_OWNED
  process.title = 'omp'
  for (const kind of ['omp', 'pi']) {
    process.env.ORCA_PANE_KEY = `transcript-${kind}`
    process.env.ORCA_AGENT_LAUNCH_TOKEN = `transcript-${kind}`
    const extensionPath = join(scratch, `${kind}-agent-status.ts`)
    await writeFile(extensionPath, getPiAgentStatusExtensionSource(kind))
    const load = async () => {
      const result = await loadExtensions([extensionPath], scratch, new EventBus())
      assert.deepEqual(result.errors, [])
      return result.extensions[0]
    }
    const root = SessionManager.create(scratch, join(scratch, `${kind}-custom-sessions`))
    const child = SessionManager.create(scratch, join(scratch, `${kind}-child-sessions`))
    managers.push(root, child)
    const emit = async (extension, type, manager) => {
      for (const handler of extension.handlers.get(type) ?? []) {
        await handler({ type }, { sessionManager: manager, hasUI: false })
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
    const extension = await load()
    await emit(extension, 'session_start', root)
    for (const phase of ['initial', 'new']) {
      if (phase === 'new') {
        await root.newSession()
      }
      assert.equal(root.isSessionOnDisk(), false)
      await emit(extension, 'agent_start', root)
      const session = extractAgentProviderSession('omp', posts.at(-1))
      assert.equal(session.transcriptPath, root.getSessionFile())
      assert.deepEqual(getAgentResumeArgv('omp', session), [
        'omp',
        '--resume',
        root.getSessionFile()
      ])
      const options = {
        transcriptPath: session.transcriptPath,
        ompSessionsDir: join(scratch, 'unused')
      }
      assert.equal((await readNativeChatTranscript('omp', session.id, options)).notFound, true)
      root.appendMessage({
        role: 'user',
        content: `Transcript proof ${kind} ${phase}`,
        timestamp: Date.now()
      })
      await root.ensureOnDisk()
      await root.flush()
      const transcript = await readNativeChatTranscript('omp', session.id, options)
      assert.ok('messages' in transcript, JSON.stringify(transcript))
      assert.equal(transcript.messages.length, 1)
      assert.ok(JSON.stringify(transcript.messages).includes(`Transcript proof ${kind} ${phase}`))
      transcripts.push({ kind, phase, sessionId: session.id, messages: transcript.messages })
      const beforeChild = posts.length
      const childExtension = await load()
      await emit(childExtension, 'session_start', child)
      await emit(childExtension, 'agent_start', child)
      await emit(childExtension, 'agent_end', child)
      assert.equal(posts.length, beforeChild)
    }
  }
  if (process.argv[3]) {
    await writeFile(resolve(process.argv[3]), `${JSON.stringify({ transcripts }, null, 2)}\n`)
  }
  console.log(
    JSON.stringify({
      platform: process.platform,
      producers: ['omp', 'pi'],
      reports: posts.length,
      proof:
        'Actual OMP loader and persistent SessionManager, custom directory, lazy creation, new-session switch, HTTP metadata, Orca transcript reader, child suppression',
      modelCalls: 0,
      rendered: false
    })
  )
} finally {
  for (const manager of managers) {
    await manager.close()
  }
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(scratch, { recursive: true, force: true })
}
