import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../src/shared/runtime-types'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from './helpers/fake-agent-command-override'

type TranscriptProvider = 'claude' | 'grok' | 'omp'

const PROVIDERS: readonly {
  agent: TranscriptProvider
  title: string
  first: string
  second: string
  third: string
  transcript: (sessionId: string, first: string, second: string, third: string) => string
}[] = [
  {
    agent: 'claude',
    title: '✳ Claude Code',
    first: 'Claude transcript first',
    second: 'Claude transcript second',
    third: 'Claude transcript after cursor',
    transcript: (sessionId, first, second, third) =>
      `${[
        {
          type: 'user',
          uuid: `${sessionId}-user-1`,
          message: { content: [{ type: 'text', text: first }] }
        },
        {
          type: 'assistant',
          uuid: `${sessionId}-assistant-1`,
          message: { content: [{ type: 'text', text: second }] }
        },
        {
          type: 'assistant',
          uuid: `${sessionId}-assistant-2`,
          message: { content: [{ type: 'text', text: third }] }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
  },
  {
    agent: 'grok',
    title: 'Grok ready',
    first: 'Grok transcript first',
    second: 'Grok transcript second',
    third: 'Grok transcript after cursor',
    transcript: (sessionId, first, second, third) =>
      `${[
        { id: `${sessionId}-assistant-1`, type: 'assistant', content: first },
        { id: `${sessionId}-assistant-2`, type: 'assistant', content: second },
        { id: `${sessionId}-assistant-3`, type: 'assistant', content: third }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
  },
  {
    agent: 'omp',
    title: 'OMP ready',
    first: 'OMP transcript first',
    second: 'OMP transcript second',
    third: 'OMP transcript after cursor',
    transcript: (sessionId, first, second, third) =>
      `${[
        {
          type: 'message',
          id: `${sessionId}-user-1`,
          message: { role: 'user', content: [{ type: 'text', text: first }] }
        },
        {
          type: 'message',
          id: `${sessionId}-assistant-1`,
          message: { role: 'assistant', content: [{ type: 'text', text: second }] }
        },
        {
          type: 'message',
          id: `${sessionId}-assistant-2`,
          message: { role: 'assistant', content: [{ type: 'text', text: third }] }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
  }
]

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-worker-transcript-providers-'))
const capabilityLedgerPath = path.join(fakeCliDir, 'capabilities.jsonl')
const fakeGrokHome = path.join(fakeCliDir, 'grok-home')
const fakeOmpHome = path.join(fakeCliDir, 'omp-home')

function writeFakeProvider(agent: TranscriptProvider, title: string): string {
  const configPath = path.join(fakeCliDir, `${agent}-config.json`)
  const hookPath = `/hook/${agent}`
  const source = `
const { appendFileSync, readFileSync } = require('node:fs')
const ledger = ${JSON.stringify(capabilityLedgerPath)}
const configPath = ${JSON.stringify(configPath)}
let hookSent = false
async function sendProviderHook() {
  if (hookSent) return
  hookSent = true
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const payload = ${providerHookPayload(agent)}
  await fetch('http://127.0.0.1:' + process.env.ORCA_AGENT_HOOK_PORT + '${hookPath}', {
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
      payload
    })
  })
}
process.stdout.write('\\u001b]0;${title.replaceAll("'", "\\'")}\\u0007')
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const capability = input.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
  if (capability) {
    appendFileSync(ledger, JSON.stringify({ agent: '${agent}', capability }) + '\\n')
    void sendProviderHook()
  }
})
process.stdin.resume()
setInterval(() => {}, 60_000)
`
  const executable = path.join(fakeCliDir, process.platform === 'win32' ? `${agent}.cmd` : agent)
  if (process.platform === 'win32') {
    writeFileSync(path.join(fakeCliDir, `${agent}.js`), source)
    writeFileSync(executable, `@echo off\r\nnode "%~dp0\\${agent}.js" %*\r\n`)
  } else {
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`)
    chmodSync(executable, 0o755)
  }
  return buildFakeAgentCommandOverride(executable)
}

