import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { agentSessionProcessFixture } from './helpers/agent-session-process-fixture'
import {
  activePairedTabId,
  activePairedWorktreeId,
  callAgentSessionClient,
  callAgentSessionClientAt,
  listPairedTerminals,
  mirroredPairedTabIds,
  pairedTerminalViewportText,
  waitForPairedWorktree
} from './helpers/paired-agent-session-evidence'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient,
  type PairedWebClient
} from './helpers/paired-electron-client'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'
import type { CreateWorktreeResult } from '../../src/shared/worktree/create-types'
import type { WorktreeRemovalTarget } from '../../src/shared/worktree/removal'

type AgentSessionResult = {
  disposition: 'created' | 'adopted' | 'replayed'
  terminal: RuntimeTerminalSummary
}

test.use({
  launchEnv: agentSessionProcessFixture.launchEnv
})

test.beforeEach(() => {
  agentSessionProcessFixture.reset()
})

test.afterAll(async () => {
  await agentSessionProcessFixture.dispose()
})

async function configureFixtureAgent(page: Page): Promise<void> {
  await page.evaluate(async (command) => {
    const settings = await window.api.settings.set({
      agentCmdOverrides: { codex: command },
      defaultTuiAgent: 'codex'
    })
    window.__store?.setState({ settings })
  }, agentSessionProcessFixture.command)
}

async function repoIdForWorktree(page: Page, worktreeId: string): Promise<string> {
  const repoId = await page.evaluate(
    (id) =>
      window.__store
        ?.getState()
        .allWorktrees()
        .find((worktree) => worktree.id === id)?.repoId,
    worktreeId
  )
  if (!repoId) {
    throw new Error(`Renderer has no repository for ${worktreeId}`)
  }
  return repoId
}

async function worktreeTargetByName(
  page: Page,
  name: string
): Promise<WorktreeRemovalTarget | null> {
  return page.evaluate((displayName) => {
    const worktree = window.__store
      ?.getState()
      .allWorktrees()
      .find((candidate) => candidate.displayName === displayName)
    return worktree ? { id: worktree.id, executionHostId: worktree.hostId ?? null } : null
  }, name)
}

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: 'application/json'
  })
}

async function removeCreatedWorktree(page: Page, target: WorktreeRemovalTarget): Promise<void> {
  await page.evaluate(async (removalTarget) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Renderer store is unavailable during worktree cleanup')
    }
    await state.removeWorktree(removalTarget, true)
  }, target)
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, executionHostId }) =>
          window.__store
            ?.getState()
            .allWorktrees()
            .some(
              (worktree) => worktree.id === id && (worktree.hostId ?? null) === executionHostId
            ) ?? false,
        target
      )
    )
    .toBe(false)
}

async function stopTerminal(client: PairedWebClient, worktreeId: string): Promise<void> {
  await callAgentSessionClient(client.page, 'terminal.stop', {
    worktree: `id:${worktreeId}`
  }).catch(() => undefined)
}

async function assertFixtureRetired(expectedSpawnCount: number | null): Promise<void> {
  agentSessionProcessFixture.requestExit()
  await expect.poll(() => agentSessionProcessFixture.livePids(), { timeout: 30_000 }).toEqual([])
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  expect(agentSessionProcessFixture.livePids()).toEqual([])
  if (expectedSpawnCount !== null) {
    expect(agentSessionProcessFixture.readSpawns()).toHaveLength(expectedSpawnCount)
  }
}

