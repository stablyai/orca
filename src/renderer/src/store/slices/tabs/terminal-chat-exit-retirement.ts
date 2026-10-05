import type { AppState } from '../../types'
import { terminalLayoutNodeLeafIds } from '../../../../../shared/native-chat-leaf-ownership'
import { normalizeTerminalChatPair } from '../../../../../shared/terminal-tab-view-mode'
import type {
  AgentExitRetirementCondition,
  AgentExitRetirementDisposition
} from '../../../../../shared/agent-exit-retirement'
import { locateTerminalTab } from '../../terminals/terminal-tab-location'
import { applyChatPairToState, readTerminalChatPair } from './terminal-chat-pair-state'
import {
  readTerminalPresentationStamp,
  readTerminalPresentationToken
} from './terminal-presentation-stamp'

type ExitRetirementState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
>
type ExitRetirementPatch = Partial<ExitRetirementState>

/**
 * A pane's agent exit, decided and patched in one store turn: the pane's chat turns terminal and
 * a sole pane's launch hint is cleared, never moving chat to another pane. Only an intent after
 * the exit was observed (a user/client switch even back to the same pane, a relaunch) or a rebind
 * of this pane supersedes it; an unknown tab or pane is `missing`.
 */
export function resolveAgentExitRetirement(
  state: ExitRetirementState,
  terminalTabId: string,
  condition: AgentExitRetirementCondition
): { disposition: AgentExitRetirementDisposition; patch?: ExitRetirementPatch } {
  const located = locateTerminalTab(state.tabsByWorktree, terminalTabId)
  const pair = readTerminalChatPair(state, terminalTabId)
  if (!located || !pair) {
    return { disposition: 'missing' }
  }
  const layout = state.terminalLayoutsByTabId[terminalTabId]
  const leafIds = terminalLayoutNodeLeafIds(layout?.root)
  if (leafIds.length > 0 && !leafIds.includes(condition.leafId)) {
    return { disposition: 'missing' }
  }
  const soleLeaf = leafIds.length <= 1
  const boundPtyId =
    layout?.ptyIdsByLeafId?.[condition.leafId] ?? (soleLeaf ? located.tab.ptyId : undefined)
  if (condition.ptyId && boundPtyId && boundPtyId !== condition.ptyId) {
    return { disposition: 'superseded' }
  }
  const stamp = readTerminalPresentationStamp(terminalTabId)
  if (
    (condition.observedAtMs !== undefined && stamp.changedAtMs >= condition.observedAtMs) ||
    (condition.presentationToken !== undefined &&
      condition.presentationToken !== readTerminalPresentationToken(terminalTabId, boundPtyId))
  ) {
    return { disposition: 'superseded' }
  }
  const normalized = normalizeTerminalChatPair(
    {
      ...(pair.viewMode ? { viewMode: pair.viewMode } : {}),
      ...(pair.chatLeafId ? { chatLeafId: pair.chatLeafId } : {})
    },
    layout?.root
  )
  const ownsChat =
    normalized.viewMode === 'chat' &&
    (normalized.chatLeafId ? normalized.chatLeafId === condition.leafId : soleLeaf)
  const clearHint = soleLeaf && Boolean(located.tab.launchAgent)
  if (!ownsChat && !clearHint) {
    return { disposition: 'unchanged' }
  }
  const pairPatch = ownsChat
    ? applyChatPairToState(state, terminalTabId, { leafId: null, viewMode: 'terminal' })?.patch
    : undefined
  const rows = (pairPatch?.tabsByWorktree ?? state.tabsByWorktree)[located.worktreeId] ?? []
  const hintPatch: ExitRetirementPatch = clearHint
    ? {
        tabsByWorktree: {
          ...(pairPatch?.tabsByWorktree ?? state.tabsByWorktree),
          [located.worktreeId]: rows.map((row) => {
            if (row.id !== terminalTabId) {
              return row
            }
            const { launchAgent: _retired, ...withoutHint } = row
            return withoutHint
          })
        }
      }
    : {}
  return { disposition: 'applied', patch: { ...pairPatch, ...hintPatch } }
}
