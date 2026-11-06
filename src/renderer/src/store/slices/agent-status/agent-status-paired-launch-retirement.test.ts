import { expect, it } from 'vitest'

import type { AppState } from '../../types'
import './agent-status'
import { createTestStore } from '../store-test-helpers'
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
  store.setState({ tabsByWorktree: { wt: [] } } as unknown as Partial<AppState>)
  const osc = () =>
    store
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'working', prompt: 'task', agentType: 'claude' },
        'Claude',
        { updatedAt: Date.now(), stateStartedAt: 10 },
        { tabId: TAB, worktreeId: 'wt' },
        { providerSession: SESSION, launchToken: 'launch-1' }
      )
  const frame = (launchAttested: boolean) => {
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
      agentStatus: {
        ...store.getState().agentStatusByPaneKey[PANE]!,
        updatedAt: Date.now() + 1
      }
    }
    const state = store.getState() as unknown as WebSessionTabsSyncState
    store.setState({
      ...buildMirroredAgentStatusPatch(state, [], [surface], [], 'env', 'wt', new Set(), Date.now())
    } as Partial<AppState>)
  }
  const coldRestoreCommand = () => {
    const state = store.getState()
    const launchConfig = state.getAgentLaunchConfigForStatusEntry(state.agentStatusByPaneKey[PANE]!)
    return buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: SESSION,
      cmdOverrides: {},
      ...resolveResumeLaunchRecipe(launchConfig, 'claude', SESSION),
      platform: 'linux'
    })?.launchCommand
  }

  store.getState().registerAgentLaunchConfig(PANE, NOTE, {
    agentType: 'claude',
    launchToken: 'launch-1',
    tabId: TAB,
    leafId: LEAF
  })
  osc()
  frame(true)
  osc()
  expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.launchConfig).toEqual(NOTE)

  frame(false)
  osc()
  expect(store.getState().sleepingAgentSessionsByPaneKey[PANE]?.launchConfig).toBeUndefined()
  expect(coldRestoreCommand()).toBe("claude '--resume' 'conversation-1'")
})
