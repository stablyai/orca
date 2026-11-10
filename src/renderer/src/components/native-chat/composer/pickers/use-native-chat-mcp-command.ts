import { useCallback, useMemo } from 'react'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatPickerItem } from '../../../../../../shared/native-chat/input/native-chat-picker-items'
import type { NativeChatComposerNotice } from '../controls/native-chat-composer-notice'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatPickerState } from './use-native-chat-picker-state'
import { useNativeChatCliHandoff } from '../../pane/actions/use-native-chat-cli-handoff'
import { nativeChatMcpHandoffNotice } from '../controls/native-chat-mcp-handoff-notice'

export function useNativeChatMcpCommand(args: {
  enabled: boolean
  agent: AgentType
  terminalTabId: string
  draft: string
  remote: boolean
  structuredTransport?: NativeChatStructuredComposerTransport
  onSwitchToTerminal?: () => void
  picker: NativeChatPickerState
}) {
  const {
    agent,
    enabled,
    draft,
    picker,
    remote,
    structuredTransport,
    terminalTabId,
    onSwitchToTerminal
  } = args
  const { isPickedSkill, completeItem, autocomplete } = picker
  const matchesDraft = useCallback(
    (text: string) =>
      enabled && agent === 'claude' && text.trim() === '/mcp' && !isPickedSkill(text),
    [agent, enabled, isPickedSkill]
  )
  const handoff = useNativeChatCliHandoff(
    matchesDraft(draft) && structuredTransport?.worktreeId
      ? {
          tabId: terminalTabId,
          worktreeId: structuredTransport.worktreeId,
          nativeChat: { agent, sessionId: structuredTransport.sessionId }
        }
      : null
  )
  const interceptPick = useCallback(
    <TItem extends NativeChatPickerItem>(pick: (item: TItem) => void) =>
      (item: TItem) => {
        if (
          enabled &&
          agent === 'claude' &&
          autocomplete.mode === 'slash' &&
          autocomplete.dispatchable &&
          item.kind === 'command' &&
          item.name === 'mcp'
        ) {
          // Complete instead of dispatching into a hidden TUI; retain any text after the token.
          completeItem(item)
          return
        }
        pick(item)
      },
    [agent, autocomplete, completeItem, enabled]
  )
  const structured = structuredTransport !== undefined
  const open = structured ? handoff?.run : onSwitchToTerminal
  const pending = handoff?.pending === true
  const notice = useMemo<NativeChatComposerNotice | null>(
    () =>
      matchesDraft(draft)
        ? nativeChatMcpHandoffNotice({ structured, remote, open, pending })
        : null,
    [draft, matchesDraft, open, pending, remote, structured]
  )
  return { matchesDraft, consume: matchesDraft, interceptPick, notice }
}
