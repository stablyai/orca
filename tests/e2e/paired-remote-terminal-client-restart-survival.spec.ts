// Force-quit a paired desktop client and reopen its retained profile while the desktop host keeps the remote PTY alive.
// One READY in the host sink proves no respawn; post-relaunch LINE entries prove restored input reaches that same process.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../src/shared/terminal-surface-id'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { quotePosixShell } from '../../src/shared/shell-argument-quoting'

/** What a user would accept for "my terminal is back" after reopening the app. */
const RESTORE_BUDGET_MS = 60_000

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-client-restart-survival-'))
const fixturePath = path.join(scratch, 'restart-survival-terminal.mjs')
writeFileSync(
  fixturePath,
  [
    "import { appendFileSync } from 'node:fs'",
    'const sink = process.argv[2]',
    'const record = (line) => appendFileSync(sink, `${line}\\n`)',
    "record('READY')",
    "process.stdout.write('RESTART_SURVIVAL_READY\\r\\n')",
    "process.stdin.setEncoding('utf8')",
    "let pending = ''",
    "process.stdin.on('data', (data) => {",
    '  pending += data',
    '  const lines = pending.split(/\\r\\n|\\r|\\n/)',
    "  pending = lines.pop() ?? ''",
    '  for (const line of lines) {',
    '    record(`LINE:${line}`)',
    '    process.stdout.write(`LINE:${line}\\r\\n`)',
    '  }',
    '})',
    'process.stdin.resume()'
  ].join('\n')
)

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function fixtureCommand(sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(quotePosixShell).join(' ')
}

function readSinkLines(sinkPath: string): string[] {
  try {
    return readFileSync(sinkPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function callEnvironment<TResult>(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: page.evaluate is typed unknown across the bridge; TResult is the caller's declared RPC result.
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  ) as Promise<TResult>
}

async function focusWorkspace(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = window.__store?.getState()
    state?.setActiveView('terminal')
    state?.setActiveWorktree(id)
  }, worktreeId)
}

async function waitForClientWorkspace(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.__store?.getState().allWorktrees() ?? []).some((w) => w.id === id),
          worktreeId
        ),
      { timeout: 60_000, message: 'paired client never received the host workspace' }
    )
    .toBe(true)
}

/** Milliseconds until the tab is mirrored again, or null if it never was. */
async function waitForMirroredTab(
  page: Page,
  worktreeId: string,
  webTabId: string,
  budgetMs: number
): Promise<number | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const present = await page.evaluate(
      ({ id, worktreeId }) =>
        (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === id),
      { id: webTabId, worktreeId }
    )
    if (present) {
      return Date.now() - startedAt
    }
    await page.waitForTimeout(500)
  }
  return null
}

/** Milliseconds until the restored pane paints `marker`, or null if it never did. */
async function waitForPanePaint(
  page: Page,
  webTabId: string,
  marker: string,
  budgetMs: number
): Promise<number | null> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const content = await page.evaluate((id) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
      return pane?.serializeAddon?.serialize?.() ?? ''
    }, webTabId)
    if (content.includes(marker)) {
      return Date.now() - startedAt
    }
    await page.waitForTimeout(500)
  }
  return null
}

async function selectClientTab(page: Page, worktreeId: string, webTabId: string): Promise<void> {
  await page.evaluate(
    ({ webTabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(webTabId)
      state?.setActiveTabType('terminal', window.__store?.getState().activeWorktreeId ?? null)
    },
    { webTabId, worktreeId }
  )
}

// Use terminal.input through the real remote transport; direct local pty.write cannot route remote: ids.
// Retry while reattach may replay-suppress input, as restored-terminal-input-readiness does.
async function driveInputUntilProcessSees(
  client: PairedElectronClient,
  webTabId: string,
  sinkPath: string,
  marker: string,
  budgetMs: number
): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    await client.page.evaluate(
      ({ id, text }) => {
        const manager = window.__paneManagers?.get(id)
        const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
        pane?.terminal?.input?.(text, true)
      },
      { id: webTabId, text: `${marker}\r` }
    )
    if (readSinkLines(sinkPath).some((line) => line.includes(marker))) {
      return true
    }
    await client.page.waitForTimeout(1_000)
  }
  return false
}

async function readTabPtyIds(client: PairedElectronClient, webTabId: string): Promise<string[]> {
  return client.page.evaluate((id) => window.__store?.getState().ptyIdsByTabId[id] ?? [], webTabId)
}