test('paired viewer worktree.create has one backend startup owner @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await configureFixtureAgent(orcaPage)
  const hostWorktreeBefore = await activePairedWorktreeId(orcaPage)
  const client = await launchPairedWebClient(
    electronApp,
    await createRuntimeDesktopPairingOffer(orcaPage)
  )
  const workspaceName = `sta-4908-owner-${Date.now()}`
  let createdWorktreeTarget: WorktreeRemovalTarget | null = null
  let expectedSpawnCount: number | null = null
  try {
    await configureFixtureAgent(client.page)
    await waitForPairedWorktree(client.page, hostWorktreeBefore)
    const createResult = await callAgentSessionClient<CreateWorktreeResult>(
      client.page,
      'worktree.create',
      {
        repo: await repoIdForWorktree(client.page, hostWorktreeBefore),
        name: workspaceName,
        setupDecision: 'skip',
        createdWithAgent: 'codex',
        startupCommand: agentSessionProcessFixture.command,
        activate: true
      }
    )
    const createdId = createResult.worktree.id
    createdWorktreeTarget = {
      id: createdId,
      executionHostId: createResult.worktree.hostId ?? null
    }
    await waitForPairedWorktree(client.page, createdId)

    await expect
      .poll(() => agentSessionProcessFixture.readSpawns(), { timeout: 30_000 })
      .toHaveLength(1)
    expectedSpawnCount = 1
    await expect.poll(() => listPairedTerminals(client.page, createdId)).toHaveLength(1)
    const [terminal] = await listPairedTerminals(client.page, createdId)
    if (!terminal?.ptyId) {
      throw new Error('Backend startup terminal did not publish a PTY identity')
    }
    const webTabId = toWebTerminalSurfaceTabId(terminal.tabId)
    await expect.poll(() => mirroredPairedTabIds(client.page, createdId)).toEqual([webTabId])
    await expect.poll(() => mirroredPairedTabIds(orcaPage, createdId)).toEqual([terminal.tabId])
    await client.page.locator(`[role="option"][data-worktree-id="${createdId}"]`).click()
    await expect.poll(() => activePairedWorktreeId(client.page)).toBe(createdId)
    await expect(client.page.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
    await expect(
      client.page.locator(`[data-terminal-tab-id="${webTabId}"][data-terminal-layout-leaf-ids]`)
    ).toBeVisible()
    await expect
      .poll(() => pairedTerminalViewportText(client.page, webTabId), { timeout: 30_000 })
      .toContain('ORCA_REPRO_AGENT_READY')
    expect(await activePairedWorktreeId(orcaPage)).toBe(hostWorktreeBefore)

    const [spawn] = agentSessionProcessFixture.readSpawns()
    expect(spawn).toBeDefined()
    expect(agentSessionProcessFixture.livePids()).toEqual([spawn!.pid])
    expect(spawn!.argv).not.toContain('resume')
    await expect
      .poll(() => pairedTerminalViewportText(client.page, webTabId), { timeout: 30_000 })
      .toContain(`ORCA_REPRO_AGENT_READY:${spawn!.pid}`)
    const processInspection = await callAgentSessionClient<{
      process: { foregroundProcess: string | null; hasChildProcesses: boolean; unavailable?: true }
    }>(client.page, 'terminal.inspectProcess', { terminal: terminal.handle })
    expect(processInspection.process.unavailable).not.toBe(true)
    // Why: Windows reports the ConPTY leader; rendered output carries the exact child PID.
    expect(processInspection.process.foregroundProcess).toMatch(
      /(?:pwsh|powershell|node|bash|zsh|sh)(?:\.exe)?/i
    )
    expect(createResult.startupTerminal).toMatchObject({
      spawned: true,
      handle: terminal.handle,
      tabId: terminal.tabId,
      ptyId: terminal.ptyId
    })
    const lifecycle = agentSessionProcessFixture.readLifecycle()
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: spawn!.pid,
          event: 'started:stdin-tty=true:stdout-tty=true'
        })
      ])
    )
    const authoritativeTabs = await callAgentSessionClient(client.page, 'session.tabs.list', {
      worktree: `id:${createdId}`
    })
    await attachEvidence(testInfo, 'sta-4908-ownership-evidence', {
      hostWorktreeBefore,
      viewerWorktreeAfter: createdId,
      terminal,
      processInspection,
      startupTerminal: createResult.startupTerminal,
      authoritativeTabs,
      spawn,
      lifecycle
    })
  } finally {
    const cleanupTarget =
      createdWorktreeTarget ??
      (await worktreeTargetByName(client.page, workspaceName).catch(() => null))
    if (cleanupTarget) {
      await stopTerminal(client, cleanupTarget.id)
      await removeCreatedWorktree(orcaPage, cleanupTarget)
    }
    await client.dispose()
    await assertFixtureRetired(expectedSpawnCount)
  }
})

