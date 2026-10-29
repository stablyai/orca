import { readPersistedProfileState } from './persisted-profile-state'
import { execFileSync } from 'node:child_process'
import {
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
import type { RuntimeClient } from '../../../src/cli/runtime-client'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../src/shared/runtime-types'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'
import { FAKE_CODEX_LAUNCH_PROBES_SOURCE } from './fake-codex-launch-probes'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-retired-worker-'))
const recoveryConfigPath = path.join(fakeCliDir, 'recovery-config.json')
const lifecycleLedgerPath = path.join(fakeCliDir, 'codex-lifecycle.jsonl')
export const completedWorkerFakeCodexCommand = buildFakeAgentCommandOverride(
  path.join(fakeCliDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
)
const fakeCodexSource = `
const { appendFileSync, readFileSync } = require('node:fs')
const ledger = process.env.ORCA_E2E_CODEX_LIFECYCLE_LEDGER
const append = (event) => appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...event }) + '\\n')
async function publishRecovery() {
  const config = JSON.parse(readFileSync(${JSON.stringify(recoveryConfigPath)}, 'utf8'))
  for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
    const response = await fetch('http://127.0.0.1:' + process.env.ORCA_AGENT_HOOK_PORT + '/hook/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': process.env.ORCA_AGENT_HOOK_TOKEN },
      body: JSON.stringify({
        paneKey: process.env.ORCA_PANE_KEY,
        tabId: process.env.ORCA_TAB_ID,
        worktreeId: process.env.ORCA_WORKTREE_ID,
        launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
        env: process.env.ORCA_AGENT_HOOK_ENV,
        version: process.env.ORCA_AGENT_HOOK_VERSION,
        payload: { hook_event_name, prompt: 'Report completion, then exit normally', ...config }
      })
    })
    if (response.status !== 204) throw new Error('Recovery hook rejected: ' + response.status)
  }
}
const args = process.argv.slice(2)
${FAKE_CODEX_LAUNCH_PROBES_SOURCE}
append({ event: 'spawn', args })
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const pasteEndScan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
  fakeAgentPasteEndTail = pasteEndScan.tail
  if (pasteEndScan.pasteEndOffset !== null) {
    process.stdout.write('\\x1b[?25h')
  }
  append({ event: 'input', input })
  if (input.includes('ORCA_E2E_PUBLISH_DONE')) {
    void publishRecovery().catch((error) => process.stderr.write(String(error)))
    return
  }
  if (input.includes('ORCA_E2E_EXIT_AFTER_DONE')) {
    append({ event: 'normal-exit' })
    process.exit(0)
  }
  fakeAgentMaybeAck(pasteEndScan, input, (mode) => {
    append({ event: 'ack', mode })
    const message = mode === 'bracketed' ? 'ACK' : 'PASTE_PROTOCOL_ERROR'
    process.stdout.write('\\u001b]0;Codex Working\\u0007' + message + '\\n')
    setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
  })
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60_000)
`

function installCompletedWorkerFakeCodex(): void {
  mkdirSync(fakeCliDir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(path.join(fakeCliDir, 'fake-codex.js'), fakeCodexSource)
    writeFileSync(
      path.join(fakeCliDir, 'codex.cmd'),
      '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n'
    )
  } else {
    const executable = path.join(fakeCliDir, 'codex')
    writeFileSync(executable, `#!/usr/bin/env node\n${fakeCodexSource}`)
    chmodSync(executable, 0o755)
  }
}

installCompletedWorkerFakeCodex()

export const completedWorkerLaunchEnv = {
  PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  ORCA_E2E_CODEX_LIFECYCLE_LEDGER: lifecycleLedgerPath
}

export type LifecycleEvent = {
  pid: number
  event: 'spawn' | 'input' | 'ack' | 'normal-exit'
  args?: string[]
  input?: string
  mode?: 'bracketed' | 'unbracketed'
}

export type TerminalIdentity = Pick<
  RuntimeTerminalSummary,
  'handle' | 'incarnationId' | 'leafId' | 'ptyId' | 'tabId' | 'worktreeId'
>

export function clearCompletedWorkerLedger(): void {
  // Another spec can clean up this cached fixture before the next test uses it.
  installCompletedWorkerFakeCodex()
  rmSync(lifecycleLedgerPath, { force: true })
}

export function cleanupCompletedWorkerFixture(): void {
  rmSync(fakeCliDir, { recursive: true, force: true })
}

export function readCompletedWorkerLedger(): LifecycleEvent[] {
  if (!existsSync(lifecycleLedgerPath)) {
    return []
  }
  const contents = readFileSync(lifecycleLedgerPath, 'utf8')
  const lastCompleteLine = contents.lastIndexOf('\n')
  if (lastCompleteLine === -1) {
    return []
  }
  return contents
    .slice(0, lastCompleteLine)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LifecycleEvent)
}

export function hasCompletedWorkerReceivedPreamble(): boolean {
  return readCompletedWorkerLedger()
    .filter((event) => event.event === 'input')
    .map((event) => event.input ?? '')
    .join('')
    .includes('--type worker_done')
}

export function runBuiltOrcaCli(
  args: string[],
  options: { userDataDir: string; cwd: string }
): unknown {
  const {
    ORCA_ENVIRONMENT: _environment,
    ORCA_PAIRING_CODE: _pairingCode,
    ORCA_USER_DATA_PATH: _userDataPath,
    ...cleanEnv
  } = process.env
  void _environment
  void _pairingCode
  void _userDataPath
  const output = execFileSync(
    process.execPath,
    [path.join(process.cwd(), 'out', 'cli', 'index.js'), ...args],
    {
      cwd: options.cwd,
      env: { ...cleanEnv, ORCA_USER_DATA_PATH: options.userDataDir },
      encoding: 'utf8',
      timeout: 30_000
    }
  )
  return JSON.parse(output) as unknown
}

export function seedCurrentCodexTranscript(
  isolatedHome: string,
  providerSessionId: string,
  cwd: string
): string {
  const now = new Date()
  const transcriptDir = path.join(
    isolatedHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  )
  mkdirSync(transcriptDir, { recursive: true })
  const transcriptPath = path.join(transcriptDir, `rollout-${providerSessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: { id: providerSessionId, cwd }
    })}\n`
  )
  writeFileSync(
    recoveryConfigPath,
    JSON.stringify({ session_id: providerSessionId, transcript_path: transcriptPath })
  )
  return transcriptPath
}

export function terminalIdentity(terminal: RuntimeTerminalSummary): TerminalIdentity {
  const { handle, incarnationId, leafId, ptyId, tabId, worktreeId } = terminal
  return { handle, incarnationId, leafId, ptyId, tabId, worktreeId }
}

export async function listRuntimeTerminals(
  client: RuntimeClient
): Promise<RuntimeTerminalSummary[]> {
  return (await client.call<RuntimeTerminalListResult>('terminal.list')).result.terminals
}

export function readPersistedWorkerRecoveryRecord(userDataDir: string, paneKey: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test owns the persisted fixture; optional fields are checked at use sites.
  const data = readPersistedProfileState(userDataDir) as {
    workspaceSession?: {
      sleepingAgentSessionsByPaneKey?: Record<
        string,
        {
          origin?: unknown
          state?: unknown
          providerSession?: { id?: unknown }
        }
      >
    }
  }
  return data.workspaceSession?.sleepingAgentSessionsByPaneKey?.[paneKey] ?? null
}
