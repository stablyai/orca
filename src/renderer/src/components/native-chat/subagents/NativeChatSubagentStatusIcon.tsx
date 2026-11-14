import { AgentStateDot, type AgentDotState } from '@/components/AgentStateDot'
import type { NativeChatSubagentState } from '../../../../../shared/native-chat/native-chat-types'

const DOT_STATE: Record<NativeChatSubagentState, AgentDotState> = {
  working: 'working',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  stopped: 'interrupted',
  unverifiable: 'unverifiable'
}

/** The agents strip's status glyph, so a subagent reads the same on every surface. */
export function NativeChatSubagentStatusIcon({
  state
}: {
  state: NativeChatSubagentState
}): React.JSX.Element {
  // The words beside it say the state; the glyph adds no tooltip of its own.
  return <AgentStateDot state={DOT_STATE[state]} size="sm" title={null} />
}
