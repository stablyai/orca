import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type {
  RuntimeStatus,
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalSummary,
  RuntimeWorktreeCreateResult
} from '../../src/shared/runtime-types'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import { makePaneKey } from '../../src/shared/stable-pane-id'

type SpawnEvent = { args: string[]; pid: number }
type TerminalIdentity = Pick<
  RuntimeTerminalSummary,
  'handle' | 'incarnationId' | 'leafId' | 'ptyId' | 'tabId'
>

const PROVIDER_SESSION_ID = '019fc155-00e1-7102-99a9-e7c72e532a8e'

const fakeCliDir = mkdtempSync(path.join(os.tmpdir(), 'orca-live-mount-cli-'))
const spawnLedgerPath = path.join(fakeCliDir, 'codex-spawn.jsonl')
const setupLedgerPath = path.join(fakeCliDir, 'setup-spawn.jsonl')
const canaryLedgerPath = path.join(fakeCliDir, 'canary-spawn.jsonl')
const signalLedgerPath = path.join(fakeCliDir, 'terminal-signals.jsonl')
const fakeCodexSource = `
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('app-server')) {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
appendFileSync(process.env.ORCA_E2E_CODEX_SPAWN_LEDGER, JSON.stringify({ args, pid: process.pid }) + '\\n')
process.stdout.write('LIVE_AGENT_READY:' + process.pid + '\\n')
let inputBuffer = ''
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk.toString()
  const lines = inputBuffer.split(/[\\r\\n]+/)
  inputBuffer = lines.pop() || ''
  for (const line of lines) if (line) process.stdout.write('AGENT_INPUT:' + process.pid + ':' + line + '\\n')
})
for (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => appendFileSync(process.env.ORCA_E2E_SIGNAL_LEDGER, JSON.stringify({ kind: 'agent', pid: process.pid, signal }) + '\\n'))
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

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_CODEX_SPAWN_LEDGER: spawnLedgerPath,
      ORCA_E2E_SETUP_LEDGER: setupLedgerPath,
      ORCA_E2E_CANARY_LEDGER: canaryLedgerPath,
      ORCA_E2E_SIGNAL_LEDGER: signalLedgerPath
    },
    { option: true }
  ]
})

function readSpawnLedger(): SpawnEvent[] {
  if (!existsSync(spawnLedgerPath)) {
    return []
  }
  return readFileSync(spawnLedgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SpawnEvent)
}

function readJsonLines<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return []
  }
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function createSourceRepo(): string {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'orca-live-mount-repo-'))
  writeFileSync(
    path.join(repoPath, 'setup-live.js'),
    `const { appendFileSync } = require('node:fs')\nappendFileSync(process.env.ORCA_E2E_SETUP_LEDGER, JSON.stringify({ pid: process.pid }) + '\\n')\nconsole.log('SETUP_READY:' + process.pid)\nlet inputBuffer = ''\nprocess.stdin.on('data', chunk => {\n  inputBuffer += chunk.toString()\n  const lines = inputBuffer.split(/[\\r\\n]+/)\n  inputBuffer = lines.pop() || ''\n  for (const line of lines) if (line) console.log('SETUP_INPUT:' + process.pid + ':' + line)\n})\nfor (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => appendFileSync(process.env.ORCA_E2E_SIGNAL_LEDGER, JSON.stringify({ kind: 'setup', pid: process.pid, signal }) + '\\n'))\nprocess.stdin.resume()\nsetInterval(() => {}, 60000)\n`
  )
  writeFileSync(
    path.join(repoPath, 'canary-live.js'),
    `const { appendFileSync } = require('node:fs')\nappendFileSync(process.env.ORCA_E2E_CANARY_LEDGER, JSON.stringify({ pid: process.pid }) + '\\n')\nconsole.log('CANARY_READY:' + process.pid)\nlet inputBuffer = ''\nprocess.stdin.on('data', chunk => {\n  inputBuffer += chunk.toString()\n  const lines = inputBuffer.split(/[\\r\\n]+/)\n  inputBuffer = lines.pop() || ''\n  for (const line of lines) if (line) console.log('CANARY_INPUT:' + process.pid + ':' + line)\n})\nfor (const signal of ['SIGINT', 'SIGHUP', 'SIGTERM']) process.on(signal, () => appendFileSync(process.env.ORCA_E2E_SIGNAL_LEDGER, JSON.stringify({ kind: 'canary', pid: process.pid, signal }) + '\\n'))\nprocess.stdin.resume()\nsetInterval(() => {}, 60000)\n`
  )
  writeFileSync(path.join(repoPath, 'orca.yaml'), 'scripts:\n  setup: node setup-live.js\n')
  execFileSync('git', ['init'], { cwd: repoPath })
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath })
  execFileSync('git', ['add', '.'], { cwd: repoPath })
  execFileSync(
    'git',
    ['-c', 'user.name=Orca E2E', '-c', 'user.email=orca-e2e@example.com', 'commit', '-m', 'seed'],
    { cwd: repoPath }
  )
  return repoPath
}

async function readWorktreeTerminals(
  client: RuntimeClient,
  worktreeId: string
): Promise<RuntimeTerminalSummary[]> {
  const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${worktreeId}`,
    limit: 20,
    requireFreshPtyLiveness: true
  })
  return listed.result.terminals
    .filter((terminal) => terminal.worktreeId === worktreeId)
    .sort((a, b) => a.handle.localeCompare(b.handle))
}

