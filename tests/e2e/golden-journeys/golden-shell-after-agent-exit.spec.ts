import { tabCreateMenuTrigger } from '../terminal/layout/terminal-tab-menu'
import { test } from '../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_EXIT_MARKER,
  launchGoldenStubAgentFromNewTab
} from './golden-stub-agent'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../desktop/renderer-probes/store'
import { waitForRestoredTerminalInputReady } from '../terminal/readiness/restored-terminal-input-readiness'
import { focusActiveTerminalInput, waitForActivePanePtyId } from '../terminal/input/terminal'
import { waitForTerminalOutput } from '../terminal/layout/terminal-pane-operations'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

// Split the marker so terminal input echo cannot impersonate successful shell execution.
function buildSplitMarkerEcho(prefix: string, suffix: string): { command: string; marker: string } {
  const command =
    process.platform === 'win32'
      ? `Write-Output ('${prefix}' + '${suffix}')`
      : `echo "${prefix}""${suffix}"`
  return { command, marker: `${prefix}${suffix}` }
}

test('opens a clean live shell after an agent exits', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage)
  await launchGoldenStubAgentFromNewTab(orcaPage)

  await orcaPage.keyboard.type('exit')
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_EXIT_MARKER, 15_000)

  const tabsBeforeShell = await orcaPage.locator('[data-testid="sortable-tab"]').count()
  await (await tabCreateMenuTrigger(orcaPage)).click({ force: true })
  await orcaPage
    .getByRole('menu')
    .getByRole('button', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
  const shellPtyId = await waitForActivePanePtyId(orcaPage)
  // A bound pane can precede transport readiness; wait or marker keystrokes may be dropped.
  expect(await waitForRestoredTerminalInputReady(orcaPage, shellPtyId)).toBe(true)

  const afterAgent = buildSplitMarkerEcho('after-', 'agent')
  await focusActiveTerminalInput(orcaPage)
  await orcaPage.keyboard.type(afterAgent.command)
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, afterAgent.marker, 15_000)

  const afterShiftEnter = buildSplitMarkerEcho('after-shift-', 'enter')
  await orcaPage.keyboard.press('Shift+Enter')
  await orcaPage.keyboard.type(afterShiftEnter.command)
  await orcaPage.keyboard.press('Enter')
  await waitForTerminalOutput(orcaPage, afterShiftEnter.marker, 15_000)
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
})
