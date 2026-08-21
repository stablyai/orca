import { expect, test } from './helpers/mcode-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, getTerminalContent } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

test('launches an agent TUI with a live multiline composer', async ({ mcodePage }) => {
  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await ensureTerminalVisible(mcodePage)
  await configureGoldenStubAgent(mcodePage)
  await launchGoldenStubAgentFromNewTab(mcodePage)

  const activeTab = mcodePage.locator('[data-testid="sortable-tab"][data-active="true"]')
  await expect(activeTab).toHaveAttribute('data-tab-title', /Codex|Golden Stub Agent/i)

  await focusActiveTerminalInput(mcodePage)
  await mcodePage.keyboard.type('hello from e2e')
  await mcodePage.keyboard.press('Shift+Enter')
  await mcodePage.keyboard.type('second line')

  await expect
    .poll(() => getTerminalContent(mcodePage), { timeout: 10_000 })
    .toContain('> hello from e2e\r\n  second line')
  expect(await getTerminalContent(mcodePage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')
})
