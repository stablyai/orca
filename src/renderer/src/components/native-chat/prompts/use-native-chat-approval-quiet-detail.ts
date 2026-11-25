import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { approvalDetailPreview } from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-detail-preview'
import { readShellApprovalDetail } from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-shell-detail'

/** A quiet approval's clamped detail: a shell call's command, its other arguments, and whether Details shows. */
export function useNativeChatApprovalQuietDetail(
  detail: string | null,
  toolName: string | undefined,
  description: string | undefined
): {
  text: string | null
  otherArguments: string | null
  textRef: React.RefObject<HTMLDivElement | null>
  otherArgumentsRef: React.RefObject<HTMLDivElement | null>
  open: boolean
  setOpen: (open: boolean) => void
  showsToggle: boolean
} {
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)
  const otherArgumentsRef = useRef<HTMLDivElement>(null)
  const shellDetail = useMemo(
    () => (detail === null ? null : readShellApprovalDetail(detail, toolName, description)),
    [detail, toolName, description]
  )
  const text = shellDetail?.command ?? detail
  const otherArguments = shellDetail?.otherArguments ?? null
  useLayoutEffect(() => {
    const nodes = [textRef.current, otherArgumentsRef.current].filter((node) => node !== null)
    if (nodes.length === 0 || open) {
      return undefined
    }
    const measure = (): void =>
      setClamped(nodes.some((node) => node.scrollHeight > node.clientHeight + 1))
    measure()
    // A narrower pane can wrap a short command past the clamp.
    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }
    const observer = new ResizeObserver(measure)
    for (const node of nodes) {
      observer.observe(node)
    }
    return () => observer.disconnect()
  }, [text, otherArguments, open])
  const showsToggle = text !== null && (open || clamped || approvalDetailPreview(text) !== text)
  return { text, otherArguments, textRef, otherArgumentsRef, open, setOpen, showsToggle }
}