function providerHookPayload(agent: TranscriptProvider): string {
  if (agent === 'claude') {
    return "({ hook_event_name: 'UserPromptSubmit', session_id: config.sessionId, transcript_path: config.transcriptPath, prompt: 'Read the provider transcript' })"
  }
  if (agent === 'grok') {
    return "({ hook_event_name: 'user_prompt_submit', sessionId: config.sessionId, cwd: config.cwd, grokHome: config.grokHome, prompt: 'Read the provider transcript' })"
  }
  return "({ hook_event_name: 'before_agent_start', session_id: config.sessionId, session_file: config.transcriptPath, prompt: 'Read the provider transcript' })"
}

const agentCommands = Object.fromEntries(
  PROVIDERS.map(({ agent, title }) => [agent, writeFakeProvider(agent, title)])
) as Partial<Record<TranscriptProvider, string>>

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      GROK_HOME: fakeGrokHome,
      OMP_CODING_AGENT_DIR: fakeOmpHome
    },
    { option: true }
  ]
})

test.afterAll(() => {
  rmSync(fakeCliDir, { recursive: true, force: true })
})

function readCapabilities(): { agent: TranscriptProvider; capability: string }[] {
  if (!existsSync(capabilityLedgerPath)) {
    return []
  }
  return readFileSync(capabilityLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { agent: TranscriptProvider; capability: string })
}

async function listWorker(client: RuntimeClient, handle: string): Promise<RuntimeTerminalSummary> {
  const terminals = await client.call<RuntimeTerminalListResult>('terminal.list')
  const worker = terminals.result.terminals.find((terminal) => terminal.handle === handle)
  if (!worker) {
    throw new Error(`Worker terminal ${handle} was not runtime-visible`)
  }
  return worker
}

