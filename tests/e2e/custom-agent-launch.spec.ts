import path from 'node:path'
import type { CustomTuiAgent, CustomTuiAgentId } from '../../src/shared/types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  countVisibleTerminalPanes,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'

// The custom agent's executable is `node <fixture>`: commandOverride is one argv
// element (the node binary running the test), and the fixture path rides the v1
// args template (space-free, so it tokenizes to a single argument).
const FIXTURE_PATH = path.join(process.cwd(), 'tests/e2e/fixtures/custom-agent-launch-fixture.cjs')
const CUSTOM_AGENT_ID =
  'custom-agent:codex:0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f' as CustomTuiAgentId
const CUSTOM_AGENT_LABEL = 'E2E Fixture Agent'
const READY_MARKER = 'CUSTOM_AGENT_FIXTURE_READY'

const CUSTOM_AGENT: CustomTuiAgent = {
  id: CUSTOM_AGENT_ID,
  baseAgent: 'codex',
  label: CUSTOM_AGENT_LABEL,
  commandOverride: process.execPath,
  args: FIXTURE_PATH,
  env: {},
  syncEnv: false
}

// A well-formed custom id that is deliberately NEVER seeded: the host resolves it
// against its catalog, finds nothing, and rejects the launch with a client-safe
// unknown_agent failure — a deterministic launch-boundary rejection that needs no
// second (fragile) seed. The uuid segment is asserted absent from the notice.
const UNKNOWN_AGENT_ID =
  'custom-agent:codex:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as CustomTuiAgentId

// A real source-control launch-action id seeded with stored agentArgs. Naming it
// via sourceRecord makes the host resolve those args into host-owned perLaunchArgs
// (the client never sends args), which append to the launched agent's argv.
const RECIPE_ACTION_ID = 'fixChecks'
const RECIPE_ARGS = '--recipe one'

test.use({
  seededCustomAgents: { agents: [CUSTOM_AGENT] },
  seededSourceControlActions: { [RECIPE_ACTION_ID]: { agentArgs: RECIPE_ARGS } }
})

test('launches custom args selected through the new-workspace composer UI', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('[data-workspace-name-input="true"]')).toBeVisible()

  const nameInput = dialog.getByPlaceholder(/Type a name/i)
  await nameInput.fill(`e2e-custom-composer-${Date.now()}`)

  const agentTrigger = dialog.locator('[data-agent-combobox-root="true"][role="combobox"]')
  await agentTrigger.click()
  await expect(orcaPage.getByText(CUSTOM_AGENT_LABEL, { exact: true })).toBeVisible()
  await orcaPage.getByText(CUSTOM_AGENT_LABEL, { exact: true }).click()
  await expect(agentTrigger).toContainText(CUSTOM_AGENT_LABEL)

  const createButton = dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })
  await expect(createButton).toBeEnabled()
  await createButton.click()
  await expect(dialog).toBeHidden({ timeout: 15_000 })

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneCount(orcaPage, 1, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)

  // The fixture path is supplied only by this custom definition's args. Seeing
  // its marker proves the composer submitted the custom id through host assembly.
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)
  await sendToTerminal(orcaPage, ptyId, '\x03')
})

test('launches a seeded custom agent through the host boundary and round-trips keyboard input', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  // Self-verify the seed loaded into the real catalog before launching, so
  // schema drift fails loudly here instead of silently no-op'ing the launch.
  const loadedAgent = await orcaPage.evaluate(async (agentId) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    const entry = snapshot.customAgents.find(
      (candidate) => candidate.status === 'ready' && candidate.definition.id === agentId
    )
    return entry && entry.status === 'ready'
      ? { id: entry.definition.id, label: entry.definition.label }
      : null
  }, CUSTOM_AGENT_ID)
  expect(loadedAgent).toEqual({ id: CUSTOM_AGENT_ID, label: CUSTOM_AGENT_LABEL })

  // Launch the custom agent exactly as launchAgentInNewTab does: an empty
  // command with an `agentLaunch` selection the host resolves at spawn (it owns
  // command/arg assembly), driving the seeded commandOverride into a real PTY.
  const launchedTabId = await orcaPage.evaluate(
    ({ worktreeId, agentId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: agentId })
      state.queueTabStartupCommand(tab.id, {
        command: '',
        agentLaunch: {
          selection: { kind: 'agent', agent: agentId },
          allowEmptyPromptLaunch: true
        },
        telemetry: { launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
      return tab.id
    },
    { worktreeId, agentId: CUSTOM_AGENT_ID }
  )

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  await waitForPaneCount(orcaPage, 1, 30_000)

  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)

  // Exact launch output: the fixture prints its readiness marker on spawn, proving
  // the host resolved the custom executable and started it in the pane's PTY.
  await waitForTerminalOutput(orcaPage, READY_MARKER, 30_000)

  // Trusted keyboard input: typing into the PTY reaches the process, which echoes
  // it back with a prefix the terminal itself never produces (raw mode, no local echo).
  await sendToTerminal(orcaPage, ptyId, 'ping\r')
  await waitForTerminalOutput(orcaPage, 'CUSTOM_AGENT_ECHO:ping', 15_000)

  // Exactly one PTY/session identity: the launch produced a single pane, and the
  // launched tab carries the custom agent's identity as its visible launch state.
  expect(await countVisibleTerminalPanes(orcaPage)).toBe(1)
  const tabIdentity = await orcaPage.evaluate(
    ({ worktreeId, tabId }) => {
      const tab = (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === tabId
      )
      return tab ? { launchAgent: tab.launchAgent, ptyId: tab.ptyId } : null
    },
    { worktreeId, tabId: launchedTabId }
  )
  expect(tabIdentity?.launchAgent).toBe(CUSTOM_AGENT_ID)
  expect(typeof tabIdentity?.ptyId).toBe('string')

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
})