async function terminalOutput(client: RuntimeClient, handle: string): Promise<string> {
  const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
    terminal: handle,
    limit: 300
  })
  return read.result.terminal.tail.join('\n')
}

function terminalIdentity(terminal: RuntimeTerminalSummary): TerminalIdentity {
  const { handle, incarnationId, leafId, ptyId, tabId } = terminal
  return { handle, incarnationId, leafId, ptyId, tabId }
}

function liveTerminalIdentity(terminal: RuntimeTerminalSummary) {
  return {
    ...terminalIdentity(terminal),
    connected: terminal.connected,
    writable: terminal.writable
  }
}

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number' || parsed.pid <= 0) {
    throw new Error(`Daemon pid file did not contain a positive pid: ${raw}`)
  }
  return parsed.pid
}

async function seedAgentRecoveryMetadata(
  page: Page,
  worktreeId: string,
  agent: TerminalIdentity
): Promise<void> {
  const paneKey = makePaneKey(agent.tabId, agent.leafId)
  const launchToken = `live-mount-${randomUUID()}`
  await page.evaluate(
    ({ agent, launchToken, paneKey, providerSessionId, worktreeId }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Renderer store unavailable')
      }
      const providerSession = { key: 'session_id' as const, id: providerSessionId }
      state.registerAgentLaunchConfig(
        paneKey,
        {
          agentCommand: 'codex',
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        },
        {
          agentType: 'codex',
          launchToken,
          tabId: agent.tabId,
          leafId: agent.leafId,
          terminalHandle: agent.handle,
          providerSession
        }
      )
      state.setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'keep running', agentType: 'codex' },
        'Codex',
        undefined,
        { tabId: agent.tabId, worktreeId, terminalHandle: agent.handle },
        { providerSession, launchToken }
      )
    },
    { agent, launchToken, paneKey, providerSessionId: PROVIDER_SESSION_ID, worktreeId }
  )
  await expect
    .poll(() =>
      page.evaluate(
        ({ paneKey, providerSessionId, worktreeId }) => {
          const state = window.__store?.getState()
          const live = state?.agentStatusByPaneKey[paneKey]
          const sleeping = state?.sleepingAgentSessionsByPaneKey[paneKey]
          return {
            liveProviderSessionId: live?.providerSession?.id ?? null,
            sleeping: sleeping
              ? {
                  paneKey: sleeping.paneKey,
                  tabId: sleeping.tabId,
                  worktreeId: sleeping.worktreeId,
                  origin: sleeping.origin,
                  providerSessionId: sleeping.providerSession.id,
                  agentCommand: sleeping.launchConfig?.agentCommand ?? null
                }
              : null,
            expected: { paneKey, providerSessionId, worktreeId }
          }
        },
        { paneKey, providerSessionId: PROVIDER_SESSION_ID, worktreeId }
      )
    )
    .toEqual({
      liveProviderSessionId: PROVIDER_SESSION_ID,
      sleeping: {
        paneKey,
        tabId: agent.tabId,
        worktreeId,
        origin: 'live',
        providerSessionId: PROVIDER_SESSION_ID,
        agentCommand: 'codex'
      },
      expected: { paneKey, providerSessionId: PROVIDER_SESSION_ID, worktreeId }
    })
}

