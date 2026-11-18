// Require stable split-leaf UUIDs across PTY binding, ORCA_PANE_KEY and context menu.

import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import { UUID_RE, waitForPaneIdentitySnapshot } from '../input/terminal'
import { discoverActivePtyId } from '../input/terminal-active-pane'
import { execInTerminal, waitForTerminalOutput } from './terminal-pane-operations'
import './terminal-pane-title-actions'

import { registerTerminalPaneMountReadiness } from './terminal-pane-mount-readiness'

// Serialize headful scenarios; visible-window runs require an isolated display.
test.describe.configure({ mode: 'serial' })
test.describe('Terminal Panes', () => {
  registerTerminalPaneMountReadiness()

  test('terminal process receives ORCA_PANE_KEY with the active UUID leaf id', async ({
    orcaPage
  }) => {
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const activeLeafId = snapshot.activeLeafId ?? snapshot.panes[0]?.leafId
    if (!activeLeafId) {
      throw new Error('No active pane leaf id found')
    }

    const expectedPaneKey = `${snapshot.tabId}:${activeLeafId}`
    const ptyId = await discoverActivePtyId(orcaPage)
    const marker = `ORCA_PANE_KEY_E2E_${Date.now()}`

    await execInTerminal(orcaPage, ptyId, `printf '${marker}=%s\\n' "$ORCA_PANE_KEY"`)
    await waitForTerminalOutput(orcaPage, `${marker}=${expectedPaneKey}`)

    expect(activeLeafId).toMatch(UUID_RE)
  })
})
