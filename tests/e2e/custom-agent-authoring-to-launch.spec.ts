import type { Page } from '@stablyai/playwright-test'
import type { CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ECHO_PREFIX,
  FIXTURE_PATH,
  launchCustomAgentViaBoundary,
  READY_MARKER
} from './helpers/custom-agent-e2e'

// The integration proof: author a custom agent through the real Settings UI, then
// launch that freshly-created id through the tab boundary and confirm the host
// resolves and spawns it. This closes the authoring → catalog → launch loop that
// no single-surface spec covers on its own.

async function openAgentsSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'agents', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.getByRole('button', { name: 'New agent' })).toBeVisible({ timeout: 10_000 })
}

test('authors a custom agent in Settings, then launches it through the host boundary', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  // 1. Author the agent through the real Settings UI. Its executable/args point at
  // the deterministic fixture (via the test-runner node) so the launched process
  // is observable — the authoring path must produce a genuinely launchable agent.
  await openAgentsSettings(orcaPage)
  await orcaPage.getByRole('button', { name: 'New agent' }).click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByText('New custom agent')).toBeVisible({ timeout: 10_000 })

  const AGENT_LABEL = 'Authored Launchable Agent'
  const AUTHORED_ARGS = FIXTURE_PATH
  await dialog.locator('#custom-agent-name').fill(AGENT_LABEL)
  await dialog.locator('#custom-agent-executable').fill(process.execPath)
  await dialog.locator('#custom-agent-args').fill(AUTHORED_ARGS)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })

  // 2. Read the host-minted id back from the real catalog (the uuid is host-owned,
  // so the test cannot know it ahead of authoring).
  const authoredId = await orcaPage.evaluate(async (label) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    const entry = snapshot.customAgents.find(
      (candidate) => candidate.status === 'ready' && candidate.definition.label === label
    )
    return entry && entry.status === 'ready' ? entry.definition.id : null
  }, AGENT_LABEL)
  expect(authoredId).not.toBeNull()

  // 3. Leave Settings and launch the authored agent through the tab boundary.
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  await launchCustomAgentViaBoundary(orcaPage, {
    worktreeId,
    agentId: authoredId as CustomTuiAgentId,
    launchSource: 'tab_bar_quick_launch'
  })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)

  // The host resolved the just-authored definition and spawned its executable:
  // the fixture (named by the authored args) prints its readiness marker.
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // And it is genuinely the interactive launched process: typed input reaches it
  // and comes back with a prefix the terminal never produces (raw mode, no echo).
  await sendToTerminal(orcaPage, ptyId, 'ping\r')
  await waitForTerminalOutput(orcaPage, `${ECHO_PREFIX}ping`, 15_000)

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
})
