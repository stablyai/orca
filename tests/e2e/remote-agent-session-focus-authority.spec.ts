import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient
} from './helpers/paired-electron-client'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'

type ClientMirror = {
  activeTabId: string | null
  tabIds: string[]
  tabGroups: { id: string; tabOrder: string[] }[]
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-headed-agent-focus-'))
const spawnMarkerPath = path.join(scratch, 'agent-spawns.txt')
const inputMarkerPath = path.join(scratch, 'agent-input.txt')
const exitTriggerPath = path.join(scratch, 'exit-agent')
const fixtureScript = path.join(
  process.cwd(),
  'config',
  'scripts',
  'remote-agent-session-repro-fixture.mjs'
)
const writableShellScript = path.join(
  process.cwd(),
  'config',
  'scripts',
  'remote-agent-session-repro-writable-shell.mjs'
)

test.use({
  launchEnv: {
    ORCA_REPRO_EXIT_TRIGGER: exitTriggerPath,
    ORCA_REPRO_INPUT_MARKER: inputMarkerPath,
    ORCA_REPRO_SPAWN_MARKER: spawnMarkerPath
  }
})

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(scriptPath: string, ...args: string[]): string {
  const command = [process.execPath, scriptPath, ...args]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
}

function countAgentSpawns(): number {
  if (!existsSync(spawnMarkerPath)) {
    return 0
  }
  return readFileSync(spawnMarkerPath, 'utf8').split(/\r?\n/).filter(Boolean).length
}

function readAgentSpawnPids(): number[] {
  if (!existsSync(spawnMarkerPath)) {
    return []
  }
  return readFileSync(spawnMarkerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => Number(line.split(':', 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function callClient<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

async function listTerminals(page: Page, worktreeId: string): Promise<RuntimeTerminalSummary[]> {
  return (
    await callClient<{ terminals: RuntimeTerminalSummary[] }>(page, 'terminal.list', {
      worktree: `id:${worktreeId}`
    })
  ).terminals
}

async function readClientMirror(page: Page, worktreeId: string): Promise<ClientMirror> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    const tabIds = (state?.tabsByWorktree[id] ?? []).map((tab) => tab.id)
    return {
      activeTabId: state?.activeTabIdByWorktree[id] ?? null,
      tabIds,
      tabGroups: (state?.groupsByWorktree[id] ?? []).map((group) => ({
        id: group.id,
        tabOrder: group.tabOrder
      }))
    }
  }, worktreeId)
}

async function readRenderedActiveTabId(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector('[data-testid="sortable-tab"][data-active="true"]')
        ?.getAttribute('data-tab-id') ?? null
  )
}

async function readRenderedTabOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-tab"]')
    .evaluateAll((tabs) =>
      tabs
        .map((tab) => tab.getAttribute('data-tab-id'))
        .filter((tabId): tabId is string => tabId !== null)
    )
}

function expectImmediatelyAfter(order: string[], predecessor: string, created: string): void {
  const predecessorIndex = order.indexOf(predecessor)
  if (predecessorIndex < 0) {
    throw new Error(
      `placement predecessor ${predecessor} missing before ${created}: ${JSON.stringify(order)}`
    )
  }
  expect(order[predecessorIndex + 1]).toBe(created)
}

