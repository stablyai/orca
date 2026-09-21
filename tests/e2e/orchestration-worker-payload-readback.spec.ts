import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'

// Why: a coordinator that reads a worker's transcript over the wire only ever
// saw a clipped head of any large tool output, and nothing in the clip said
// where the rest was. This proves, against the packaged runtime, that the
// clipped block now names a retrievable digest, that the owning dispatch can
// fetch the complete text through `orchestration.workerPayloadRead`, and that
// another dispatch is refused the same digest.

const SENTINEL = 'CONSTRAINT-C: the non-negotiable that lived past the clip'
const FILLER_BYTES = 48 * 1024

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-worker-payload-readback-'))
const configPath = path.join(fakeCliDir, 'claude-config.json')

/** A stand-in `claude` binary that reports a provider session through the hook
 *  and then idles, so the Dispatch has a transcript without the real CLI. */
function writeFakeClaude(): string {
  const source = `
const { readFileSync } = require('node:fs')
let hookSent = false
async function sendProviderHook() {
  if (hookSent) return
  hookSent = true
  const config = JSON.parse(readFileSync(${JSON.stringify(configPath)}, 'utf8'))
  await fetch('http://127.0.0.1:' + process.env.ORCA_AGENT_HOOK_PORT + '/hook/claude', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': process.env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: process.env.ORCA_PANE_KEY,
      tabId: process.env.ORCA_TAB_ID,
      worktreeId: process.env.ORCA_WORKTREE_ID,
      launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
      env: process.env.ORCA_AGENT_HOOK_ENV,
      version: process.env.ORCA_AGENT_HOOK_VERSION,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: config.sessionId,
        transcript_path: config.transcriptPath,
        prompt: 'Read the large tool output'
      }
    })
  })
}
process.stdout.write('\\u001b]0;\u2733 Claude Code\\u0007')
process.stdin.on('data', (chunk) => {
  if (/--dispatch-capability dcap_/.test(chunk.toString())) {
    void sendProviderHook()
  }
})
process.stdin.resume()
setInterval(() => {}, 60_000)
`
  const executable = path.join(fakeCliDir, process.platform === 'win32' ? 'claude.cmd' : 'claude')
  if (process.platform === 'win32') {
    writeFileSync(path.join(fakeCliDir, 'claude.js'), source)
    writeFileSync(executable, `@echo off\r\nnode "%~dp0\\claude.js" %*\r\n`)
  } else {
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
    chmodSync(executable, 0o755)
  }
  return buildFakeAgentCommandOverride(executable)
}

/** Output long enough that the sentinel lands past the transcript clip. */
function largeToolOutput(): string {
  const lines: string[] = []
  let index = 0
  while (lines.join('\n').length < FILLER_BYTES) {
    lines.push(`line ${index++}: ordinary output that pushes the constraint past the head`)
  }
  return `${lines.join('\n')}\n${SENTINEL}\nEND OF ARTIFACT`
}

function transcript(sessionId: string, output: string): string {
  return `${[
    {
      type: 'user',
      uuid: `${sessionId}-user-1`,
      timestamp: '2026-09-19T10:00:00.000Z',
      sessionId,
      message: { role: 'user', content: [{ type: 'text', text: 'Read the large tool output' }] }
    },
    {
      type: 'assistant',
      uuid: `${sessionId}-assistant-1`,
      timestamp: '2026-09-19T10:00:01.000Z',
      sessionId,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat artifact.md' } }]
      }
    },
    {
      type: 'user',
      uuid: `${sessionId}-user-2`,
      timestamp: '2026-09-19T10:00:02.000Z',
      sessionId,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: output }]
      }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`
}

const claudeCommand = writeFakeClaude()

