import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import type { AgentStatusUpdate } from '@/store/slices/agent-status'
import { useAppStore } from '../../store'
import {
  applyResolvedAgentTerminalTitleToTab,
  shouldApplyResolvedAgentTerminalTitleToTab
} from './agent-status-routing'
import type { AgentStatusApplyOptions, AgentStatusApplyResult } from './agent-status-bridge-types'

/** The title slots one accepted status may overwrite, resolved before the commit picks a lane. */
export type AgentStatusTitleWrite = {
  paneKey: string
  ownerTabId: string | undefined
  /** The TAB record's title, which is the slot this path writes; see agent-status-routing.ts. */
  tabTitle: string | undefined
  terminalTitle: string | undefined
  title: string | undefined
  identityTitle: string | undefined
  titleUsesTabTitle: boolean
}

/**
 * Commits one accepted status update, into the open batch or straight to the store.
 *
 * The two lanes have to stay paired: a batch stages the tab title (and the projected title a later
 * event in the same batch reads) instead of writing it, and defers the completion notification to
 * its post-commit phase, because a rolled-back transaction must not have notified.
 */
export function commitAgentStatusUpdate(args: {
  store: ReturnType<typeof useAppStore.getState>
  update: AgentStatusUpdate
  batch: AgentStatusApplyOptions['batch']
  notify: () => void
  titleWrite: AgentStatusTitleWrite
}): AgentStatusApplyResult {
  const { store, update, batch, notify, titleWrite } = args
  const { paneKey, ownerTabId, tabTitle, terminalTitle, title, identityTitle } = titleWrite
  if (!batch) {
    store.setAgentStatus(
      update.paneKey,
      update.payload,
      update.terminalTitle,
      update.timing,
      update.routing,
      update.metadata
    )
    applyResolvedAgentTerminalTitleToTab(useAppStore.getState(), paneKey, tabTitle, terminalTitle)
    notify()
    return 'applied'
  }
  if (!batch.transaction.apply(update)) {
    return 'dropped'
  }
  batch.notificationEffects.push(notify)
  if (
    !terminalTitle ||
    !ownerTabId ||
    !shouldApplyResolvedAgentTerminalTitleToTab(store, paneKey, tabTitle, terminalTitle)
  ) {
    return 'applied'
  }
  batch.tabTitlesByTabId.set(ownerTabId, terminalTitle)
  if (titleWrite.titleUsesTabTitle) {
    const titleChanges = !title || !isDecorativeAgentTitleFrameChange(title, terminalTitle)
    batch.projectedTitlesByTabId.set(ownerTabId, {
      title: titleChanges ? terminalTitle : title,
      identityTitle: titleChanges ? terminalTitle : identityTitle
    })
  }
  return 'applied'
}
