import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { test, expect } from './helpers/orca-app'
import { MAIL_PANE_PYTHON_AGENT_SOURCE } from './helpers/orchestration-mail-pane-python-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  removeWslGoldenStubAgent,
  stageWslGoldenStubAgent,
  useWslRuntimeForActiveProject
} from './helpers/wsl-golden-stub-agent'

const DISTRO = process.env.ORCA_E2E_WSL_SUBSCRIPTION_DISTRO?.trim() || null
const CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')

type LedgerEntry = {
  event: string
  requestId?: string
  status?: number
  stdout?: string
  stderr?: string
  error?: string
  data?: string
  hasLaunchToken?: boolean
  terminalHandle?: string
  wslDistro?: string
}

const LEDGER_STRING_KEYS = [
  'requestId',
  'stdout',
  'stderr',
  'error',
  'data',
  'terminalHandle',
  'wslDistro'
] satisfies readonly (keyof LedgerEntry)[]

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLedgerEntry(line: string): LedgerEntry | null {
  const value: unknown = JSON.parse(line)
  if (!isRecord(value) || typeof value.event !== 'string') {
    return null
  }
  const entry: LedgerEntry = { event: value.event }
  for (const key of LEDGER_STRING_KEYS) {
    if (typeof value[key] === 'string') {
      entry[key] = value[key]
    }
  }
  if (typeof value.status === 'number') {
    entry.status = value.status
  }
  if (typeof value.hasLaunchToken === 'boolean') {
    entry.hasLaunchToken = value.hasLaunchToken
  }
  return entry
}

