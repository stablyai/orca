import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { NativeChatSubagentActivity } from '../../../../shared/native-chat/input/native-chat-activity'

/** Finished children stay out of the pill. The sheet lists them only while it is open for running ones. */
export function NativeChatCompletedSubagents({
  agents,
  onOpen
}: {
  agents: readonly NativeChatSubagentActivity[]
  onOpen: (agentId: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (agents.length === 0) {
    return null
  }
  return (
    <li className="border-t border-border">
      <button
        type="button"
        data-testid="native-chat-completed-subagents"
        aria-expanded={open}
        className="flex w-full items-center px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => setOpen((value) => !value)}
      >
        {translate('components.native-chat.activity.completedSubagents', 'Completed ({{count}})', {
          count: agents.length
        })}
      </button>
      {open
        ? agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="flex w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => onOpen(agent.id)}
            >
              <span className="min-w-0 flex-1 truncate">{agent.label}</span>
            </button>
          ))
        : null}
    </li>
  )
}
