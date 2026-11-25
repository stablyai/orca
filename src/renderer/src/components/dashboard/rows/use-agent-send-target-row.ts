import { useCallback, type MouseEvent } from 'react'
import type { SendTarget } from '@/components/sidebar/workspace-card/activity/worktree-agent-branch-context'

const NESTED_CONTROL_SELECTOR = 'button, a, input, textarea, select, [role="button"]'

/** Row handlers that turn an agent row into a send-popover target while target mode is on. */
export function useAgentSendTargetRow(
  paneKey: string,
  sendTargetStatus: SendTarget['status'] | undefined,
  onSendTargetClick: ((paneKey: string) => void) | undefined
): { onClickCapture: (e: MouseEvent) => void; onMouseDown: (e: MouseEvent) => void } {
  const onClickCapture = useCallback(
    (e: MouseEvent) => {
      if (!sendTargetStatus) {
        return
      }
      const target = e.target
      if (target instanceof Element && target.closest(NESTED_CONTROL_SELECTOR)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (sendTargetStatus === 'eligible') {
        onSendTargetClick?.(paneKey)
      }
    },
    [paneKey, onSendTargetClick, sendTargetStatus]
  )
  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      // Why: rows aren't focusable, so mousedown focuses the sidebar scroll container and the non-modal send menu dismisses on focus-outside before the click can send.
      if (sendTargetStatus) {
        e.preventDefault()
      }
    },
    [sendTargetStatus]
  )
  return { onClickCapture, onMouseDown }
}
