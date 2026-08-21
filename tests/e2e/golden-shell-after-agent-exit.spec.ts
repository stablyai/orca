import { expect, test } from './helpers/mcode-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_EXIT_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForRestoredTerminalInputReady } from './helpers/restored-terminal-input-readiness'
import {
  focusActiveTerminalInput,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

// Why: xterm renders the typed command itself, so `echo after-agent` would
// satisfy waitForTerminalOutput even if the shell never ran it. Splitting the
// marker keeps it out of the input, so a match proves real shell execution.
function buildSplitMarkerEcho(prefix: string, suffix: string): { command: string; marker: string } {
  const command =
    process.platform === 'win32'
      ? `Write-Output ('${prefix}' + '${suffix}')`
      : `echo "${prefix}""${suffix}"`
  return { command, marker: `${prefix}${suffix}` }
}

test('opens a clean live shell after an agent exits', async ({ mcodePage }) => {
  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await ensureTerminalVisible(mcodePage)
  await configureGoldenStubAgent(mcodePage)
  await launchGoldenStubAgentFromNewTab(mcodePage)

  await mcodePage.keyboard.type('exit')
  await mcodePage.keyboard.press('Enter')
  await waitForTerminalOutput(mcodePage, GOLDEN_STUB_EXIT_MARKER, 15_000)

  const tabsBeforeShell = await mcodePage.locator('[data-testid="sortable-tab"]').count()
  await mcodePage.getByRole('button', { name: 'New tab' }).click({ force: true })
  await mcodePage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(mcodePage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
  const shellPtyId = await waitForActivePanePtyId(mcodePage)
  // Why: a bound ptyId only means the pane exists; the renderer transport can
  // still drop keystrokes until it connects, which would strand the markers.
  expect(await waitForRestoredTerminalInputReady(mcodePage, shellPtyId)).toBe(true)

  const afterAgent = buildSplitMarkerEcho('after-', 'agent')
  await focusActiveTerminalInput(mcodePage)
  await mcodePage.keyboard.type(afterAgent.command)
  await mcodePage.keyboard.press('Enter')
  await waitForTerminalOutput(mcodePage, afterAgent.marker, 15_000)

  const afterShiftEnter = buildSplitMarkerEcho('after-shift-', 'enter')
  await mcodePage.keyboard.press('Shift+Enter')
  await mcodePage.keyboard.type(afterShiftEnter.command)
  await mcodePage.keyboard.press('Enter')
  await waitForTerminalOutput(mcodePage, afterShiftEnter.marker, 15_000)
  await expect(mcodePage.locator('[data-testid="sortable-tab"]')).toHaveCount(tabsBeforeShell + 1)
})
