import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../../../../shared/native-chat/native-chat-types'
import { StatusDot } from './NativeChatSubagentRun'

/** Head a section whose roster entry is unloaded or nested; unnamed agents have no invented label or state. */
export function NativeChatSubagentSectionHead({
  agentId,
  entry,
  expanded,
  onSetOpen
}: {
  agentId: string
  entry: NativeChatSubagentEntry | undefined
  expanded: boolean
  onSetOpen: (agentId: string, open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = entry === undefined ? null : normalizeSubagentState(entry.state)
  return (
    <button
      type="button"
      onClick={() => onSetOpen(agentId, !expanded)}
      aria-expanded={expanded}
      className="group/subagent-section flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <ChevronRight
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
          expanded && 'rotate-90'
        )}
      />
      <Bot aria-hidden className="size-3.5 shrink-0" />
      {state === null ? null : <StatusDot state={state} pulsing={state === 'working'} />}
      <code className="min-w-0 truncate font-mono text-2xs text-chat-foreground">
        {entry?.label ?? t('components.native-chat.subagents.unnamed', 'Subagent')}
      </code>
    </button>
  )
}
