import type { ComponentProps } from 'react'
import { NativeChatTurnActivityLine } from '../reasoning/NativeChatTurnActivityLine'
import { NativeChatAwaitingInputRow } from '../../prompts/NativeChatAwaitingInputRow'
export function NativeChatTranscriptTail({
  line,
  awaiting
}: {
  line: ComponentProps<typeof NativeChatTurnActivityLine>['line'] | null | undefined
  awaiting: boolean
}): React.JSX.Element | null {
  if (line) {
    return <NativeChatTurnActivityLine line={line} />
  }
  return awaiting ? <NativeChatAwaitingInputRow subject={null} pending /> : null
}