async function launchAgent(
  page: Page,
  args: {
    worktreeId: string
    environmentId: string
    hostPage: Page
    kind: 'fresh' | 'resume'
    activate: boolean
    providerSessionId?: string
    afterTabId?: string
  }
): Promise<{ terminal: RuntimeTerminalSummary; mirror: ClientMirror }> {
  const before = await listTerminals(page, args.worktreeId)
  const beforeHandles = new Set(before.map((terminal) => terminal.handle))
  const priorMirror = await readClientMirror(page, args.worktreeId)
  const priorRenderedActiveTabId = await readRenderedActiveTabId(page)
  const priorHostMirror = await readClientMirror(args.hostPage, args.worktreeId)
  const priorHostRenderedActiveTabId = await readRenderedActiveTabId(args.hostPage)
  const { hostPage: _hostPage, ...clientArgs } = args

  const outcome = await page.evaluate(
    async ({ args, fixtureCommand }) => {
      const bridge = (
        window as unknown as {
          __webRuntimeSessionE2E?: {
            createTerminal: (
              launch: Record<string, unknown>
            ) => Promise<{ status: string; message?: string }>
          }
        }
      ).__webRuntimeSessionE2E
      if (!bridge) {
        throw new Error('Web runtime session E2E bridge is unavailable')
      }
      return bridge.createTerminal({
        worktreeId: args.worktreeId,
        environmentId: args.environmentId,
        agentSessionKind: args.kind,
        agent: 'codex',
        command: fixtureCommand,
        activate: args.activate,
        ...(args.providerSessionId
          ? {
              providerSession: { key: 'session_id', id: args.providerSessionId }
            }
          : {}),
        ...(args.afterTabId ? { afterTabId: args.afterTabId } : {})
      })
    },
    {
      args: clientArgs,
      fixtureCommand: fixtureCommand(fixtureScript)
    }
  )
  expect(outcome).toEqual({ status: 'created' })

  let createdTerminals: RuntimeTerminalSummary[] = []
  await expect
    .poll(
      async () => {
        const terminals = await listTerminals(page, args.worktreeId)
        createdTerminals = terminals.filter((candidate) => !beforeHandles.has(candidate.handle))
        return createdTerminals.length
      },
      { timeout: 15_000 }
    )
    .toBe(1)
  const terminal = createdTerminals[0]
  if (!terminal) {
    throw new Error('Exactly one created agent terminal was not published')
  }

  const expectedActiveId = toWebTerminalSurfaceTabId(terminal.tabId)
  await expect
    .poll(() => readClientMirror(page, args.worktreeId), { timeout: 15_000 })
    .toMatchObject({
      activeTabId: args.activate ? expectedActiveId : priorMirror.activeTabId,
      tabIds: expect.arrayContaining([expectedActiveId])
    })
  await expect
    .poll(() => readRenderedActiveTabId(page), { timeout: 15_000 })
    .toBe(args.activate ? expectedActiveId : priorRenderedActiveTabId)
  await expect(
    page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${expectedActiveId}"][data-active="${args.activate ? 'true' : 'false'}"]`
    )
  ).toBeVisible()
  await expect
    .poll(() => readClientMirror(args.hostPage, args.worktreeId), { timeout: 15_000 })
    .toMatchObject({ activeTabId: priorHostMirror.activeTabId })
  await expect
    .poll(() => readRenderedActiveTabId(args.hostPage), { timeout: 15_000 })
    .toBe(priorHostRenderedActiveTabId)
  return { terminal, mirror: await readClientMirror(page, args.worktreeId) }
}