test('a relaunched client gets its live remote terminal back, still attached to the same process', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(900_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const worktreeId = await orcaPage.evaluate(() => {
    const id = window.__store?.getState().activeWorktreeId
    if (!id) {
      throw new Error('host has no active worktree')
    }
    return id
  })

  const sinkPath = path.join(scratch, `sink-${randomUUID()}.log`)
  const failures: string[] = []
  let client: PairedElectronClient | null = null
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  try {
    client = await launchPairedElectronClient(offer, testInfo, 'remote-terminal-restart-survival')
    const userDataDir = client.userDataDir
    await waitForClientWorkspace(client.page, worktreeId)
    await focusWorkspace(client.page, worktreeId)

    const created = await callEnvironment<{ tab: { id: string; terminal: string | null } }>(
      client.page,
      client.environmentId,
      'session.tabs.createTerminal',
      {
        worktree: `id:${worktreeId}`,
        command: fixtureCommand(sinkPath),
        activate: true,
        select: true,
        navigation: 'caller'
      }
    )
    const hostTabId = created.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
    const webTabId = toWebTerminalSurfaceTabId(hostTabId)
    expect(
      await waitForMirroredTab(client.page, worktreeId, webTabId, RESTORE_BUDGET_MS),
      'the client never mirrored the terminal it created'
    ).not.toBeNull()
    await selectClientTab(client.page, worktreeId, webTabId)
    await expect
      .poll(() => readSinkLines(sinkPath), {
        timeout: RESTORE_BUDGET_MS,
        message: 'the host terminal fixture never started'
      })
      .toContain('READY')
    expect(
      await waitForPanePaint(client.page, webTabId, 'RESTART_SURVIVAL_READY', RESTORE_BUDGET_MS),
      'the pane never painted the live terminal before the restart'
    ).not.toBeNull()

    // Prove input works before restart so harness failure cannot look like broken recovery.
    const ptyIdsBefore = await readTabPtyIds(client, webTabId)
    expect(ptyIdsBefore, 'the live pane had no PTY handle before the restart').not.toHaveLength(0)
    expect(
      await driveInputUntilProcessSees(
        client,
        webTabId,
        sinkPath,
        'PRE_RESTART_CONTROL',
        RESTORE_BUDGET_MS
      ),
      'input did not reach the host process even before the restart — the probe, not the product'
    ).toBe(true)

    const quitting = client.app
    client = null
    await closeElectronAppForE2E(quitting)
    client = await launchPairedElectronClient(
      offer,
      testInfo,
      'remote-terminal-restart-survival-relaunch',
      { reuseUserDataDir: userDataDir }
    )
    await waitForClientWorkspace(client.page, worktreeId)
    await focusWorkspace(client.page, worktreeId)

    const tabBackMs = await waitForMirroredTab(client.page, worktreeId, webTabId, RESTORE_BUDGET_MS)
    console.error(`[client-restart] tabBackMs=${tabBackMs}`)
    if (tabBackMs === null) {
      failures.push('the remote terminal tab never came back after the app was reopened')
    } else {
      await selectClientTab(client.page, worktreeId, webTabId)
      const paintedMs = await waitForPanePaint(
        client.page,
        webTabId,
        'RESTART_SURVIVAL_READY',
        RESTORE_BUDGET_MS
      )
      console.error(`[client-restart] paintedMs=${paintedMs}`)
      if (paintedMs === null) {
        failures.push(
          'the remote terminal came back empty — the tab is there but the transcript is not'
        )
      }
    }

    const marker = `POST_RESTART_${randomUUID().slice(0, 8)}`
    const ptyIds = await readTabPtyIds(client, webTabId)
    console.error(`[client-restart] ptyBefore=${ptyIdsBefore[0]} ptyAfter=${ptyIds[0] ?? 'none'}`)
    if (ptyIds.length === 0) {
      failures.push(
        'the restored tab has no PTY handle — nothing the user types can reach the host'
      )
    } else {
      const echoed = await driveInputUntilProcessSees(
        client,
        webTabId,
        sinkPath,
        marker,
        RESTORE_BUDGET_MS
      )
      console.error(`[client-restart] inputReachedProcess=${echoed}`)
      if (!echoed) {
        failures.push(
          'input typed into the restored terminal never reached the process the host is running'
        )
      }
    }

    const readyCount = readSinkLines(sinkPath).filter((line) => line === 'READY').length
    console.error(`[client-restart] readyCount=${readyCount}`)
    if (readyCount !== 1) {
      failures.push(
        `the host process was re-spawned across the client restart (READY x${readyCount}) — the user's session was replaced, not restored`
      )
    }
  } finally {
    await client?.dispose()
  }
  expect(failures, failures.join('\n')).toEqual([])
})
