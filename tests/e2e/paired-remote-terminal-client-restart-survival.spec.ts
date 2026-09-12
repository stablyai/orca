/**
 * JOURNEY: quit the desktop app while remote terminals are live on the host, then reopen it.
 *
 * TOPOLOGY: the `orcaPage` app is the host (orca server); a separate real Orca desktop client
 * pairs to it, opens a host terminal, works in it, is force-quit, and relaunched on the same
 * profile — the pairing credential and the persisted session survive, as they do for a real
 * force-quit reopen.
 *
 * Why this exists: every paired restart spec in this suite restarts around a *browser* pane
 * (paired-client-hosted-browser-*.spec.ts). None of them restarts a client holding a live remote
 * *terminal*, which is the thing the user is actually mid-work in.
 *
 * The terminal is a fixture that appends one line per event to a file on disk. That sink is the
 * oracle nothing on the client can fake:
 *  - exactly one `READY` for the whole run means the host never re-spawned the process, so the
 *    user came back to their session rather than a fresh shell wearing its name;
 *  - a `LINE:` for input sent after the relaunch means the restored pane is wired to that same
 *    process, not merely painted with its scrollback.
 *
 * Run:
 *   pnpm exec playwright test \
 *     tests/e2e/paired-remote-terminal-client-restart-survival.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(sinkPath: string): string {
  const command = [process.execPath, fixturePath, sinkPath]
  return process.platform === 'win32'
    ? command.map((value) => `"${value.replaceAll('"', '""')}"`).join(' ')
    : command.map(shellQuote).join(' ')
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
      state?.setActiveTabType('terminal')
    },
    { webTabId, worktreeId }
  )
}

/**
 * Types `marker` into the pane until the host-side process records it, or the budget ends.
 *
 * Why through `pane.terminal.input` and not `window.api.pty.write`: a mirrored pane's handle is
 * a `remote:` id that no local PTY answers to, so a direct write is silently swallowed. This is
 * the path a keystroke actually takes, and it is retried because a pane still reattaching can
 * replay-suppress a write (helpers/restored-terminal-input-readiness.ts polls for that reason).
 */
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

    // The control. Without it, "input did not arrive after the restart" cannot be told apart
    // from "this input path never worked in this topology".
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

    // ── The restart: force-quit and reopen on the same profile. ──
    // Quit without disposing: the profile has to outlive the app, as it does for a real Cmd+Q.
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

    // Is the restored pane actually wired to the live process, or only painted with its past?
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

    // The sink is the fork oracle: a second READY means the host re-spawned the user's work.
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
