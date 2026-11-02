// A switch between a conversation's chat and its CLI changes what a tab holds, never the tab:
// its id, group, place, pin and color stay (the common pattern: a pane keeps its id while its
// content is replaced, only if it still shows what the action started from).

import type { AgentType } from '../agent-status-types'
import { structuredAgentSessionTabId } from '../agent-session/view/structured-agent-session-projection'
import { filterRecord } from './stored-record-fields'
import { getNextTerminalOrdinal } from './terminal-tab-ordinal'
import { applied, leafIdsOf, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import type {
  LayoutContentTab,
  LayoutTab,
  LayoutTerminalCreation,
  LayoutTerminalTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from './workspace-layout-model'
import { removeTabFromWorkspace, withWorkspace } from './workspace-layout-removal'
import { recordClosedTerminalTabs } from './workspace-layout-tab-commands'
import { adoptedLeaf, type LiveTerminalAdoption } from './workspace-layout-terminal-adoption'

/** What a tab holds, by the content's own id: a terminal (one pane) or a chat. */
export type TabContentRef =
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'agent-session'; sessionId: string }

/** What a switch puts in the tab: its running terminal, or the conversation's chat. */
export type TabContent =
  | {
      kind: 'terminal'
      terminalId: string
      leafId: string
      adopt: LiveTerminalAdoption
      creation?: Partial<LayoutTerminalCreation>
    }
  | { kind: 'agent-session'; sessionId: string; agent: AgentType }

/** A switch: `tabId`, the tab its owner decided, holding just `expectSource` keeps its id and
 *  place and now holds `content`; already holding `content` is done; otherwise nothing changes. */
export type SetTabContentCommand = {
  type: 'setTabContent'
  tabId: string
  expectSource: TabContentRef
  content: TabContent
}

export function tabContentRef(content: TabContent): TabContentRef {
  return content.kind === 'terminal'
    ? { kind: 'terminal', terminalId: content.terminalId }
    : { kind: 'agent-session', sessionId: content.sessionId }
}

/** Enough of a tab to tell what it holds: a split tab holds more than its switched pane. */
export type HeldTabContent = { id: string; kind: string; entityId: string; leafCount: number }

/** Whether the tab holds this and nothing else. */
export function tabHoldsOnly(tab: HeldTabContent, content: TabContentRef): boolean {
  return content.kind === 'terminal'
    ? tab.kind === 'terminal' && tab.entityId === content.terminalId && tab.leafCount === 1
    : tab.kind === 'agent-session' && tab.entityId === content.sessionId
}

/**
 * The one condition, for every layout owner: the switch changes the tab that holds just its
 * source. Deciding which tab, the caller's tab comes first, else whichever tab holds the source
 * (the caller may know only the content, as main does for a window's tab). Once decided, the
 * change and any later reading are bound to `exact`ly that tab: it holding the destination is a
 * retry after a lost answer, done; anything else there (the user closed, split or refilled it) is
 * null, and the switch opens its destination as an ordinary tab, never in another tab.
 */
export function switchedTab<T extends HeldTabContent>(
  tabs: readonly T[],
  tabId: string | undefined,
  source: TabContentRef,
  destination: TabContentRef,
  exact = false
): { tab: T; done: boolean } | null {
  const named = tabId === undefined ? undefined : tabs.find((tab) => tab.id === tabId)
  if (named && tabHoldsOnly(named, destination)) {
    return { tab: named, done: true }
  }
  const holder =
    named && tabHoldsOnly(named, source)
      ? named
      : exact
        ? undefined
        : tabs.find((tab) => tabHoldsOnly(tab, source))
  return holder ? { tab: holder, done: false } : null
}

const heldContentOf = (tab: LayoutTab): HeldTabContent & { tab: LayoutTab } => ({
  id: tab.id,
  kind: tab.kind,
  entityId: tab.entityId,
  leafCount: tab.kind === 'terminal' ? leafIdsOf(tab).length : 0,
  tab
})

/** Which tab `setTabContent` would change, changing nothing: a switch records its chat's tab
 *  there before the write that retires the source. `exact` reads just the named tab. */
export function decideTabContent(
  workspace: WorkspaceLayout | undefined,
  command: Pick<SetTabContentCommand, 'expectSource' | 'content'> & { tabId?: string },
  exact = false
): { retargeted: boolean; tabId?: string } {
  const found = workspace
    ? switchedTab(
        workspace.tabs.map(heldContentOf),
        command.tabId,
        command.expectSource,
        tabContentRef(command.content),
        exact
      )
    : null
  return found ? { retargeted: true, tabId: found.tab.id } : { retargeted: false }
}

/**
 * The decided tab takes the switch's destination in place (see `switchedTab`, bound to exactly
 * that tab); it answers which tab and whether it did. A retired terminal's panes go in the same write and its id is recorded closed,
 * so a late record can't bring it back beside the chat.
 */
export function setTabContent(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setTabContent'>,
  context: LayoutContext
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const found = switchedTab(
    workspace.tabs.map(heldContentOf),
    command.tabId,
    command.expectSource,
    tabContentRef(command.content),
    true
  )
  if (!found || found.done) {
    return applied(model, { ...(found ? { tabId: found.tab.id } : {}), retargeted: Boolean(found) })
  }
  const { tab } = found.tab
  // Kept: the tab's place (id, group order), pin and color. Reset: what described the old
  // content (titles, transcript overlay), so a chat shows its conversation's name.
  const kept = {
    id: tab.id,
    createdAt: tab.createdAt,
    customTitle: null,
    color: tab.color,
    ...(tab.isPinned ? { isPinned: true } : {})
  }
  let next: WorkspaceLayout = workspace
  if (tab.kind === 'terminal' && next.leaves) {
    const retired = leafIdsOf(tab)
    next = { ...next, leaves: filterRecord(next.leaves, (leafId) => !retired.includes(leafId)) }
  }
  const content = command.content
  const replacement: LayoutTab =
    content.kind === 'agent-session'
      ? ({
          ...kept,
          kind: 'agent-session',
          entityId: content.sessionId,
          agentSessionAgent: content.agent
        } satisfies LayoutContentTab)
      : terminalContent(next, kept, content)
  next = withPane(next, tab.id, replacement, content)
  // The conversation has one chat tab: one it already had elsewhere goes, never to Reopen.
  for (const duplicate of next.tabs.filter(
    (entry) => entry.id !== tab.id && tabHoldsOnly(heldContentOf(entry), tabContentRef(content))
  )) {
    next = removeTabFromWorkspace(next, duplicate.id)
  }
  const retargeted = withWorkspace(model, command.workspace, next)
  return applied(
    tab.kind === 'terminal'
      ? recordClosedTerminalTabs(retargeted, command.workspace, [tab.entityId], {
          reason: 'cleanup',
          closedAt: context.now()
        })
      : retargeted,
    { tabId: tab.id, retargeted: true }
  )
}

function terminalContent(
  workspace: WorkspaceLayout,
  kept: Pick<LayoutTerminalTab, 'id' | 'createdAt' | 'customTitle' | 'color' | 'isPinned'>,
  content: Extract<TabContent, { kind: 'terminal' }>
): LayoutTerminalTab {
  const parked = parkedTabOf(workspace, kept.id, content.terminalId)
  if (parked) {
    return { ...parked, ...kept, entityId: content.terminalId }
  }
  const ordinal = getNextTerminalOrdinal(
    workspace.tabs.flatMap((entry) =>
      entry.kind === 'terminal' ? [{ defaultTitle: entry.terminal.defaultTitle, title: '' }] : []
    )
  )
  return {
    ...kept,
    kind: 'terminal',
    entityId: content.terminalId,
    terminal: { defaultTitle: `Terminal ${ordinal}`, ...content.creation },
    panes: { root: { type: 'leaf', leafId: content.leafId } }
  }
}

/** The tab a parked spawn admitted for this terminal, when main's layout already holds one. */
function parkedTabOf(
  workspace: WorkspaceLayout,
  tabId: string,
  terminalId: string
): LayoutTerminalTab | undefined {
  return workspace.tabs.find(
    (entry): entry is LayoutTerminalTab =>
      entry.id !== tabId && entry.kind === 'terminal' && entry.entityId === terminalId
  )
}

/** Puts the replacement in the tab's place; a parked tab it absorbed leaves, its pane bound. */
function withPane(
  workspace: WorkspaceLayout,
  tabId: string,
  replacement: LayoutTab,
  content: TabContent
): WorkspaceLayout {
  let next = workspace
  if (content.kind === 'terminal') {
    const parked = parkedTabOf(next, tabId, content.terminalId)
    next = parked
      ? removeTabFromWorkspace(next, parked.id)
      : { ...next, leaves: { ...next.leaves, [content.leafId]: adoptedLeaf(content.adopt) } }
  }
  return { ...next, tabs: next.tabs.map((entry) => (entry.id === tabId ? replacement : entry)) }
}

/** A chat's tab among these: the one holding it, else its usual id, else the next free one. */
export function chatTabIdAmong(
  tabs: readonly { id: string; holds: boolean }[],
  sessionId: string
): string {
  const held = tabs.find((tab) => tab.holds)
  if (held) {
    return held.id
  }
  const taken = new Set(tabs.map((tab) => tab.id))
  const preferred = structuredAgentSessionTabId(sessionId)
  let id = preferred
  for (let suffix = 2; taken.has(id); suffix++) {
    id = `${preferred}-${suffix}`
  }
  return id
}
