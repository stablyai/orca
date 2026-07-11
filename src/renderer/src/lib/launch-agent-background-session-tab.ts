import type { useAppStore } from '@/store'
import type { TuiAgent } from '../../../shared/types'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import { makePaneKey, type PaneKey } from '../../../shared/stable-pane-id'

type AppStore = ReturnType<typeof useAppStore.getState>

/**
 * Attaches an inactive tab to an already-live background PTY. Why: a mounted
 * worktree renders new tabs immediately, so any await between tab creation and
 * PTY binding lets TerminalPane's fresh-spawn path bind a default shell to the
 * run tab and orphan the agent PTY (#2989). Callers must spawn the PTY first
 * (against `reservedTabId`), then create the tab through this helper and bind
 * title/layout/ownership via `bindAutomationTerminal` in the same synchronous
 * block — no awaits in between.
 */
export function adoptAgentBackgroundSessionTab({
  store,
  worktreeId,
  reservedTabId,
  leafId,
  ptyId,
  agent,
  launchToken,
  launchConfig
}: {
  store: AppStore
  worktreeId: string
  reservedTabId: string
  leafId: string
  ptyId: string
  agent: TuiAgent
  launchToken: string
  launchConfig: SleepingAgentLaunchConfig
}): { tab: ReturnType<AppStore['createTab']>; paneKey: PaneKey } {
  const tab = store.createTab(worktreeId, undefined, undefined, {
    id: reservedTabId,
    initialPtyId: ptyId,
    activate: false,
    recordInteraction: false
  })
  // Why: createTab mints a fresh id when the reserved id collides (and warns).
  // Store-side pane routing must key off the actual tab id; hook attribution
  // for the env-baked paneKey degrades for that terminal only.
  const paneKey = makePaneKey(tab.id, leafId)
  store.registerAgentLaunchConfig(paneKey, launchConfig, {
    agentType: agent,
    launchToken,
    tabId: tab.id,
    leafId
  })
  return { tab, paneKey }
}
