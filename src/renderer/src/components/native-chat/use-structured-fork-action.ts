import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { structuredForkTurnAnchors } from '../../../../shared/agent-session-prefix'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import { forkStructuredSessionFromTurn } from './structured-agent-session-fork-command'
import { activateStructuredAgentSessionById } from '@/lib/structured-agent-session-tab-activation'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate } from '@/i18n/i18n'

const NO_ANCHORS: ReadonlyMap<string, string> = new Map()

export function useStructuredForkAction(
  props: Omit<NativeChatStructuredViewProps, 'mode'>,
  controller: ReturnType<typeof useStructuredAgentSession>,
  worktreeId: string | undefined,
  onError: (message: string) => void
) {
  const [pending, setPending] = useState(false)
  const agent = props.agent === 'claude' ? 'claude' : props.agent === 'codex' ? 'codex' : undefined
  const enabled = Boolean(
    controller.forkSupported &&
    controller.forkSource &&
    worktreeId &&
    !controller.isWorking &&
    agent
  )
  // Hooks cannot be skipped, so the unavailable case is gated inside the memo instead: a live turn
  // emits a journal delta per frame and every one of them would rescan for a discarded result.
  const anchors = useMemo(
    () => (enabled ? structuredForkTurnAnchors(controller.journalItems ?? []) : NO_ANCHORS),
    [enabled, controller.journalItems]
  )
  const eligibleIds = useMemo(() => new Set(anchors.values()), [anchors])
  // Read through the fields, not the object: `forkSource` is rebuilt every render, and depending on
  // it would hand every eligible row a new handler and defeat the row memo.
  const sourceSessionId = controller.forkSource?.sessionId
  const expectedEpoch = controller.forkSource?.expectedEpoch
  const expectedRuntimeFence = controller.forkSource?.expectedRuntimeFence
  const target = props.target
  const onFork = useCallback(
    (itemId: string) => {
      // The clicked row resolves to its TURN's anchor, so the command's replay key names the turn:
      // two rows of one turn join a single attempt instead of minting two identical children.
      const anchor = anchors.get(itemId)
      if (
        !anchor ||
        !worktreeId ||
        !agent ||
        sourceSessionId === undefined ||
        expectedEpoch === undefined ||
        expectedRuntimeFence === undefined
      ) {
        return
      }
      setPending(true)
      void forkStructuredSessionFromTurn({
        target,
        worktree: toRuntimeWorktreeSelector(worktreeId),
        agent,
        source: { sessionId: sourceSessionId, itemId: anchor, expectedEpoch, expectedRuntimeFence }
      })
        .then((sessionId) => {
          // The child is published without taking the surface, so the toast is how the user reaches
          // it — leaving the conversation they were reading stays their choice.
          toast.success(
            translate('components.native-chat.forkCreated', 'Forked this turn into a new chat'),
            {
              action: {
                label: translate('components.native-chat.openForkedChat', 'Open forked chat'),
                onClick: () => {
                  activateStructuredAgentSessionById({ worktreeId, sessionId })
                }
              }
            }
          )
        })
        .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
        .finally(() => setPending(false))
    },
    [
      agent,
      anchors,
      expectedEpoch,
      expectedRuntimeFence,
      onError,
      sourceSessionId,
      target,
      worktreeId
    ]
  )
  if (!enabled || !controller.forkSource || !worktreeId || !agent) {
    return undefined
  }
  return { eligibleIds, pending, onFork }
}