test('two persistent paired viewers share one live resumed provider session @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await configureFixtureAgent(orcaPage)
  const worktreeId = await activePairedWorktreeId(orcaPage)
  const clientA = await launchPairedWebClient(
    electronApp,
    await createRuntimeDesktopPairingOffer(orcaPage)
  )
  let clientB: PairedWebClient | null = null
  let claimedTerminal: RuntimeTerminalSummary | null = null
  let expectedSpawnCount: number | null = null
  try {
    await waitForPairedWorktree(clientA.page, worktreeId)
    const pairedClientB = await launchPairedWebClient(
      electronApp,
      await createRuntimeDesktopPairingOffer(orcaPage)
    )
    clientB = pairedClientB
    await waitForPairedWorktree(pairedClientB.page, worktreeId)
    const [clientAActiveTabBefore, clientBActiveTabBefore] = await Promise.all([
      activePairedTabId(clientA.page, worktreeId),
      activePairedTabId(pairedClientB.page, worktreeId)
    ])
    const providerSessionId = `sta-3859-${Date.now()}`
    const request = {
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: 'codex',
      providerSession: { key: 'session_id', id: providerSessionId },
      presentation: 'focused'
    }
    const synchronizedStartAt = Date.now() + 500
    const [timedFirst, timedSecond] = await Promise.all([
      callAgentSessionClientAt<AgentSessionResult>(
        clientA.page,
        synchronizedStartAt,
        'terminal.ensureAgentSession',
        request
      ),
      callAgentSessionClientAt<AgentSessionResult>(
        pairedClientB.page,
        synchronizedStartAt,
        'terminal.ensureAgentSession',
        request
      )
    ])
    const first = timedFirst.result
    const second = timedSecond.result
    expect(Math.abs(timedFirst.startedAt - timedSecond.startedAt)).toBeLessThanOrEqual(100)
    claimedTerminal = first.terminal
    await expect
      .poll(() => agentSessionProcessFixture.readSpawns(), { timeout: 30_000 })
      .toHaveLength(1)
    expectedSpawnCount = 1
    expect([first.disposition, second.disposition].sort()).toEqual(['adopted', 'created'])
    expect(second.terminal).toMatchObject({
      handle: first.terminal.handle,
      tabId: first.terminal.tabId,
      ptyId: first.terminal.ptyId
    })
    const [spawn] = agentSessionProcessFixture.readSpawns()
    expect(spawn).toBeDefined()
    expect(agentSessionProcessFixture.livePids()).toEqual([spawn!.pid])
    expect(spawn!.argv).toEqual(expect.arrayContaining(['resume', providerSessionId]))

    const retry = await callAgentSessionClient<AgentSessionResult>(
      pairedClientB.page,
      'terminal.ensureAgentSession',
      request
    )
    expect(retry.disposition).toBe('adopted')
    expect(retry.terminal.handle).toBe(first.terminal.handle)
    expect(agentSessionProcessFixture.readSpawns()).toHaveLength(1)

    const webTabId = toWebTerminalSurfaceTabId(first.terminal.tabId)
    await expect.poll(() => mirroredPairedTabIds(clientA.page, worktreeId)).toContain(webTabId)
    await expect
      .poll(() => mirroredPairedTabIds(pairedClientB.page, worktreeId))
      .toContain(webTabId)
    expect(await activePairedTabId(clientA.page, worktreeId)).toBe(clientAActiveTabBefore)
    expect(await activePairedTabId(pairedClientB.page, worktreeId)).toBe(clientBActiveTabBefore)
    await pairedClientB.page.evaluate(
      (id) => window.__store?.getState().setActiveWorktree(id),
      worktreeId
    )
    const clientBTab = pairedClientB.page.locator(
      `[data-testid="sortable-tab"][data-tab-id="${webTabId}"]`
    )
    await expect(clientBTab).toBeVisible()
    await clientBTab.click()
    await expect.poll(() => activePairedTabId(pairedClientB.page, worktreeId)).toBe(webTabId)
    await expect
      .poll(() => pairedTerminalViewportText(pairedClientB.page, webTabId), { timeout: 30_000 })
      .toContain(`ORCA_REPRO_AGENT_READY:${spawn!.pid}`)

    const input = `sta-3859-live-owner-${Date.now()}`
    const sent = await callAgentSessionClient<{ send: { accepted: boolean } }>(
      clientA.page,
      'terminal.send',
      { terminal: first.terminal.handle, text: `${input}\n` }
    )
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(() => agentSessionProcessFixture.readInput().includes(input), { timeout: 30_000 })
      .toBe(true)
    const clientBInput = `sta-3859-client-b-${Date.now()}`
    const clientBInputArea = pairedClientB.page.locator('.xterm-helper-textarea:visible').first()
    await clientBInputArea.focus()
    await pairedClientB.page.keyboard.type(clientBInput)
    await pairedClientB.page.keyboard.press('Enter')
    await expect
      .poll(() => agentSessionProcessFixture.readInput().includes(clientBInput), {
        timeout: 30_000
      })
      .toBe(true)
    expect(agentSessionProcessFixture.livePids()).toEqual([spawn!.pid])

    const [clientAInventory, clientBInventory] = await Promise.all([
      listPairedTerminals(clientA.page, worktreeId),
      listPairedTerminals(pairedClientB.page, worktreeId)
    ])
    const matchesClaim = (terminal: RuntimeTerminalSummary): boolean =>
      terminal.handle === first.terminal.handle
    expect(clientAInventory.filter(matchesClaim)).toHaveLength(1)
    expect(clientBInventory.filter(matchesClaim)).toHaveLength(1)
    const lifecycle = agentSessionProcessFixture.readLifecycle()
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: spawn!.pid,
          event: 'started:stdin-tty=true:stdout-tty=true'
        })
      ])
    )
    await attachEvidence(testInfo, 'sta-3859-ownership-evidence', {
      clientADisposition: first.disposition,
      clientBDisposition: second.disposition,
      retryDisposition: retry.disposition,
      synchronizedDispatch: { timedFirst, timedSecond },
      terminal: first.terminal,
      spawn,
      clientAInventory,
      clientBInventory,
      lifecycle
    })
  } finally {
    if (claimedTerminal) {
      await callAgentSessionClient(clientA.page, 'terminal.close', {
        terminal: claimedTerminal.handle
      }).catch(() => undefined)
    }
    await clientB?.dispose()
    await clientA.dispose()
    await assertFixtureRetired(expectedSpawnCount)
  }
})
