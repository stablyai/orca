import { readTabMapChanges } from '@/store/record-transitions/keyed-record-change-reads'
import type { ResourceSessionBindingInputs } from '../workspace-attribution/resource-session-bindings'

type TabsByWorktree = ResourceSessionBindingInputs['tabsByWorktree']

/** Preserve the PTY topology across terminal title publications. Read live labels at the mounted row. */
export function createResourcePtyTabBindingSelector(): (tabs: TabsByWorktree) => TabsByWorktree {
  let observed: TabsByWorktree | undefined
  let stable: TabsByWorktree
  return (tabs) => {
    if (!observed) {
      observed = stable = tabs
      return stable
    }
    const changes = readTabMapChanges(tabs, observed)
    if (changes?.kind === 'addressed' && !changes.workspaceSetChanged) {
      for (const workspaceId of changes.workspaceIds) {
        const oldTabs = observed[workspaceId]
        const newTabs = tabs[workspaceId]
        if (
          oldTabs?.length !== newTabs?.length ||
          newTabs?.some((tab, index) => {
            const oldTab = oldTabs[index]
            return (
              tab.id !== oldTab?.id ||
              tab.ptyId !== oldTab.ptyId ||
              tab.defaultTitle !== oldTab.defaultTitle ||
              tab.customTitle !== oldTab.customTitle
            )
          })
        ) {
          stable = tabs
          break
        }
      }
    } else if (changes) {
      stable = tabs
    }
    observed = tabs
    return stable
  }
}
