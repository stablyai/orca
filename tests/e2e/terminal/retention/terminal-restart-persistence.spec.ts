// #461’s 3-minute renderer scrollback serialization caused multi-pane input stalls; #729 replaced it with daemon history and pruned local session buffers.
// Require daemon-backed scrollback, cursor and pane titles across clean restart.

import type { ElectronApplication } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import '../input/terminal'
import { execInTerminal, waitForTerminalOutput } from '../layout/terminal-pane-operations'
import { getTerminalContent } from '../layout/terminal-pane-identity'
import '../../desktop/renderer-probes/store'

import { createRestartSession } from '../../desktop/electron-fixtures/orca-restart'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../src/shared/terminal/pty/lifecycle/pty-session-id-format'
import {
  seededRepoPathOrSkip,
  bootstrapFirstLaunch,
  bootstrapRestoredLaunch
} from './terminal-restart-persistence'

// Serialize full quit/relaunch cycles to avoid competing Electron cache locks.
test.describe.configure({ mode: 'serial' })

test.describe('Terminal restart persistence', () => {
  test('scrollback survives clean quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = seededRepoPathOrSkip()

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)
      // Require daemon-backed persistence; LocalPtyProvider fallback intentionally prunes buffers and would give the wrong failure signal.
      expect(ptyId).toContain(PTY_SESSION_ID_SEPARATOR)

      // Use a retry-unique marker plus newline so prompt/OSC residue cannot satisfy snapshot retention.
      const marker = `SCROLLBACK_PERSIST_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      // Close saves session bindings and disconnects; daemon retains scrollback.
      await session.close(firstApp)
      firstApp = null

      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Poll live xterm after snapshot replay; local scrollback is intentionally absent from store.
      await expect
        .poll(async () => (await getTerminalContent(secondLaunch.page)).includes(marker), {
          timeout: 15_000,
          message: 'Restored terminal did not contain the pre-quit scrollback marker'
        })
        .toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
    }
  })
})
