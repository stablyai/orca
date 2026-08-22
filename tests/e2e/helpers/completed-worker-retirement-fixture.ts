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
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../src/shared/orca-profiles'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../src/shared/runtime-types'
import { buildFakeAgentCommandOverride } from './fake-agent-command-override'
import { FAKE_AGENT_PASTE_END_SCANNER_SOURCE } from './fake-agent-paste-end-scanner'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-retired-worker-'))
const lifecycleLedgerPath = path.join(fakeCliDir, 'codex-lifecycle.jsonl')
export const completedWorkerFakeCodexCommand = buildFakeAgentCommandOverride(
  path.join(fakeCliDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
)
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
const ledger = process.env.ORCA_E2E_CODEX_LIFECYCLE_LEDGER
const append = (event) => appendFileSync(ledger, JSON.stringify({ pid: process.pid, ...event }) + '\\n')
const args = process.argv.slice(2)
if (args.includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
append({ event: 'spawn', args })
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
${FAKE_AGENT_PASTE_END_SCANNER_SOURCE}
let pasteEnded = false
process.stdin.on('data', (chunk) => {
  const input = chunk.toString()
  const pasteEndScan = scanFakeAgentPasteEnd(fakeAgentPasteEndTail, input)
  fakeAgentPasteEndTail = pasteEndScan.tail
  if (pasteEndScan.ended) {
    pasteEnded = true
    process.stdout.write('\\x1b[?25h')
  }
  append({ event: 'input', input })
  if (input.includes('ORCA_E2E_EXIT_AFTER_DONE')) {
    append({ event: 'normal-exit' })
    process.exit(0)
  }
  if (pasteEnded && input.includes('\\r')) {
    process.stdout.write('\\u001b]0;Codex Working\\u0007ACK\\n')
    setTimeout(() => process.stdout.write('\\u001b]0;Codex Ready\\u0007'), 10)
  }
})
process.stdin.setRawMode?.(true)
process.stdin.resume()
setInterval(() => {}, 60_000)
`

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

export const completedWorkerLaunchEnv = {
  PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  ORCA_E2E_CODEX_LIFECYCLE_LEDGER: lifecycleLedgerPath
}

export type LifecycleEvent = {
  pid: number
  event: 'spawn' | 'input' | 'normal-exit'
  args?: string[]
  input?: string
}

export type TerminalIdentity = Pick<
  RuntimeTerminalSummary,
  'handle' | 'incarnationId' | 'leafId' | 'ptyId' | 'tabId' | 'worktreeId'
>

export function clearCompletedWorkerLedger(): void {
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

export function readCompletedWorkerDispatchCapability(): string | null {
  const input = readCompletedWorkerLedger()
    .filter((event) => event.event === 'input')
    .map((event) => event.input ?? '')
    .join('')
  return input.match(/--dispatch-capability\s+(\S+)/)?.[1] ?? null
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
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  if (!existsSync(dataPath)) {
    return null
  }
  const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
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
