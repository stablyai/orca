import { useContext } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { NativeChatWorkerDockFrame } from '../tools/tasks/dock/NativeChatWorkerDockFrame'
import { NativeChatWorkerApprovalStack } from '../worker-approvals/NativeChatWorkerApprovals'
import { useNativeChatPinnedWorkerApprovals } from '../worker-approvals/native-chat-worker-approval-feed'
import {
  NativeChatCrewContext,
  useNativeChatCrew
} from '../../orchestration-crew/use-native-chat-crew'

/** The dock above the composer: the strip while the chat has work or a crew (the suspended crew
 *  panel's strip), and its workers' open prompts whenever there are any, even with no strip. */
export function NativeChatStructuredDock(props: {
  hasWork: boolean
  strip: React.ReactNode
  target: RuntimeClientTarget
  party: string | null
  isVisible: boolean
}) {
  const crew = useNativeChatCrew(useContext(NativeChatCrewContext))
  const approvals = useNativeChatPinnedWorkerApprovals(props.target, props.party)
  const showStrip = props.hasWork || Boolean(crew)
  return showStrip || approvals.length ? (
    <NativeChatWorkerDockFrame>
      {showStrip ? props.strip : null}
      <NativeChatWorkerApprovalStack
        approvals={approvals}
        target={props.target}
        isVisible={props.isVisible}
      />
    </NativeChatWorkerDockFrame>
  ) : null
}
