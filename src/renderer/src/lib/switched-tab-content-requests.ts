// A switch's requests to this window: deciding grants the switch its tab, its one change applies
// at most once, and asking again answers what that change did (the common pattern: a command's
// receipt is replayed, never the command).

import { useAppStore } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type {
  WindowTabContentOutcome,
  WindowTabContentRequest
} from '../../../shared/window-tab-content'
import type { TabContentRef } from '../../../shared/workspace-layout/workspace-layout-tab-content'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import { setWindowTabContent, windowChatTabId } from './switched-tab-content'

/** This page's lifetime: a reload is a new page, which never applies or answers for an old one's
 *  switch. */
const PAGE = createBrowserUuid()

/**
 * A switch this page decided: the tab it granted and what that tab must still hold, and the one
 * change's outcome once applied. A change to that tab (closed, its content changed or split),
 * seen as the store writes it, ends the grant: a change not yet applied is then refused, one
 * applied is superseded. Pin, color, selection and order change nothing here.
 */
type Grant = {
  worktreeId: string
  tabId: string
  holds: TabContentRef
  outcome?: WindowTabContentOutcome
  changed?: boolean
}
const grants = new Map<string, Grant>()
/** The newest switches only: a switch's answer matters until main settles it, seconds later. */
const GRANT_LIMIT = 8
let stopWatching: (() => void) | null = null

function tabStillHolds(grant: Grant): boolean {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[grant.worktreeId]?.find(
    (entry) => entry.id === grant.tabId
  )
  return (
    !!tab &&
    tab.contentType === grant.holds.kind &&
    tab.entityId ===
      (grant.holds.kind === 'terminal' ? grant.holds.terminalId : grant.holds.sessionId) &&
    (tab.contentType !== 'terminal' ||
      collectLayoutLeafIdsInOrder(state.terminalLayoutsByTabId[tab.entityId]?.root ?? null)
        .length <= 1)
  )
}

/** Watches the granted tabs only while a grant is open. */
function watchGrants(): void {
  const open = [...grants.values()].some((grant) => !grant.changed)
  if (open && !stopWatching) {
    stopWatching = useAppStore.subscribe((state, previous) => {
      if (
        state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree &&
        state.terminalLayoutsByTabId === previous.terminalLayoutsByTabId
      ) {
        return
      }
      for (const grant of grants.values()) {
        grant.changed ||= !tabStillHolds(grant)
      }
      watchGrants()
    })
  } else if (!open && stopWatching) {
    stopWatching()
    stopWatching = null
  }
}

function grant(operation: string, value: Grant): void {
  grants.delete(operation)
  grants.set(operation, value)
  for (const oldest of grants.keys()) {
    if (grants.size <= GRANT_LIMIT) {
      break
    }
    grants.delete(oldest)
  }
  watchGrants()
}

/** One switch request's answer: decide grants the tab, the change applies at most once, and
 *  asking again or `status` answers what it did. */
function answerSwitch(
  request: Omit<WindowTabContentRequest, 'requestId'>
): WindowTabContentOutcome {
  const { operation } = request
  if (!operation) {
    return setWindowTabContent(request)
  }
  if (request.decide) {
    const decided = setWindowTabContent(request)
    if (decided.retargeted && decided.tabId) {
      grant(operation, {
        worktreeId: request.worktreeId,
        tabId: decided.tabId,
        holds: request.expectSource
      })
    }
    return { ...decided, page: PAGE }
  }
  const granted = grants.get(operation)
  // Another page's switch, or one this page no longer remembers: what it did is unknown here.
  if (request.page !== PAGE || !granted) {
    throw new Error('Tab content change unknown to this page')
  }
  if (!granted.outcome && !request.status) {
    granted.outcome =
      granted.changed || !tabStillHolds(granted)
        ? { retargeted: false }
        : setWindowTabContent({ ...request, tabId: granted.tabId, exact: true })
    if (granted.outcome.retargeted) {
      const { content } = request
      granted.holds =
        content.kind === 'terminal'
          ? { kind: 'terminal', terminalId: content.terminalId }
          : { kind: 'agent-session', sessionId: content.sessionId }
      granted.changed = false
    } else {
      granted.changed = true
    }
    watchGrants()
  }
  if (!granted.outcome) {
    throw new Error('Tab content change unknown to this page')
  }
  const refused = !granted.outcome.retargeted && request.content.kind === 'agent-session'
  return {
    ...granted.outcome,
    ...(refused ? { tabId: windowChatTabId(request.worktreeId, request.content.sessionId) } : {}),
    ...(granted.outcome.retargeted && granted.changed ? { superseded: true } : {}),
    page: PAGE
  }
}

/** A switch changes what one of this window's tabs holds; main waits for whether it did. */
export function registerWindowTabContentRequests(unsubs: (() => void)[]): void {
  if (!window.api.ui.onSetTabContent) {
    return
  }
  unsubs.push(
    window.api.ui.onSetTabContent(({ requestId, ...request }) => {
      try {
        window.api.ui.replyTabContent?.({ requestId, ...answerSwitch(request) })
      } catch (error) {
        // A change that may have happened is unknown, never a refusal: main asks again.
        window.api.ui.replyTabContent?.({
          requestId,
          retargeted: false,
          error: error instanceof Error ? error.message : 'Tab content change failed'
        })
      }
    })
  )
}
