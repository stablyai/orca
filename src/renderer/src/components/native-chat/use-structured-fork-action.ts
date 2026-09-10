import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  structuredForkEligibleItems,
  structuredForkTurnAnchors
} from '../../../../shared/agent-session-prefix'
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
  // Deliberately NOT gated on `controller.isWorking`. The host is per-turn — it refuses only the
  // LIVE turn as `busy` and serves every settled one — so gating the whole hook on session-level
  // work stripped the action off every turn in the chat the moment any turn started streaming,
  // which is exactly when branching off an earlier answer is most useful. `structuredForkTurnAnchors`
  // already withholds the running turn.
  const enabled = Boolean(controller.forkSupported && controller.forkSource && worktreeId && agent)
  // Hooks cannot be skipped, so the unavailable case is gated inside the memo instead.
  const anchors = useMemo(
    () => (enabled ? structuredForkTurnAnchors(controller.journalItems ?? []) : NO_ANCHORS),
    [enabled, controller.journalItems]
  )
  const eligibleIds = useMemo(() => structuredForkEligibleItems(anchors), [anchors])
  // A live turn republishes the journal every frame, so the anchor map is a new object every frame.
  // Reading it through a ref keeps `onFork` stable, or each frame would hand every anchor row a new
  // handler and re-render it — the cost the row memo exists to avoid.
  const anchorsRef = useRef(anchors)
  useEffect(() => {
    anchorsRef.current = anchors
  }, [anchors])
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
      const anchor = anchorsRef.current.get(itemId)
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
    [agent, expectedEpoch, expectedRuntimeFence, onError, sourceSessionId, target, worktreeId]
  )
  if (!enabled || !controller.forkSource || !worktreeId || !agent) {
    return undefined
  }
  return { eligibleIds, pending, onFork }
}