test('worker-read uses provider transcripts across supported orchestration agents', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(240_000)
  rmSync(capabilityLedgerPath, { force: true })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(
    async ({ commands, terminalWindowsShell }) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: commands,
        terminalWindowsShell,
        disabledTuiAgents: [],
        terminalHiddenViewParking: false
      })
    },
    { commands: agentCommands, terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL }
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
  const coordinatorSummary = await listWorker(client, coordinatorHandle)
  const coordinatorTerminal = await client.call<{ terminal: { worktreeId: string } }>(
    'terminal.show',
    { terminal: coordinatorHandle }
  )
  let coordinatorWorktreePath = coordinatorSummary.worktreePath
  await expect
    .poll(async () => {
      const listed = await client.call<{ worktrees: { id: string; path: string }[] }>(
        'worktree.list',
        {}
      )
      const worktree = listed.result.worktrees.find(
        (candidate) => candidate.id === coordinatorTerminal.result.terminal.worktreeId
      )
      if (worktree?.path) {
        coordinatorWorktreePath = worktree.path
      }
      return Boolean(worktree)
    })
    .toBe(true)
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Provider transcript worker-read regression',
    from: coordinatorHandle
  })

  for (const provider of PROVIDERS) {
    const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: `Read the ${provider.agent} provider transcript`,
      run: run.result.run.id,
      callerTerminalHandle: coordinatorHandle
    })
    const transcriptDir = mkdtempSync(
      path.join(os.tmpdir(), `orca-e2e-${provider.agent}-transcript-`)
    )
    const sessionId = `e2e-${provider.agent}-session`
    const transcriptPath =
      provider.agent === 'grok'
        ? path.join(
            fakeGrokHome,
            'sessions',
            encodeURIComponent(coordinatorWorktreePath),
            sessionId,
            'chat_history.jsonl'
          )
        : provider.agent === 'omp'
          ? path.join(fakeOmpHome, 'workspace', `2026-08-30T00-00-00_${sessionId}.jsonl`)
          : path.join(transcriptDir, `${provider.agent}-session.jsonl`)
    const initialTranscript = provider
      .transcript(sessionId, provider.first, provider.second, provider.third)
      .split('\n')
      .filter(Boolean)
    // The initial file intentionally stops before the cursor continuation row.
    mkdirSync(path.dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, `${initialTranscript.slice(0, 2).join('\n')}\n`)
    // The fake CLI reads this after receiving the injected preamble, so the hook
    // is emitted through the same authenticated path as a real provider hook.
    writeFileSync(
      path.join(fakeCliDir, `${provider.agent}-config.json`),
      JSON.stringify({
        sessionId,
        transcriptPath,
        ...(provider.agent === 'grok'
          ? { cwd: coordinatorWorktreePath, grokHome: fakeGrokHome }
          : {})
      })
    )
    const started = await client.call<{
      dispatchId: string
      effects: { kind: string; role?: string; id?: string }[]
    }>('orchestration.workerStart', {
      task: task.result.task.id,
      from: coordinatorHandle,
      agent: provider.agent,
      timeoutMs: 30_000
    })
    const workerHandle = started.result.effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )?.id
    if (!workerHandle) {
      throw new Error(`${provider.agent} worker-start returned no agent terminal`)
    }
    const worker = await listWorker(client, workerHandle)

    type WorkerRead = {
      source: string
      fallbackReason?: string | null
      provider?: string
      cursor?: string
      transcript?: { messages: { blocks: { type: string; text?: string }[] }[] }
    }
    let firstRead: { result: WorkerRead } | undefined
    await expect
      .poll(
        async () => {
          try {
            firstRead = await client.call('orchestration.workerRead', {
              dispatch: started.result.dispatchId,
              source: 'auto',
              limit: 10
            })
            return `${firstRead.result.source}:${firstRead.result.fallbackReason ?? 'none'}`
          } catch {
            return ''
          }
        },
        { timeout: 30_000, message: `${provider.agent} transcript never became readable` }
      )
      .toBe('transcript:none')
    expect(firstRead?.result.provider).toBe(provider.agent)
    expect(firstRead?.result.transcript?.messages).toHaveLength(2)

    appendFileSync(transcriptPath, `${initialTranscript[2]}\n`)
    const continuation = await client.call<{
      source: string
      transcript: { messages: { blocks: { text?: string }[] }[] }
    }>('orchestration.workerRead', {
      dispatch: started.result.dispatchId,
      cursor: firstRead?.result.cursor,
      limit: 10
    })
    expect(continuation.result.source).toBe('transcript')
    expect(
      continuation.result.transcript.messages.map((message) =>
        message.blocks.map((block) => block.text).filter(Boolean)
      )
    ).toEqual([[provider.third]])

    await expect
      .poll(() => readCapabilities().find((entry) => entry.agent === provider.agent))
      .toBeTruthy()
    const capability = readCapabilities().find(
      (entry) => entry.agent === provider.agent
    )?.capability
    if (!capability) {
      throw new Error(`${provider.agent} worker did not receive a dispatch capability`)
    }
    await client.call(
      'orchestration.send',
      {
        from: worker.handle,
        subject: 'Completed',
        body: `The ${provider.agent} transcript read passed. Nothing remains.`,
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.result.task.id,
          dispatchId: started.result.dispatchId,
          outcome: 'succeeded'
        })
      },
      { orchestrationCapability: capability }
    )
    await expect
      .poll(async () => {
        const dispatch = await client.call<{ dispatch: { status: string } | null }>(
          'orchestration.dispatchShow',
          { task: task.result.task.id }
        )
        return dispatch.result.dispatch?.status
      })
      .toBe('completed')

    const release = await client.call<{ state: string }>('orchestration.workerRelease', {
      dispatch: started.result.dispatchId
    })
    expect(release.result.state).toBe('released')
    const archived = await client.call<{
      source: string
      provider?: string
      archived?: boolean
      status: { liveness?: string }
      transcript: { messages: { blocks: { text?: string }[] }[] }
    }>('orchestration.workerRead', { dispatch: started.result.dispatchId, source: 'auto' })
    expect(archived.result).toMatchObject({
      source: 'transcript',
      provider: provider.agent,
      archived: true,
      status: { liveness: 'exited' }
    })
    expect(
      archived.result.transcript.messages.map((message) =>
        message.blocks.map((block) => block.text).filter(Boolean)
      )
    ).toEqual([[provider.first], [provider.second], [provider.third]])
    rmSync(transcriptDir, { recursive: true, force: true })
  }
})