function runWsl(args: string[], input?: string): string {
  if (!DISTRO) {
    throw new Error('WSL distro is unavailable')
  }
  return execFileSync('wsl.exe', ['-d', DISTRO, '--exec', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

function writeWslFile(filePath: string, value: string, executable = false): void {
  const encoded = Buffer.from(value).toString('base64')
  runWsl([
    'sh',
    '-c',
    `mkdir -p ${quote(path.posix.dirname(filePath))} && printf %s ${quote(encoded)} | base64 -d > ${quote(filePath)}${executable ? ` && chmod 0755 ${quote(filePath)}` : ''}`
  ])
}

function readLedger(filePath: string): LedgerEntry[] {
  let value = ''
  try {
    value = runWsl(['cat', filePath])
  } catch {
    return []
  }
  return value
    .split('\n')
    .filter(Boolean)
    .map(parseLedgerEntry)
    .filter((entry): entry is LedgerEntry => entry !== null)
}

async function readUserDataDir(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('userData'))
}

test('Windows Orca delivers subscribed mailbox pointers to a native WSL PTY', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(300_000)
  test.skip(process.platform !== 'win32' || !DISTRO, 'Requires a Windows host and WSL distro.')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const wslAgentStage = stageWslGoldenStubAgent(DISTRO!)
  test.skip(!wslAgentStage, 'WSL distro would not accept the staged agent detector.')
  await useWslRuntimeForActiveProject(orcaPage, DISTRO!)
  const userDataDir = await readUserDataDir(electronApp)
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const before = await client.call<RuntimeTerminalListResult>('terminal.list')
  const existingHandles = new Set(before.result.terminals.map((terminal) => terminal.handle))
  const suffix = randomUUID()
  const root = `/tmp/orca-mailbox-${suffix}`
  const script = `${root}/agent.py`
  const ledger = `${root}/ledger.jsonl`
  const title = `${root}/title`
  const control = `${root}/control.json`
  const cli = `${root}/orca-candidate`
  const nodePath = runWsl(['wslpath', '-u', process.execPath]).trim()
  writeWslFile(script, MAIL_PANE_PYTHON_AGENT_SOURCE)
  writeWslFile(ledger, '')
  writeWslFile(title, '')
  writeWslFile(control, '')
  writeWslFile(cli, `#!/bin/sh\nexec ${quote(nodePath)} ${quote(CLI_ENTRY)} "$@"\n`, true)
  const launchCommand = `/usr/bin/python3 ${[script, ledger, title, control, cli].map(quote).join(' ')}`
  await orcaPage.evaluate(async (command) => {
    await window.__store?.getState().updateSettings({
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: command },
      disabledTuiAgents: []
    })
  }, launchCommand)

  let createdTerminalHandle: string | null = null
  try {
    await orcaPage.getByRole('button', { name: /^(New tab|새 탭)$/ }).click({ force: true })
    const codexLaunch = orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()
    await expect(codexLaunch).toBeVisible({ timeout: 15_000 })
    await codexLaunch.click({ force: true })
    await expect
      .poll(
        async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return (
            listed.result.terminals.find(
              (terminal) => !existingHandles.has(terminal.handle) && terminal.ptyId !== null
            )?.handle ?? null
          )
        },
        { timeout: 30_000 }
      )
      .not.toBeNull()
    const launched = await client.call<RuntimeTerminalListResult>('terminal.list')
    const handle = launched.result.terminals.find(
      (terminal) => !existingHandles.has(terminal.handle) && terminal.ptyId !== null
    )!.handle
    createdTerminalHandle = handle
    await expect
      .poll(() => readLedger(ledger).find((entry) => entry.event === 'start'), {
        timeout: 60_000
      })
      .toMatchObject({
        hasLaunchToken: true,
        terminalHandle: handle,
        wslDistro: DISTRO
      })
    const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
    const ptyId = listed.result.terminals.find((terminal) => terminal.handle === handle)?.ptyId
    expect(ptyId).toBeTruthy()

    writeWslFile(title, 'Codex working')
    await expect
      .poll(async () => {
        const current = await client.call<RuntimeTerminalListResult>('terminal.list')
        return current.result.terminals.find((terminal) => terminal.handle === handle)?.title
      })
      .toBe('Codex working')
    writeWslFile(title, 'Codex ready')
    await expect
      .poll(async () => {
        const current = await client.call<RuntimeTerminalListResult>('terminal.list')
        return current.result.terminals.find((terminal) => terminal.handle === handle)?.title
      })
      .toBe('Codex ready')

    writeWslFile(
      control,
      JSON.stringify({ requestId: 'subscribe', args: ['orchestration', 'subscribe', '--json'] })
    )
    await expect
      .poll(
        () =>
          readLedger(ledger).find(
            (entry) => entry.requestId === 'subscribe' && entry.event !== 'cli-start'
          ),
        { timeout: 30_000 }
      )
      .toMatchObject({ event: 'cli-result', status: 0 })
    const subscribed = readLedger(ledger).find(
      (entry) => entry.requestId === 'subscribe' && entry.event !== 'cli-start'
    )!
    expect(JSON.parse(subscribed.stdout ?? '')).toMatchObject({
      ok: true,
      result: { subscribed: true, state: 'active' }
    })

    const body = 'WSL_BODY_MUST_NOT_ENTER_THE_PTY'
    const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
      to: handle,
      from: 'wsl-live-e2e',
      subject: 'Native WSL terminal mailbox validation',
      body,
      type: 'status'
    })
    await expect
      .poll(() => mailDisposition(readMailRow(userDataDir, sent.result.message.id)), {
        timeout: 30_000
      })
      .toBe('pushed')
    await expect
      .poll(() => {
        const entries = readLedger(ledger).filter((entry) => entry.event === 'stdin')
        return {
          stream: entries.map((entry) => entry.data ?? '').join(''),
          submitted: entries.some((entry) => entry.data === '\r')
        }
      })
      .toEqual({
        stream: expect.stringContaining('orchestration inbox'),
        submitted: true
      })
    expect(
      readLedger(ledger)
        .map((entry) => entry.data ?? '')
        .join('')
    ).not.toContain(body)
  } finally {
    if (createdTerminalHandle) {
      await client
        .call('terminal.close', { terminal: createdTerminalHandle })
        .catch(() => undefined)
    }
    runWsl(['sh', '-c', `rm -rf ${quote(root)}`])
    removeWslGoldenStubAgent(DISTRO!, wslAgentStage!)
  }
})