async function readRendererBindings(page: Page, identities: TerminalIdentity[]) {
  return page.evaluate((targets) => {
    const state = window.__store?.getState()
    return targets.map(({ leafId, tabId }) => ({
      tabId,
      tabPtyId:
        Object.values(state?.tabsByWorktree ?? {})
          .flat()
          .find((tab) => tab.id === tabId)?.ptyId ?? null,
      ptyIds: state?.ptyIdsByTabId[tabId] ?? [],
      leafBindings: Object.entries(state?.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}).sort(
        ([left], [right]) => left.localeCompare(right)
      ),
      leafId
    }))
  }, identities)
}

async function readPersistedBindings(
  page: Page,
  worktreeId: string,
  identities: TerminalIdentity[]
) {
  return page.evaluate(
    async ({ identities, worktreeId }) => {
      const session = await window.api.session.get()
      return identities.map(({ leafId, tabId }) => ({
        tabId,
        tabPtyId:
          session.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.ptyId ?? null,
        leafBindings: Object.entries(
          session.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
        ).sort(([left], [right]) => left.localeCompare(right)),
        leafId
      }))
    },
    { identities, worktreeId }
  )
}

function expectedBindings(identities: TerminalIdentity[], includeLiveIds: boolean) {
  return identities.map(({ leafId, ptyId, tabId }) => ({
    tabId,
    tabPtyId: ptyId,
    ...(includeLiveIds ? { ptyIds: [ptyId] } : {}),
    leafBindings: [[leafId, ptyId]],
    leafId
  }))
}

async function assertTargetBindings(
  page: Page,
  worktreeId: string,
  identities: TerminalIdentity[]
): Promise<void> {
  await expect
    .poll(() => readRendererBindings(page, identities), { timeout: 15_000 })
    .toEqual(expectedBindings(identities, true))
  await expect
    .poll(() => readPersistedBindings(page, worktreeId, identities), { timeout: 15_000 })
    .toEqual(expectedBindings(identities, false))
}

async function assertLiveInventory(
  client: RuntimeClient,
  worktreeId: string,
  originals: RuntimeTerminalSummary[]
): Promise<void> {
  await expect
    .poll(async () => (await readWorktreeTerminals(client, worktreeId)).map(liveTerminalIdentity), {
      timeout: 15_000
    })
    .toEqual(originals.map(liveTerminalIdentity))
}

async function assertLaunchLedgersUnchanged(): Promise<void> {
  await expect
    .poll(
      () => ({
        agent: readSpawnLedger().length,
        setup: readJsonLines<{ pid: number }>(setupLedgerPath).length,
        canary: readJsonLines<{ pid: number }>(canaryLedgerPath).length
      }),
      { timeout: 10_000 }
    )
    .toEqual({ agent: 1, setup: 1, canary: 1 })
  const agentLaunches = readSpawnLedger()
  expect(agentLaunches.filter(({ args }) => args.includes('resume'))).toHaveLength(0)
  expect(agentLaunches.filter(({ args }) => args.includes(PROVIDER_SESSION_ID))).toHaveLength(0)
}

