import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../agent-launch/permissions/agent-chat-permission-mode-option-id'
import type { AgentSessionWriteFailure } from '../../failures/agent-session-write-failure'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../native-chat/input/native-chat-session-options'
import { encodeStructuredAgentSessionOptionValue } from '../selection/structured-agent-session-option-codec'
import { canSetStructuredAgentSessionOption } from '../view/structured-agent-session-option-snapshot'
import {
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../structured-agent-session-options'
import type {
  SelectionOperation,
  SelectionOutcome,
  StructuredSessionSelectionController
} from '../selection/structured-agent-session-selection-operations'

type WriteContext = {
  controller: StructuredSessionSelectionController
  record: StructuredAgentSessionOptionState['record']
  view: StructuredAgentSessionOptionState
  snapshot: SessionOptionDescriptor[]
  ready: boolean
  providerStarting: boolean
  /** Reopened, or past its first turn or send: its value picks never adopt a new-chat model. */
  existingChat: boolean
  isCurrentContext: () => boolean
  hold?: (
    id: string,
    encoded: string,
    view: StructuredAgentSessionOptionState
  ) => Promise<SelectionOutcome> | null
  /** `queued` is true when it sends picks taken before the chat attached. */
  flush: (isCurrent: () => boolean, queued?: boolean) => void
  /** The chat has not attached: picks wait for flushQueued, and setOption returns once taken. */
  queues?: boolean
  capturePresentation?: () => () => boolean
  presentFailure?: (failure: AgentSessionWriteFailure) => void
  revalidate: () => void
  revalidateOn: 'settled' | 'refused-current'
}

type IssueReceipt = Pick<WriteContext, 'controller' | 'record' | 'providerStarting'> & {
  operation: SelectionOperation
}

export function acceptedStructuredSessionSelectionOutcome(
  pick: Pick<SelectionOperation, 'key' | 'value'>,
  options?: Readonly<Record<string, string>>
): SelectionOutcome {
  return { kind: 'accepted', options: options ?? { [pick.key]: pick.value } }
}

type WriteAdmissionContext = Pick<
  WriteContext,
  'controller' | 'view' | 'snapshot' | 'ready' | 'providerStarting' | 'isCurrentContext'
>

export function admitsStructuredAgentSessionOption(
  context: WriteAdmissionContext,
  id: string,
  value: SessionOptionValue
): boolean {
  const { controller, view } = context
  const encoded = encodeStructuredAgentSessionOptionValue(id, value)
  const pending =
    !context.providerStarting &&
    id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
    controller.isPending(id)
  return !(
    !context.isCurrentContext() ||
    !context.ready ||
    (!view.catalog && id !== 'interactionMode') ||
    encoded === null ||
    (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
      value === 'own' &&
      !view.permissionOwnSupported) ||
    !canSetStructuredAgentSessionOption(view, id, value, context.snapshot, context.ready, pending)
  )
}

/** Presentation uses the same admission rule as live picks, without feeding it back into the writer. */
export function structuredAgentSessionOptionAvailability(
  context: WriteAdmissionContext
): SessionOptionDescriptor[] {
  return context.snapshot.map((descriptor) =>
    descriptor.id === 'interactionMode' && descriptor.kind.type === 'select'
      ? {
          ...descriptor,
          settable:
            descriptor.settable &&
            admitsStructuredAgentSessionOption(
              context,
              descriptor.id,
              descriptor.kind.currentValue ?? 'default'
            )
        }
      : descriptor
  )
}

/** One action transaction over the existing finite operation controller. */
export function createStructuredAgentSessionOptionsWriteOwner(read: () => WriteContext) {
  let receipt: IssueReceipt | undefined
  let attachment = 0
  return {
    admits: (id: string, value: SessionOptionValue) =>
      admitsStructuredAgentSessionOption(read(), id, value),
    pendingOptionId(
      controller: StructuredSessionSelectionController,
      record: WriteContext['record']
    ): string | null {
      if (
        !receipt ||
        receipt.controller !== controller ||
        receipt.record !== record ||
        receipt.providerStarting ||
        receipt.operation.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      ) {
        return null
      }
      // Only the latest issue chooses the key; older requests cannot resurrect a lock.
      return controller.isPending(receipt.operation.key) ? receipt.operation.key : null
    },
    detach(): void {
      attachment += 1
      receipt = undefined
    },
    /** Sends picks taken before attach; the latest one locks the picker as a live pick does. */
    flushQueued(): void {
      const context = read()
      const issuedAttachment = attachment
      if (receipt && receipt.controller === context.controller && !receipt.operation.transmitted) {
        receipt = {
          ...receipt,
          record: context.record,
          providerStarting: context.providerStarting
        }
      }
      context.flush(() => issuedAttachment === attachment && context.isCurrentContext(), true)
    },
    async setOption(id: string, value: SessionOptionValue): Promise<boolean> {
      const context = read()
      const { controller, view } = context
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (!admitsStructuredAgentSessionOption(context, id, value) || encoded === null) {
        return false
      }
      const issuedAttachment = attachment
      const isCurrent = () => {
        const current = read()
        return (
          issuedAttachment === attachment &&
          context.isCurrentContext() &&
          current.controller === controller &&
          current.record === context.record
        )
      }
      // Notices follow the platform's presentation scope; a record reset on the same chat still reports.
      const settled = (outcome: SelectionOutcome, presents: boolean) => {
        if (
          (outcome.kind === 'refused' || outcome.kind === 'unknown') &&
          outcome.failure &&
          presents
        ) {
          context.presentFailure?.(outcome.failure)
        }
        if (context.revalidateOn === 'settled' || (outcome.kind === 'refused' && isCurrent())) {
          context.revalidate()
        }
      }
      if (context.hold) {
        const held = context.hold(id, encoded, view)
        // Held picks precede any presentation scope, so every refusal reports.
        void held?.then((outcome) => settled(outcome, outcome.kind === 'refused'))
        return held !== null
      }
      const presents = context.capturePresentation?.()
      const pick = structuredAgentSessionOptionPicks(
        view,
        { [id]: encoded },
        context.existingChat
      )[0]
      const operation = controller.issue(
        id,
        encoded,
        pick?.modelId ?? null,
        undefined,
        (operation) => {
          receipt = {
            operation,
            controller,
            record: context.record,
            providerStarting: context.providerStarting
          }
        },
        pick?.adoptModelAsLaunchDefault === false ? false : undefined
      )
      context.flush(isCurrent)
      if (context.queues) {
        void operation.result.then((outcome) => settled(outcome, presents?.() ?? true))
        return operation.outcome?.kind !== 'refused'
      }
      const outcome = await operation.result
      settled(outcome, presents?.() ?? true)
      return outcome.kind !== 'refused'
    }
  }
}
