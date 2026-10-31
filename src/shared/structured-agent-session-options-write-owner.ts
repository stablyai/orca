import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'
import type { AgentSessionWriteFailure } from './agent-session-write-failure'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from './native-chat/input/native-chat-session-options'
import { encodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'
import {
  canSetStructuredAgentSessionOption,
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type {
  SelectionOperation,
  SelectionOutcome,
  StructuredSessionSelectionController
} from './structured-agent-session-selection-operations'

type WriteContext = {
  controller: StructuredSessionSelectionController
  record: StructuredAgentSessionOptionState['record']
  view: StructuredAgentSessionOptionState
  snapshot: SessionOptionDescriptor[]
  ready: boolean
  providerStarting: boolean
  isCurrentContext: () => boolean
  hold?: (
    id: string,
    encoded: string,
    view: StructuredAgentSessionOptionState
  ) => Promise<SelectionOutcome> | null
  flush: (isCurrent: () => boolean) => void
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

/** One action transaction over the existing finite operation controller. */
export function createStructuredAgentSessionOptionsWriteOwner(read: () => WriteContext) {
  let receipt: IssueReceipt | undefined
  let attachment = 0
  return {
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
    async setOption(id: string, value: SessionOptionValue): Promise<boolean> {
      const context = read()
      const { controller, view } = context
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      const pending =
        !context.providerStarting &&
        id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
        controller.isPending(id)
      if (
        !context.isCurrentContext() ||
        !context.ready ||
        !view.catalog ||
        encoded === null ||
        (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
          value === 'own' &&
          !view.permissionOwnSupported) ||
        !canSetStructuredAgentSessionOption(
          view,
          id,
          value,
          context.snapshot,
          context.ready,
          pending
        )
      ) {
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
      const model = structuredAgentSessionOptionPicks(view, { [id]: encoded })[0]?.modelId ?? null
      const operation = controller.issue(id, encoded, model, undefined, (operation) => {
        receipt = {
          operation,
          controller,
          record: context.record,
          providerStarting: context.providerStarting
        }
      })
      context.flush(isCurrent)
      const outcome = await operation.result
      settled(outcome, presents?.() ?? true)
      return outcome.kind !== 'refused'
    }
  }
}
