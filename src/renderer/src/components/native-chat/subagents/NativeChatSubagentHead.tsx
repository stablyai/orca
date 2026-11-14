import { Bot, ChevronRight } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatSubagentStatusIcon } from './NativeChatSubagentStatusIcon'

/** Head for a subagent no loaded roster row names; unnamed agents have no invented label or state. */
export function NativeChatSubagentHead({
  agentId,
  entry,
  onOpen
}: {
  agentId: string
  entry: NativeChatSubagentEntry | undefined
  onOpen?: (agentId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = entry === undefined ? null : normalizeSubagentState(entry.state)
  const content = (
    <>
      <Bot aria-hidden className="size-3.5 shrink-0" />
      {state === null ? null : <NativeChatSubagentStatusIcon state={state} />}
      <code className="min-w-0 truncate font-mono text-2xs text-chat-foreground">
        {entry?.label ?? t('components.native-chat.subagents.unnamed', 'Subagent')}
      </code>
    </>
  )
  if (!onOpen) {
    return (
      <div className="flex min-h-6 items-center gap-1.5 py-0.5 text-chat-foreground-faint">
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(agentId)}
      aria-label={t('components.native-chat.backgroundTasks.openAgent', 'Open {{value0}}', {
        value0: entry?.label ?? t('components.native-chat.subagents.unnamed', 'Subagent')
      })}
      className="group/subagent-head flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {content}
      <ChevronRight aria-hidden className="size-3.5 shrink-0" />
    </button>
  )
}
