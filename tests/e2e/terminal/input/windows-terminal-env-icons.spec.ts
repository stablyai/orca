import { test } from '../../desktop/electron-fixtures/orca-app'

import '../../remote/wsl-hosts/wsl-golden-stub-agent'

import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId } from './terminal'
import {
  execInTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from '../layout/terminal-pane-operations'

test.describe('Windows terminal env and shell identity', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('dev terminal preserves parent PATH so PATH commands resolve', async ({ orcaPage }) => {
    await waitForActiveTerminalManager(orcaPage)

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const marker = `__ORCA_E2E_NODE_PATH_${Date.now()}__`

    // Why: before the dev PATH fallback, daemon-spawned PTYs could get PATH set
    // to only Orca's dev CLI bin. A real terminal command catches that failure.
    await execInTerminal(orcaPage, ptyId, `node -e "console.log('${marker}')"`)

    await waitForTerminalOutput(orcaPage, marker, 15_000)
  })
})