const test = base.extend({
  launchEnv: [{ PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}` }, { option: true }]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

type ClippedBlock = {
  type: string
  output?: string
  clipped?: { digest: string; byteLength: number; retrievable: boolean }
}

type WorkerRead = {
  source: string
  fallbackReason?: string | null
  transcript?: { messages: { blocks: ClippedBlock[] }[] }
}

type PayloadRead = {
  digest: string
  byteLength: number
  chunk: string
  chunkOffset: number
  chunkByteLength: number
  complete: boolean
  dispatchId: string
}

/** Creates a task and starts a supervised worker on it, returning both ids the
 *  payload read needs. */
async function startWorker(
  client: RuntimeClient,
  args: { run: string; coordinatorHandle: string; spec: string }
): Promise<{ taskId: string; dispatchId: string }> {
  const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
    spec: args.spec,
    run: args.run,
    callerTerminalHandle: args.coordinatorHandle
  })
  const started = await client.call<{ dispatchId: string }>('orchestration.workerStart', {
    task: task.result.task.id,
    from: args.coordinatorHandle,
    agent: 'claude',
    timeoutMs: 30_000
  })
  return { taskId: task.result.task.id, dispatchId: started.result.dispatchId }
}

test('worker-read names a retrievable digest and the owning dispatch reads the whole payload', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    async ({ command, terminalWindowsShell }) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { claude: command },
        terminalWindowsShell,
        disabledTuiAgents: [],
        terminalHiddenViewParking: false
      })
    },
    { command: claudeCommand, terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL }
  )
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const coordinatorPane = await waitForActivePaneHookDescriptor(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: coordinatorPane.paneKey
  })
  const coordinatorHandle = coordinator.result.terminal.handle
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Worker payload readback regression',
    from: coordinatorHandle
  })

  const transcriptDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-claude-payload-'))
  const sessionId = 'e2e-claude-payload-session'
  const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)
  const output = largeToolOutput()
  mkdirSync(path.dirname(transcriptPath), { recursive: true })
  writeFileSync(transcriptPath, transcript(sessionId, output))
  writeFileSync(configPath, JSON.stringify({ sessionId, transcriptPath }))

  const owner = await startWorker(client, {
    run: run.result.run.id,
    coordinatorHandle,
    spec: 'Read the large tool output'
  })

  let read: { result: WorkerRead } | undefined
  await expect
    .poll(
      async () => {
        try {
          read = await client.call('orchestration.workerRead', {
            dispatch: owner.dispatchId,
            source: 'auto',
            limit: 10
          })
          return `${read.result.source}:${read.result.fallbackReason ?? 'none'}`
        } catch {
          return ''
        }
      },
      { timeout: 30_000, message: 'claude transcript never became readable' }
    )
    .toBe('transcript:none')

  const clipped = read?.result.transcript?.messages
    .flatMap((message) => message.blocks)
    .find((block) => block.type === 'tool-result' && block.clipped !== undefined)
  if (!clipped?.clipped) {
    throw new Error('the large tool result reached the coordinator without a clipped reference')
  }
  // The head is honest about being a head: it does not contain the sentinel,
  // and it says exactly how much there is and under which digest.
  expect(clipped.output ?? '').not.toContain(SENTINEL)
  expect(clipped.output ?? '').toContain(clipped.clipped.digest)
  expect(clipped.clipped).toMatchObject({
    byteLength: Buffer.byteLength(output, 'utf8'),
    retrievable: true
  })

  // The owning dispatch pages the complete text back.
  const digest = clipped.clipped.digest
  let assembled = ''
  let offset = 0
  for (;;) {
    const page = await client.call<PayloadRead>('orchestration.workerPayloadRead', {
      dispatch: owner.dispatchId,
      digest,
      offset,
      limit: 16 * 1024
    })
    expect(page.result.digest).toBe(digest)
    expect(page.result.chunkOffset).toBe(offset)
    assembled += page.result.chunk
    offset += page.result.chunkByteLength
    if (page.result.complete || page.result.chunkByteLength === 0) {
      break
    }
  }
  expect(assembled).toBe(output)
  expect(assembled).toContain(SENTINEL)

  // Another dispatch in the same run never referenced this digest and is refused.
  const stranger = await startWorker(client, {
    run: run.result.run.id,
    coordinatorHandle,
    spec: 'Unrelated worker'
  })
  await expect(
    client.call('orchestration.workerPayloadRead', {
      dispatch: stranger.dispatchId,
      digest,
      limit: 1024
    })
  ).rejects.toThrow(/payload_not_referenced|not referenced|not retained/)

  // Neither worker settles on its own (the fake CLI never sends worker_done),
  // so stop fences them before their terminals are released.
  for (const dispatch of [owner, stranger]) {
    await client.call('orchestration.workerStop', { dispatch: dispatch.dispatchId })
    await client.call('orchestration.workerRelease', { dispatch: dispatch.dispatchId })
  }
  rmSync(transcriptDir, { recursive: true, force: true })
})
