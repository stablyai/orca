import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

test('paired terminal fills a pane wider than 240 columns', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The width probe uses POSIX stty')
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const hostPtyId = await waitForActivePanePtyId(orcaPage)
  await execInTerminal(orcaPage, hostPtyId, "printf 'WIDE_PROBE_READY\\n'")
  await waitForTerminalOutput(orcaPage, 'WIDE_PROBE_READY')
  const client = await launchPairedElectronClient(
    await createRuntimeDesktopPairingOffer(orcaPage),
    testInfo,
    'Wide terminal proof'
  )
  try {
    const page = client.page
    await page.setViewportSize({ width: 3200, height: 1000 })
    await expect
      .poll(
        () =>
          page.evaluate(
            (repoPath) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .find((worktree) => worktree.path === repoPath)?.id,
            testRepoPath
          ),
        { timeout: 60_000 }
      )
      .toBeTruthy()
    await page.evaluate(
      ({ repoPath, environmentId }) => {
        const state = window.__store?.getState()
        const worktree = state?.allWorktrees().find((entry) => entry.path === repoPath)
        if (!state || !worktree) {
          throw new Error('Paired worktree unavailable')
        }
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
      },
      { repoPath: testRepoPath, environmentId: client.environmentId }
    )
    await ensureTerminalVisible(page, 30_000)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForTerminalOutput(page, 'WIDE_PROBE_READY', 30_000)
    const ptyId = await waitForActivePanePtyId(page, 30_000)
    expect(ptyId.startsWith(`remote:${client.environmentId}@@`)).toBe(true)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const state = window.__store?.getState()
            const tabId = state?.activeWorktreeId
              ? state.activeTabIdByWorktree[state.activeWorktreeId]
              : null
            return tabId
              ? (window.__paneManagers?.get(tabId)?.getActivePane()?.terminal.cols ?? 0)
              : 0
          }),
        { timeout: 30_000 }
      )
      .toBeGreaterThan(240)
    await focusActiveTerminalInput(page)
    await page.keyboard.type(
      "cols=$(stty size | awk '{print $2}'); printf '\\033[2J\\033[HPTY_WIDTH=%s\\r\\n' \"$cols\"; printf '%*s' \"$((cols - 10))\" '' | tr ' ' '='; printf 'RIGHT_EDGE\\r\\n'"
    )
    await page.keyboard.press('Enter')
    await waitForTerminalOutput(page, 'RIGHT_EDGE', 30_000)
    const readRendered = () =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const tabId = state?.activeWorktreeId
          ? state.activeTabIdByWorktree[state.activeWorktreeId]
          : null
        const pane = tabId ? window.__paneManagers?.get(tabId)?.getActivePane() : null
        if (!pane) {
          throw new Error('Terminal unavailable')
        }
        const buffer = pane.terminal.buffer.active
        return {
          cols: pane.terminal.cols,
          lines: Array.from(
            { length: pane.terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
          )
        }
      })
    await expect
      .poll(
        async () => {
          const rendered = await readRendered()
          return {
            widthMatches: rendered.lines.includes(`PTY_WIDTH=${rendered.cols}`),
            rightEdge: rendered.lines.some(
              (line) => line.length === rendered.cols && line.endsWith('RIGHT_EDGE')
            )
          }
        },
        { timeout: 30_000 }
      )
      .toEqual({ widthMatches: true, rightEdge: true })
    await page.screenshot({ path: testInfo.outputPath('wide-terminal.png') })
  } finally {
    await client.dispose()
  }
})
