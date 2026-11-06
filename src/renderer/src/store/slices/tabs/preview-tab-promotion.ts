// Main-owned previews end in main’s frame; paired-server layouts and host_not_owned twins promote in the window copy.

import type { Tab } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import type { AppState } from '../../types'
import { patchTab } from '../tab-group-state'

type OwnerState = Parameters<typeof sendLayoutApply>[0]
type TabsState = Pick<AppState, 'unifiedTabsByWorktree'>
type SetTabs = (update: (state: TabsState) => Partial<TabsState>) => void

/** Ends a tab's preview in the window's own copy; main stores the flag only while it is true. */
function endPreviewHere(set: SetTabs, tabId: string): void {
  set((state) => patchTab(state.unifiedTabsByWorktree, tabId, { isPreview: undefined }) ?? {})
}

/** Whether the window ends a preview in its own copy: always with the switch off. */
export function endsPreviewHere(state: OwnerState, worktreeId: string): boolean {
  return !ORCA_LAYOUT_OWNER_IS_MAIN || runtimeEnvironmentIdUnlessTwin(state, worktreeId) !== null
}

/** Tabs whose promotion main has yet to answer: a second ask (a pin after its keep) is dropped. */
const promoting = new Set<string>()

/** Asks main to promote the tabs it owns; the frame that answers clears their flag. */
export function promotePreviewTabsThroughLayoutOwner(
  state: OwnerState,
  set: SetTabs,
  tabs: readonly Pick<Tab, 'id' | 'worktreeId'>[]
): void {
  for (const tab of tabs) {
    const key = `${tab.worktreeId}\0${tab.id}`
    if (endsPreviewHere(state, tab.worktreeId) || promoting.has(key)) {
      continue
    }
    promoting.add(key)
    const done = (): void => {
      promoting.delete(key)
    }
    sendLayoutApply(
      state,
      tab.worktreeId,
      { type: 'promotePreviewTab', tabId: tab.id },
      {
        apply: done,
        asToday: () => {
          done()
          endPreviewHere(set, tab.id)
        },
        refused: done
      }
    )
  }
}