async function assertNoInterruption(
  client: RuntimeClient,
  terminals: RuntimeTerminalSummary[]
): Promise<void> {
  const outputs = await Promise.all(
    terminals.map((terminal) => terminalOutput(client, terminal.handle))
  )
  expect(outputs.join('\n')).not.toContain('Conversation interrupted')
}

async function faultProjectionAndActivate(
  page: Page,
  worktreeId: string,
  terminals: RuntimeTerminalSummary[],
  activeTabId: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ tabIds, worktreeId }) => {
          const state = window.__store?.getState()
          const tabs = state?.tabsByWorktree[worktreeId] ?? []
          return tabIds.every(
            (tabId) =>
              tabs.some((tab) => tab.id === tabId) &&
              Boolean(state?.terminalLayoutsByTabId[tabId]?.root) &&
              !window.__paneManagers?.has(tabId)
          )
        },
        { tabIds: terminals.map((terminal) => terminal.tabId), worktreeId }
      )
    )
    .toBe(true)

  await page.evaluate(
    ({ activeTabId, identities, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Renderer store unavailable')
      }
      store.setState((state) => {
        const tabsByWorktree = { ...state.tabsByWorktree }
        tabsByWorktree[worktreeId] = (tabsByWorktree[worktreeId] ?? []).map((tab) =>
          identities.some((identity) => identity.tabId === tab.id) ? { ...tab, ptyId: null } : tab
        )
        const ptyIdsByTabId = { ...state.ptyIdsByTabId }
        const terminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
        for (const identity of identities) {
          ptyIdsByTabId[identity.tabId] = []
          const layout = terminalLayoutsByTabId[identity.tabId]
          if (layout) {
            const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
            delete ptyIdsByLeafId[identity.leafId]
            terminalLayoutsByTabId[identity.tabId] = {
              ...layout,
              ptyIdsByLeafId
            }
          }
        }
        return { tabsByWorktree, ptyIdsByTabId, terminalLayoutsByTabId }
      })
      const next = store.getState()
      next.setActiveRepo(
        next.repos.find((repo) => repo.id === worktreeId.split('::')[0])?.id ?? null
      )
      next.setActiveTabForWorktree(worktreeId, activeTabId)
      next.setActiveView('terminal')
      next.setActiveWorktree(worktreeId)
    },
    {
      activeTabId,
      identities: terminals.map(({ tabId, leafId }) => ({ tabId, leafId })),
      worktreeId
    }
  )
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
}

async function activateTerminal(page: Page, worktreeId: string, tabId: string): Promise<void> {
  await page.evaluate(
    ({ tabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveRepo(
        state.repos.find((repo) => repo.id === worktreeId.split('::')[0])?.id ?? null
      )
      state?.setActiveTabForWorktree(worktreeId, tabId)
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
    },
    { tabId, worktreeId }
  )
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await page.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).click({ force: true })
}

async function enableTerminalAccessibility(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error(`Terminal pane unavailable: ${id}`)
    }
    pane.terminal.options.screenReaderMode = true
    pane.terminal.refresh(0, pane.terminal.rows - 1)
  }, tabId)
  await expect(
    page.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}] .xterm-accessibility-tree`)
  ).toBeAttached({ timeout: 10_000 })
}

function terminalAccessibility(page: Page, tabId: string) {
  return page.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}] .xterm-accessibility-tree`)
}

async function terminalViewportText(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const pane = window.__paneManagers?.get(id)?.getActivePane?.()
    if (!pane) {
      throw new Error(`Terminal pane unavailable: ${id}`)
    }
    const buffer = pane.terminal.buffer.active
    return Array.from(
      { length: pane.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ).join('\n')
  }, tabId)
}

