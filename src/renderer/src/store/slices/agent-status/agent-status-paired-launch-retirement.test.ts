import { expect, it } from 'vitest'

import type { AppState } from '../../types'
import './agent-status'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { buildMirroredAgentStatusPatch } from '../../../runtime/web-session-tabs-sync/agent-status-patch'
import type { WebSessionTabsSyncState } from '../../../runtime/web-session-tabs-sync/state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { resolveResumeLaunchRecipe } from '../../../../../shared/agent-launch/choices/resume-launch-recipe'
import { buildAgentResumeStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'

const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = toWebTerminalSurfaceTabId('host-tab')
const PANE = makePaneKey(TAB, LEAF)
const SESSION = { key: 'session_id' as const, id: 'conversation-1', permissionMode: 'default' }
const NOTE = { agentArgs: '--dangerously-skip-permissions --verbose', agentEnv: { OLD: '1' } }

// A hand-typed resume in a paired pane must not replay the retired launch's bypass.
it('a paired host retiring a launch ends its note for OSC updates and cold restore', () => {
  const store = createTestStore()
  let clock = 1_700_000_000_000
  const tick = () => (clock += 1000)
  const osc = () =>
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'task', agentType: 'claude' },
        'Claude',
        { updatedAt: tick(), stateStartedAt: 10 },
        { tabId: TAB, worktreeId: 'wt' },
        { providerSession: SESSION, launchToken: 'launch-1' }
      )
  const frame = (launchAttested: boolean) => {
    const agentStatus = { ...store.getState().agentStatusByPaneKey[PANE]!, updatedAt: tick() }
    const surface = {
      type: 'terminal' as const,
      id: `host-tab::${LEAF}`,
      title: 'Claude',
      parentTabId: 'host-tab',
      leafId: LEAF,
      isActive: true,
      status: 'ready' as const,
      terminal: 'terminal-1',
      launchAttested,
      agentStatus
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: AppState holds every sync-state field the patch reads.
    const state = store.getState() as unknown as WebSessionTabsSyncState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the patch's fields are AppState fields.
    store.setState({
      ...buildMirroredAgentStatusPatch(state, [], [surface], [], 'env', 'wt', new Set(), tick())
    } as Partial<AppState>)
  }
  const note = () => store.getState().sleepingAgentSessionsByPaneKey[PANE]?.launchConfig

  store.getState().registerAgentLaunchConfig(PANE, NOTE, {
    agentType: 'claude',
    launchToken: 'launch-1',
    tabId: TAB,
    leafId: LEAF
  })
  osc()
  frame(true)
  osc()
  expect(note()).toEqual(NOTE)

  frame(false)
  osc()
  expect(note()).toBeUndefined()
  const state = store.getState()
  const coldRestore = buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: SESSION,
    cmdOverrides: {},
    ...resolveResumeLaunchRecipe(
      state.getAgentLaunchConfigForStatusEntry(state.agentStatusByPaneKey[PANE]!),
      'claude',
      SESSION
    ),
    platform: 'linux'
  })
  expect(coldRestore?.launchCommand).toBe("claude '--resume' 'conversation-1'")
})
