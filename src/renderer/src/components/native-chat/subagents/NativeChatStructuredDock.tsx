import { useContext } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { NativeChatWorkerDockFrame } from '../tools/tasks/dock/NativeChatWorkerDockFrame'
import { WorkerChipPortal } from '../tools/tasks/dock/worker-chip-slot'
import { NativeChatWorkerApprovalStack } from '../worker-approvals/NativeChatWorkerApprovals'
import { useNativeChatPinnedWorkerApprovals } from '../worker-approvals/native-chat-worker-approval-feed'
import {
  NativeChatCrewContext,
  useNativeChatCrew
} from '../../orchestration-crew/use-native-chat-crew'

/** The chat's workers in two places: the worker chip (while the chat has work or a crew: the
 *  suspended crew panel's strip), drawn over the transcript's end above everything docked; and
 *  its workers' open prompts, in the dock above the composer, whenever there are any. */
export function NativeChatStructuredDock(props: {
  part: 'chip' | 'approvals'
  hasWork: boolean
  strip: React.ReactNode
  target: RuntimeClientTarget
  party: string | null
  isVisible: boolean
}) {
  return props.part === 'chip' ? (
    <WorkerChip hasWork={props.hasWork} strip={props.strip} />
  ) : (
    <WorkerApprovals target={props.target} party={props.party} isVisible={props.isVisible} />
  )
}

function WorkerChip({ hasWork, strip }: { hasWork: boolean; strip: React.ReactNode }) {
  const crew = useNativeChatCrew(useContext(NativeChatCrewContext))
  return hasWork || crew ? (
    <WorkerChipPortal>
      <NativeChatWorkerDockFrame overlay>{strip}</NativeChatWorkerDockFrame>
    </WorkerChipPortal>
  ) : null
}

function WorkerApprovals(props: {
  target: RuntimeClientTarget
  party: string | null
  isVisible: boolean
}) {
  const approvals = useNativeChatPinnedWorkerApprovals(props.target, props.party)
  return approvals.length ? (
    <NativeChatWorkerDockFrame>
      <NativeChatWorkerApprovalStack
        approvals={approvals}
        target={props.target}
        isVisible={props.isVisible}
      />
    </NativeChatWorkerDockFrame>
  ) : null
}
