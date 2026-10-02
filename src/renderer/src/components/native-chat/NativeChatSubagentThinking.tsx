import type { NativeChatSubagentEntry } from '../../../../shared/native-chat-types'
import {
  nativeChatSubagentThinkingLabel,
  useNativeChatSubagentThinking
} from './native-chat-reasoning-open-context'

/** "Thinking" beside a subagent's name on a section head, in the type its roster entry's state text
 *  uses. */
export function NativeChatSubagentThinking({
  agentId,
  entry
}: {
  agentId: string
  entry: Pick<NativeChatSubagentEntry, 'state'> | undefined
}): React.JSX.Element | null {
  const thinking = useNativeChatSubagentThinking()
  if (!thinking(agentId, entry)) {
    return null
  }
  return (
    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
      {nativeChatSubagentThinkingLabel()}
    </span>
  )
}