async function typeIntoTerminal(page: Page, tabId: string, marker: string): Promise<void> {
  const terminal = page.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}] .xterm:visible`)
  await terminal.click({ force: true })
  await page.keyboard.type(marker, { delay: 20 })
  await page.keyboard.press('Enter')
}

async function assertExactPtyReceivedMarker(
  electronApp: Parameters<typeof readTerminalPtyWriteEntries>[0],
  ptyId: string,
  marker: string
): Promise<void> {
  const command = `${marker}\r`
  await expect
    .poll(async () => {
      const entries = await readTerminalPtyWriteEntries(electronApp)
      return entries
        .filter((entry) => entry.id === ptyId)
        .map((entry) => entry.data)
        .join('')
    })
    .toContain(command)
  const unrelatedWrites = (await readTerminalPtyWriteEntries(electronApp))
    .filter((entry) => entry.id !== ptyId)
    .map((entry) => entry.data)
    .join('')
  expect(unrelatedWrites).not.toContain(command)
}

test.afterEach(() => {
  rmSync(spawnLedgerPath, { force: true })
  rmSync(setupLedgerPath, { force: true })
  rmSync(canaryLedgerPath, { force: true })
  rmSync(signalLedgerPath, { force: true })
})

test.afterAll(() => rmSync(fakeCliDir, { recursive: true, force: true }))

test('adopts runtime-owned agent and Setup PTYs on first mount', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const sourceRepo = createSourceRepo()
  let createdWorktreePath: string | null = null
  registerPostElectronShutdownCleanup(async () => {
    if (createdWorktreePath) {
      rmSync(createdWorktreePath, { recursive: true, force: true })
    }
    rmSync(sourceRepo, { recursive: true, force: true })
  })
  await waitForSessionReady(orcaPage)
  await installTerminalPtyWriteSpy(electronApp)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  const added = await client.call<{ repo: { id: string } }>('repo.add', {
    path: sourceRepo,
    kind: 'git'
  })
  const repoId = added.result.repo.id
  await expect
    .poll(() =>
      orcaPage.evaluate(async (repoId) => {
        const state = window.__store?.getState()
        await state?.fetchRepos()
        const repo = window.__store?.getState().repos.find((candidate) => candidate.id === repoId)
        if (!repo) {
          return false
        }
        await window.__store?.getState().updateRepo(repoId, {
          hookSettings: { ...repo.hookSettings, setupAgentStartupPolicy: 'start-immediately' }
        })
        await window.__store?.getState().updateSettings({
          disabledTuiAgents: [],
          setupScriptLaunchMode: 'new-tab',
          terminalHiddenViewParking: false
        })
        return true
      }, repoId)
    )
    .toBe(true)

  const created = await client.call<RuntimeWorktreeCreateResult>('worktree.create', {
    repo: `id:${repoId}`,
    name: `live-mount-${randomUUID()}`,
    noParent: true,
    activate: false,
    setupDecision: 'run',
    startupAgent: 'codex',
    startupPrompt: 'keep running'
  })
  const worktreeId = created.result.worktree.id
  createdWorktreePath = created.result.worktree.path
  const createdCanary = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    title: 'Unrelated canary',
    command: 'node canary-live.js'
  })
  let originals: RuntimeTerminalSummary[] = []
  await expect
    .poll(async () => {
      originals = await readWorktreeTerminals(client, worktreeId)
      return originals.map(({ connected, writable }) => ({ connected, writable }))
    })
    .toEqual([
      { connected: true, writable: true },
      { connected: true, writable: true },
      { connected: true, writable: true }
    ])
  expect(
    originals.every(
      ({ incarnationId, ptyId }) =>
        typeof incarnationId === 'string' && incarnationId.length > 0 && typeof ptyId === 'string'
    )
  ).toBe(true)
  expect(new Set(originals.map((terminal) => terminal.ptyId)).size).toBe(3)
  expect(new Set(originals.map((terminal) => terminal.incarnationId)).size).toBe(3)
  expect(new Set(originals.map(({ leafId, tabId }) => makePaneKey(tabId, leafId))).size).toBe(3)
  const agent = originals.find((terminal) => terminal.handle === created.result.agentTerminalHandle)
  const canary = originals.find(
    (terminal) => terminal.handle === createdCanary.result.terminal.handle
  )
  const setup = originals.find(
    (terminal) => terminal.handle !== agent?.handle && terminal.handle !== canary?.handle
  )
  expect(agent).toBeTruthy()
  expect(setup).toBeTruthy()
  expect(canary).toBeTruthy()
  await expect.poll(readSpawnLedger).toHaveLength(1)
  await expect.poll(() => readJsonLines<{ pid: number }>(setupLedgerPath)).toHaveLength(1)
  await expect.poll(() => readJsonLines<{ pid: number }>(canaryLedgerPath)).toHaveLength(1)
  const agentPid = readSpawnLedger()[0]!.pid
  const setupPid = readJsonLines<{ pid: number }>(setupLedgerPath)[0]!.pid
  const canaryPid = readJsonLines<{ pid: number }>(canaryLedgerPath)[0]!.pid
  await expect
    .poll(() => terminalOutput(client, agent!.handle))
    .toContain(`LIVE_AGENT_READY:${agentPid}`)
  await expect
    .poll(() => terminalOutput(client, setup!.handle))
    .toContain(`SETUP_READY:${setupPid}`)
  await expect
    .poll(() => terminalOutput(client, canary!.handle))
    .toContain(`CANARY_READY:${canaryPid}`)
  await assertLaunchLedgersUnchanged()
  const beforeStatus = await client.call<RuntimeStatus>('status.get')
  expect(beforeStatus.result.graphStatus).toBe('ready')
  const daemonPid = readDaemonPid(userDataDir)
  const allIdentities = originals.map(terminalIdentity)
  await assertTargetBindings(orcaPage, worktreeId, allIdentities)
  await seedAgentRecoveryMetadata(orcaPage, worktreeId, terminalIdentity(agent!))

  await faultProjectionAndActivate(orcaPage, worktreeId, [agent!, setup!], agent!.tabId)
  const mountedAgentPtyId = await waitForActivePanePtyId(orcaPage)
  await enableTerminalAccessibility(orcaPage, agent!.tabId)
  await expect
    .poll(
      async () => ({
        mountedPtyId: mountedAgentPtyId,
        liveInventory: (await readWorktreeTerminals(client, worktreeId)).map(liveTerminalIdentity),
        visibleOriginalReady: (
          await terminalAccessibility(orcaPage, agent!.tabId).innerText()
        ).includes(`LIVE_AGENT_READY:${agentPid}`),
        processPids: {
          agent: readSpawnLedger().map(({ pid }) => pid),
          setup: readJsonLines<{ pid: number }>(setupLedgerPath).map(({ pid }) => pid),
          canary: readJsonLines<{ pid: number }>(canaryLedgerPath).map(({ pid }) => pid)
        }
      }),
      { timeout: 10_000 }
    )
    .toEqual({
      mountedPtyId: agent!.ptyId,
      liveInventory: originals.map(liveTerminalIdentity),
      visibleOriginalReady: true,
      processPids: { agent: [agentPid], setup: [setupPid], canary: [canaryPid] }
    })
  const agentMarker = `AGENT_KB_${randomUUID().slice(0, 8)}`
  await clearTerminalPtyWriteLog(electronApp)
  await typeIntoTerminal(orcaPage, agent!.tabId, agentMarker)
  await assertExactPtyReceivedMarker(electronApp, agent!.ptyId, agentMarker)
  await expect(terminalAccessibility(orcaPage, agent!.tabId)).toContainText(
    `AGENT_INPUT:${agentPid}:${agentMarker}`
  )
  await expect(terminalAccessibility(orcaPage, agent!.tabId)).not.toContainText(
    'Conversation interrupted'
  )

  await activateTerminal(orcaPage, worktreeId, setup!.tabId)
  const mountedSetupPtyId = await waitForActivePanePtyId(orcaPage)
  await enableTerminalAccessibility(orcaPage, setup!.tabId)
  expect(mountedSetupPtyId).toBe(setup!.ptyId)
  await expect(terminalAccessibility(orcaPage, setup!.tabId)).toContainText(
    `SETUP_READY:${setupPid}`
  )
  const setupMarker = `SETUP_KB_${randomUUID().slice(0, 8)}`
  await clearTerminalPtyWriteLog(electronApp)
  await typeIntoTerminal(orcaPage, setup!.tabId, setupMarker)
  await assertExactPtyReceivedMarker(electronApp, setup!.ptyId, setupMarker)
  await expect(terminalAccessibility(orcaPage, setup!.tabId)).toContainText(
    `SETUP_INPUT:${setupPid}:${setupMarker}`
  )
  await expect(terminalAccessibility(orcaPage, setup!.tabId)).not.toContainText(
    'Conversation interrupted'
  )

  const canaryMarker = `CANARY_DIRECT_${randomUUID()}`
  await client.call('terminal.send', {
    terminal: canary!.handle,
    text: canaryMarker,
    enter: true
  })
  await expect
    .poll(() => terminalOutput(client, canary!.handle))
    .toContain(`CANARY_INPUT:${canaryPid}:${canaryMarker}`)

  await assertLiveInventory(client, worktreeId, originals)
  await assertTargetBindings(orcaPage, worktreeId, allIdentities)
  await assertLaunchLedgersUnchanged()
  await assertNoInterruption(client, [agent!, setup!])
  expect(readJsonLines(signalLedgerPath)).toHaveLength(0)
  const afterMountStatus = await client.call<RuntimeStatus>('status.get')
  expect(afterMountStatus.result).toMatchObject({
    runtimeId: beforeStatus.result.runtimeId,
    rendererGraphEpoch: beforeStatus.result.rendererGraphEpoch,
    graphStatus: 'ready',
    authoritativeWindowId: beforeStatus.result.authoritativeWindowId
  })
  expect(readDaemonPid(userDataDir)).toBe(daemonPid)
  const beforeReloadDelivery = await orcaPage.evaluate(() =>
    window.api.pty.getRendererDeliveryDebugSnapshot()
  )

  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await expect
    .poll(
      async () => {
        const status = (await client.call<RuntimeStatus>('status.get')).result
        return {
          runtimeId: status.runtimeId,
          rendererGraphEpoch: status.rendererGraphEpoch,
          graphStatus: status.graphStatus,
          authoritativeWindowId: status.authoritativeWindowId,
          daemonPid: readDaemonPid(userDataDir)
        }
      },
      { timeout: 15_000 }
    )
    .toEqual({
      runtimeId: beforeStatus.result.runtimeId,
      rendererGraphEpoch: afterMountStatus.result.rendererGraphEpoch + 1,
      graphStatus: 'ready',
      authoritativeWindowId: beforeStatus.result.authoritativeWindowId,
      daemonPid
    })
  const postReloadDelivery = {
    rendererLifecycleResetCount: beforeReloadDelivery.rendererLifecycleResetCount + 1,
    rendererPtyDispatcherReady: true,
    rendererDispatcherReadyForcedCount: beforeReloadDelivery.rendererDispatcherReadyForcedCount
  }
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot()))
    .toMatchObject(postReloadDelivery)
  await activateTerminal(orcaPage, worktreeId, agent!.tabId)
  const remountedAgentPtyId = await waitForActivePanePtyId(orcaPage)
  expect(remountedAgentPtyId).toBe(agent!.ptyId)
  await enableTerminalAccessibility(orcaPage, agent!.tabId)
  await expect
    .poll(() => orcaPage.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot()))
    .toMatchObject(postReloadDelivery)
  const remountAgentLiveMarker = `AGENT_LIVE_${randomUUID()}`
  await client.call('terminal.send', {
    terminal: agent!.handle,
    text: remountAgentLiveMarker,
    enter: true
  })
  const remountAgentLiveOutput = `AGENT_INPUT:${agentPid}:${remountAgentLiveMarker}`
  await expect.poll(() => terminalOutput(client, agent!.handle)).toContain(remountAgentLiveOutput)
  await expect
    .poll(() => terminalViewportText(orcaPage, agent!.tabId))
    .toContain(remountAgentLiveOutput)
  expect(
    await orcaPage.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot())
  ).toMatchObject(postReloadDelivery)
  const remountAgentAcceptedMarker = `AGENT_ACCEPTED_${randomUUID()}`
  expect(
    await orcaPage.evaluate(
      ({ marker, ptyId }) => window.api.pty.writeAccepted(ptyId, `${marker}\r`),
      { marker: remountAgentAcceptedMarker, ptyId: agent!.ptyId }
    )
  ).toBe(true)
  const remountAgentAcceptedOutput = `AGENT_INPUT:${agentPid}:${remountAgentAcceptedMarker}`
  await expect
    .poll(() => terminalOutput(client, agent!.handle))
    .toContain(remountAgentAcceptedOutput)
  await expect
    .poll(() => terminalViewportText(orcaPage, agent!.tabId))
    .toContain(remountAgentAcceptedOutput)
  const remountAgentMarker = `AGENT_REMOUNT_${randomUUID().slice(0, 8)}`
  await clearTerminalPtyWriteLog(electronApp)
  await typeIntoTerminal(orcaPage, agent!.tabId, remountAgentMarker)
  await assertExactPtyReceivedMarker(electronApp, agent!.ptyId, remountAgentMarker)
  const remountAgentOutput = `AGENT_INPUT:${agentPid}:${remountAgentMarker}`
  await expect.poll(() => terminalOutput(client, agent!.handle)).toContain(remountAgentOutput)
  await expect
    .poll(() => terminalViewportText(orcaPage, agent!.tabId))
    .toContain(remountAgentOutput)
  await activateTerminal(orcaPage, worktreeId, setup!.tabId)
  const remountedSetupPtyId = await waitForActivePanePtyId(orcaPage)
  expect(remountedSetupPtyId).toBe(setup!.ptyId)
  await enableTerminalAccessibility(orcaPage, setup!.tabId)
  const remountSetupLiveMarker = `SETUP_LIVE_${randomUUID()}`
  await client.call('terminal.send', {
    terminal: setup!.handle,
    text: remountSetupLiveMarker,
    enter: true
  })
  const remountSetupLiveOutput = `SETUP_INPUT:${setupPid}:${remountSetupLiveMarker}`
  await expect.poll(() => terminalOutput(client, setup!.handle)).toContain(remountSetupLiveOutput)
  await expect
    .poll(() => terminalViewportText(orcaPage, setup!.tabId))
    .toContain(remountSetupLiveOutput)
  expect(
    await orcaPage.evaluate(() => window.api.pty.getRendererDeliveryDebugSnapshot())
  ).toMatchObject(postReloadDelivery)
  const remountSetupMarker = `SETUP_REMOUNT_${randomUUID().slice(0, 8)}`
  await clearTerminalPtyWriteLog(electronApp)
  await typeIntoTerminal(orcaPage, setup!.tabId, remountSetupMarker)
  await assertExactPtyReceivedMarker(electronApp, setup!.ptyId, remountSetupMarker)
  const remountSetupOutput = `SETUP_INPUT:${setupPid}:${remountSetupMarker}`
  await expect.poll(() => terminalOutput(client, setup!.handle)).toContain(remountSetupOutput)
  await expect
    .poll(() => terminalViewportText(orcaPage, setup!.tabId))
    .toContain(remountSetupOutput)

  const remountCanaryMarker = `CANARY_REMOUNT_${randomUUID()}`
  await client.call('terminal.send', {
    terminal: canary!.handle,
    text: remountCanaryMarker,
    enter: true
  })
  await expect
    .poll(() => terminalOutput(client, canary!.handle))
    .toContain(`CANARY_INPUT:${canaryPid}:${remountCanaryMarker}`)
  await assertLiveInventory(client, worktreeId, originals)
  await assertTargetBindings(orcaPage, worktreeId, allIdentities)
  await assertLaunchLedgersUnchanged()
  await assertNoInterruption(client, [agent!, setup!])
  expect(readJsonLines(signalLedgerPath)).toHaveLength(0)
})