test('headed paired host keeps structured agent focus viewer-local @headful', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout(180_000)
  const override = fixtureCommand(fixtureScript)
  await orcaPage.evaluate(async (agentCommand) => {
    const settings = await window.api.settings.set({
      agentCmdOverrides: { codex: agentCommand }
    })
    window.__store?.setState({ settings })
  }, override)

  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedWebClient(electronApp, offer)
  let cleanupWorktreeId: string | null = null
  try {
    const worktreeId = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Headed host did not select its seeded worktree')
      }
      return state.activeWorktreeId
    })
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id),
            worktreeId
          ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const session = await client.page.evaluate(async (selectedWorktreeId) => {
      const environment = (await window.api.runtimeEnvironments.list())[0]
      if (!environment) {
        throw new Error('Paired client did not retain its runtime environment')
      }
      return { worktreeId: selectedWorktreeId, environmentId: environment.id }
    }, worktreeId)
    cleanupWorktreeId = session.worktreeId
    await client.page.evaluate((id) => window.__store?.getState().setActiveWorktree(id), worktreeId)
    await expect
      .poll(() => readRenderedActiveTabId(client.page), { timeout: 15_000 })
      .not.toBeNull()

    const unrelatedMarkerPath = path.join(scratch, 'unrelated-input.txt')
    const unrelatedCreated = await callClient<{
      tab: {
        type: 'terminal'
        parentTabId: string
        leafId: string
        terminal: string | null
      }
    }>(client.page, 'session.tabs.createTerminal', {
      worktree: `id:${session.worktreeId}`,
      command: fixtureCommand(writableShellScript, unrelatedMarkerPath),
      activate: false,
      select: false,
      navigation: 'caller'
    })
    if (!unrelatedCreated.tab.terminal) {
      throw new Error('Unrelated headed terminal did not publish a ready handle')
    }
    await expect
      .poll(
        async () =>
          (await listTerminals(client.page, session.worktreeId)).some(
            (terminal) => terminal.handle === unrelatedCreated.tab.terminal
          ),
        { timeout: 15_000 }
      )
      .toBe(true)
    const unrelatedTerminal = (await listTerminals(client.page, session.worktreeId)).find(
      (terminal) => terminal.handle === unrelatedCreated.tab.terminal
    )
    if (!unrelatedTerminal) {
      throw new Error('Unrelated headed terminal was absent from authoritative inventory')
    }
    const unrelatedWebTabId = toWebTerminalSurfaceTabId(unrelatedCreated.tab.parentTabId)
    await expect
      .poll(async () => (await readClientMirror(client.page, session.worktreeId)).tabIds, {
        timeout: 15_000
      })
      .toEqual(expect.arrayContaining([unrelatedWebTabId]))

    const authoritativeBeforeLegacy = await callClient<{
      tabGroups?: { id: string; tabOrder: string[] }[]
      tabs: { type: string; parentTabId?: string; leafId?: string }[]
    }>(client.page, 'session.tabs.list', {
      worktree: `id:${session.worktreeId}`
    })
    const legacyGroup = authoritativeBeforeLegacy.tabGroups?.find((group) => {
      const unrelatedIndex = group.tabOrder.indexOf(unrelatedCreated.tab.parentTabId)
      const predecessorId = unrelatedIndex > 0 ? group.tabOrder[unrelatedIndex - 1] : null
      return authoritativeBeforeLegacy.tabs.some(
        (tab) => tab.type === 'terminal' && tab.parentTabId === predecessorId
      )
    })
    const successorHostTabId = unrelatedCreated.tab.parentTabId
    const successorIndex = legacyGroup?.tabOrder.indexOf(successorHostTabId) ?? -1
    const predecessorHostTabId =
      successorIndex > 0 ? legacyGroup?.tabOrder[successorIndex - 1] : undefined
    const predecessorHostLeafId = authoritativeBeforeLegacy.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === predecessorHostTabId
    )?.leafId
    if (!legacyGroup || !predecessorHostTabId || !successorHostTabId || !predecessorHostLeafId) {
      throw new Error('Legacy placement host predecessor or successor is missing')
    }
    const predecessorWebTabId = toWebTerminalSurfaceTabId(predecessorHostTabId)
    const successorWebTabId = toWebTerminalSurfaceTabId(successorHostTabId)
    await expect
      .poll(() => readRenderedTabOrder(client.page), { timeout: 15_000 })
      .toEqual(expect.arrayContaining([predecessorWebTabId, successorWebTabId]))
    await expect
      .poll(() => readRenderedActiveTabId(client.page), { timeout: 15_000 })
      .not.toBeNull()
    const legacy = await launchAgent(client.page, {
      ...session,
      hostPage: orcaPage,
      kind: 'fresh',
      activate: false,
      afterTabId: toWebTerminalSurfaceTabId(`${predecessorHostTabId}::${predecessorHostLeafId}`)
    })
    const legacyWebTabId = toWebTerminalSurfaceTabId(legacy.terminal.tabId)
    const mirroredLegacyGroup = legacy.mirror.tabGroups.find((group) => group.id === legacyGroup.id)
    if (!mirroredLegacyGroup) {
      throw new Error('Legacy placement mirrored group is missing')
    }
    expectImmediatelyAfter(mirroredLegacyGroup.tabOrder, predecessorWebTabId, legacyWebTabId)
    expectImmediatelyAfter(mirroredLegacyGroup.tabOrder, legacyWebTabId, successorWebTabId)
    const renderedOrder = await readRenderedTabOrder(client.page)
    expectImmediatelyAfter(renderedOrder, predecessorWebTabId, legacyWebTabId)
    expectImmediatelyAfter(renderedOrder, legacyWebTabId, successorWebTabId)
    const authoritativeTabs = await callClient<{
      tabGroups?: { id: string; tabOrder: string[] }[]
    }>(client.page, 'session.tabs.list', { worktree: `id:${session.worktreeId}` })
    const authoritativeTabOrder =
      authoritativeTabs.tabGroups?.find((group) => group.id === legacyGroup.id)?.tabOrder ?? []
    expectImmediatelyAfter(authoritativeTabOrder, predecessorHostTabId, legacy.terminal.tabId)
    expectImmediatelyAfter(authoritativeTabOrder, legacy.terminal.tabId, successorHostTabId)
    const freshFocused = await launchAgent(client.page, {
      ...session,
      hostPage: orcaPage,
      kind: 'fresh',
      activate: true
    })
    const freshBackground = await launchAgent(client.page, {
      ...session,
      hostPage: orcaPage,
      kind: 'fresh',
      activate: false
    })
    const resumeFocused = await launchAgent(client.page, {
      ...session,
      hostPage: orcaPage,
      kind: 'resume',
      activate: true,
      providerSessionId: 'headed-focus-resume'
    })
    const resumeBackground = await launchAgent(client.page, {
      ...session,
      hostPage: orcaPage,
      kind: 'resume',
      activate: false,
      providerSessionId: 'headed-background-resume'
    })

    await expect.poll(countAgentSpawns, { timeout: 15_000 }).toBe(5)
    const structuredPtyIds = [
      freshFocused,
      freshBackground,
      resumeFocused,
      resumeBackground,
      legacy
    ].map(({ terminal }) => terminal.ptyId)
    expect(structuredPtyIds.every(Boolean)).toBe(true)
    expect(new Set(structuredPtyIds).size).toBe(5)
    await expect
      .poll(
        () =>
          orcaPage.evaluate(async () =>
            (await window.api.pty.listSessions()).map((session) => session.id)
          ),
        { timeout: 15_000 }
      )
      .toEqual(expect.arrayContaining(structuredPtyIds))

    const marker = `headed-paired-writable-${Date.now()}`
    const sent = await callClient<{ send: { accepted: boolean } }>(client.page, 'terminal.send', {
      terminal: freshFocused.terminal.handle,
      text: `${marker}\n`
    })
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(
        () =>
          existsSync(inputMarkerPath)
            ? readFileSync(inputMarkerPath, 'utf8').includes(marker)
            : false,
        { timeout: 15_000 }
      )
      .toBe(true)

    const unrelatedMarker = `unrelated-survived-${Date.now()}`
    const unrelatedSent = await callClient<{ send: { accepted: boolean } }>(
      client.page,
      'terminal.send',
      {
        terminal: unrelatedTerminal.handle,
        text: `${unrelatedMarker}\n`
      }
    )
    expect(unrelatedSent.send.accepted).toBe(true)
    await expect
      .poll(
        () =>
          existsSync(unrelatedMarkerPath)
            ? readFileSync(unrelatedMarkerPath, 'utf8').includes(unrelatedMarker)
            : false,
        { timeout: 15_000 }
      )
      .toBe(true)

    const finalTerminals = await listTerminals(client.page, session.worktreeId)
    expect(finalTerminals.map((terminal) => terminal.handle)).toContain(unrelatedTerminal.handle)
    expect((await readClientMirror(client.page, session.worktreeId)).tabIds).toContain(
      unrelatedWebTabId
    )
    expect(resumeBackground.mirror.activeTabId).toBe(resumeFocused.mirror.activeTabId)
    const fixturePids = readAgentSpawnPids()
    expect(fixturePids).toHaveLength(5)
    expect(new Set(fixturePids).size).toBe(5)
    expect(fixturePids.every(isProcessAlive)).toBe(true)
    const fixturePtyIds = finalTerminals
      .map((terminal) => terminal.ptyId)
      .filter((ptyId): ptyId is string => Boolean(ptyId))
    const retiredHostTabIds = [
      unrelatedCreated.tab.parentTabId,
      ...[legacy, freshFocused, freshBackground, resumeFocused, resumeBackground].map(
        ({ terminal }) => terminal.tabId
      )
    ]
    const retiredWebTabIds = retiredHostTabIds.map(toWebTerminalSurfaceTabId)

    await callClient(client.page, 'terminal.stop', {
      worktree: `id:${session.worktreeId}`
    })
    await expect
      .poll(() => listTerminals(client.page, session.worktreeId), { timeout: 15_000 })
      .toEqual([])
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            async (ptyIds) =>
              (await window.api.pty.listSessions())
                .map((session) => session.id)
                .filter((ptyId) => ptyIds.includes(ptyId)),
            fixturePtyIds
          ),
        { timeout: 15_000 }
      )
      .toEqual([])
    await expect
      .poll(
        async () => {
          const tabs = await callClient<{ tabs: { parentTabId?: string }[] }>(
            client.page,
            'session.tabs.list',
            { worktree: `id:${session.worktreeId}` }
          )
          return tabs.tabs
            .map((tab) => tab.parentTabId)
            .filter((tabId) => tabId && retiredHostTabIds.includes(tabId))
        },
        { timeout: 15_000 }
      )
      .toEqual([])
    await expect
      .poll(
        async () =>
          (await readClientMirror(client.page, session.worktreeId)).tabIds.filter((tabId) =>
            retiredWebTabIds.includes(tabId)
          ),
        { timeout: 15_000 }
      )
      .toEqual([])
    await expect
      .poll(
        async () =>
          (await readRenderedTabOrder(client.page)).filter((tabId) =>
            retiredWebTabIds.includes(tabId)
          ),
        { timeout: 15_000 }
      )
      .toEqual([])
    await expect.poll(() => fixturePids.filter(isProcessAlive), { timeout: 15_000 }).toEqual([])
  } finally {
    if (cleanupWorktreeId) {
      await callClient(client.page, 'terminal.stop', {
        worktree: `id:${cleanupWorktreeId}`
      }).catch(() => undefined)
    }
    await client.dispose()
  }
})