test('surfaces a client-safe recovery notice when a custom agent fails to launch', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  // Confirm the id is genuinely absent from the catalog, so the failure below is
  // a live launch-boundary rejection (unknown_agent), not a seeding artifact.
  const isSeeded = await orcaPage.evaluate(async (agentId) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    return snapshot.customAgents.some(
      (candidate) => candidate.status === 'ready' && candidate.definition.id === agentId
    )
  }, UNKNOWN_AGENT_ID)
  expect(isSeeded).toBe(false)

  // Launch through the SAME production boundary as the happy path; the host
  // resolves the unknown id, rejects it pre-spawn, and creates no PTY.
  await orcaPage.evaluate(
    ({ worktreeId, agentId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: agentId })
      state.queueTabStartupCommand(tab.id, {
        command: '',
        agentLaunch: {
          selection: { kind: 'agent', agent: agentId },
          allowEmptyPromptLaunch: true
        },
        telemetry: { launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
    },
    { worktreeId, agentId: UNKNOWN_AGENT_ID }
  )

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  // The pre-spawn failure renders the persistent in-pane recovery notice with
  // localized, client-safe copy — it names no argv, env, or agent id.
  await expect(orcaPage.getByText(/no longer exists/i)).toBeVisible({ timeout: 30_000 })

  // Client-safe: the visible notice never leaks the requested agent id.
  expect(await orcaPage.getByText('1a2b3c4d').count()).toBe(0)
})

test('threads a source-control recipe’s stored agentArgs into the launched agent argv', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  // Self-verify the seed loaded so a drifted catalog fails loudly here instead of
  // silently launching without the custom executable the recipe args ride on.
  const ready = await orcaPage.evaluate(async (agentId) => {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    return snapshot.customAgents.some(
      (candidate) => candidate.status === 'ready' && candidate.definition.id === agentId
    )
  }, CUSTOM_AGENT_ID)
  expect(ready).toBe(true)

  // Launch through the same production boundary as the happy path, but name the
  // seeded recipe via sourceRecord. The client sends only the owner locator; the
  // host resolves the recipe's stored agentArgs into perLaunchArgs at spawn.
  await orcaPage.evaluate(
    ({ worktreeId, agentId, actionId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const tab = state.createTab(worktreeId, undefined, undefined, { launchAgent: agentId })
      state.queueTabStartupCommand(tab.id, {
        command: '',
        agentLaunch: {
          selection: { kind: 'agent', agent: agentId },
          allowEmptyPromptLaunch: true,
          sourceRecord: { owner: 'source-control-recipe', id: actionId }
        },
        telemetry: { launch_source: 'tab_bar_quick_launch', request_kind: 'new' }
      })
      state.setActiveTab(tab.id)
      state.setActiveTabType('terminal')
    },
    { worktreeId, agentId: CUSTOM_AGENT_ID, actionId: RECIPE_ACTION_ID }
  )

  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const ptyId = await waitForActivePanePtyId(orcaPage, 30_000)

  // The recipe's agentArgs reached THIS spawned process's argv — proving the
  // host-owned recipe→perLaunchArgs→argv path lands through the real boundary,
  // not just the resolver (host-unit owns the resolver-level assertion).
  await waitForTerminalOutput(orcaPage, `CUSTOM_AGENT_ARGV:${RECIPE_ARGS}`, 30_000)

  // Clean shutdown so the daemon/PTY teardown does not race the app close.
  await sendToTerminal(orcaPage, ptyId, '\x03')
})
