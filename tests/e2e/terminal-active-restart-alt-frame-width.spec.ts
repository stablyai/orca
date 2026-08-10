/**
 * Reliability contract: a live daemon-backed alternate-screen TUI cannot retain
 * rows from a wider capture after the active pane reattaches at a narrower grid.
 *
 * Oracle: the same daemon, PTY, and fixture process survive the restart; the
 * fixture records and visibly paints its resize response; no captured-frame row
 * remains in xterm afterward. Current main retains those rows by reflowing the
 * daemon snapshot before the live partial repaint.
 *
 * Maturity: experimental until repeated CI history supports promotion.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

const FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/restart-alt-frame-width-fixture.cjs'
)

type TerminalProbe = {
  ptyId: string
  cols: number
  rows: number
  proposedCols: number | null
  visibleText: string
  staleFrameRows: string[]
}

function createProofRepo(): string {
  const repoDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-alt-frame-restart-')))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@test.local')
  git('config', 'user.name', 'E2E Test')
  writeFileSync(path.join(repoDir, 'README.md'), '# Alternate-frame restart proof\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'Seed alternate-frame restart proof')
  return repoDir
}

function readDaemonPid(userDataDir: string): number {
  return Number(
    readFileSync(path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`), 'utf8').trim()
  )
}

async function readActiveTerminal(page: Page): Promise<TerminalProbe | null> {
  return page.evaluate(async () => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const tabId =
      state?.activeTabType === 'terminal'
        ? state.activeTabId
        : worktreeId
          ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
          : null
    const manager = tabId ? window.__paneManagers?.get(tabId) : null
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const ptyId = pane?.container.dataset.ptyId
    if (!pane || !ptyId) {
      return null
    }
    await new Promise<void>((resolve) => pane.terminal.write('', resolve))
    const lines: string[] = []
    const staleFrameRows: string[] = []
    const buffer = pane.terminal.buffer.active
    for (let row = 0; row < pane.terminal.rows; row += 1) {
      const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
      lines.push(text)
      if (text.includes('STALE_FRAME_ROW_')) {
        staleFrameRows.push(text)
      }
    }
    let proposedCols: number | null = null
    try {
      proposedCols = pane.fitAddon.proposeDimensions()?.cols ?? null
    } catch {
      proposedCols = null
    }
    return {
      ptyId,
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      proposedCols,
      visibleText: lines.join('\n'),
      staleFrameRows
    }
  })
}

async function waitForTerminal(
  page: Page,
  predicate: (probe: TerminalProbe) => boolean,
  message: string
): Promise<TerminalProbe> {
  await expect
    .poll(
      async () => {
        const probe = await readActiveTerminal(page)
        return probe !== null && predicate(probe)
      },
      { timeout: 30_000, message }
    )
    .toBe(true)
  const probe = await readActiveTerminal(page)
  if (!probe) {
    throw new Error(`${message}: terminal disappeared after settling`)
  }
  return probe
}

test.describe.configure({ mode: 'serial' })

test('active live TUI drops a wider daemon frame when restart restores a narrower pane', async (// oxlint-disable-next-line no-empty-pattern -- This restart test owns both launches.
{}, testInfo) => {
  test.setTimeout(240_000)
  test.skip(process.platform === 'win32', 'The deterministic fixture observes POSIX SIGWINCH')

  const repoPath = createProofRepo()
  const logPath = testInfo.outputPath('restart-alt-frame-width.log')
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch({ windowSize: { width: 1500, height: 900 } })
    firstApp = first.app
    await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await waitForPaneCount(first.page, 1, 30_000)

    const firstPtyId = await waitForActivePanePtyId(first.page)
    await sendToTerminal(
      first.page,
      firstPtyId,
      `node ${JSON.stringify(FIXTURE_PATH)} ${JSON.stringify(logPath)}\r`
    )
    const beforeRestart = await waitForTerminal(
      first.page,
      (probe) => probe.staleFrameRows.length >= 8,
      'Wide alternate-screen fixture did not paint before restart'
    )
    await sendToTerminal(first.page, firstPtyId, 'ARM_REPAINT')
    await expect
      .poll(() => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''), {
        timeout: 10_000,
        message: 'Fixture did not arm its resize-only repaint'
      })
      .toContain('ARMED')

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(firstApp)
    firstApp = null

    const second = await session.launch({ windowSize: { width: 820, height: 700 } })
    secondApp = second.app
    await waitForSessionReady(second.page)
    await waitForActiveWorktree(second.page)
    await ensureTerminalVisible(second.page)
    await waitForActiveTerminalManager(second.page, 30_000)
    await waitForPaneCount(second.page, 1, 30_000)

    const afterRestart = await waitForTerminal(
      second.page,
      (probe) => probe.visibleText.includes('REPAINT_AFTER_RESIZE'),
      'Live TUI did not visibly repaint after the narrower warm reattach'
    )
    const proofPath = testInfo.outputPath('after-narrow-restart.png')
    await second.page.screenshot({ path: proofPath })
    await testInfo.attach('after-narrow-restart', { path: proofPath, contentType: 'image/png' })

    expect(readDaemonPid(session.userDataDir), 'daemon must survive the app restart').toBe(
      daemonPid
    )
    expect(afterRestart.ptyId, 'the restored pane must keep the exact daemon PTY').toBe(firstPtyId)
    expect(afterRestart.proposedCols).toBe(afterRestart.cols)
    expect(afterRestart.cols).toBeLessThan(beforeRestart.cols)
    expect(readFileSync(logPath, 'utf8')).toContain(`RESIZE cols=${afterRestart.cols}`)
    expect(
      afterRestart.staleFrameRows,
      `wider captured rows remained after live repaint:\n${afterRestart.visibleText}`
    ).toEqual([])
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
    rmSync(repoPath, { recursive: true, force: true })
  }
})
