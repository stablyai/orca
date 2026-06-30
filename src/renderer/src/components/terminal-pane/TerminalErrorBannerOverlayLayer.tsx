/**
 * @vitest-environment happy-dom
 */
import type React from 'react'
import { useAppStore } from '@/store'
import { TerminalErrorBanner } from './TerminalErrorBanner'
import type { TerminalErrorEntry } from '@/store/slices/terminal-errors'

// Why: split panes sharing one multiplex runtime all push to the same
// store slice, so the banner should mount once per workspace rather than
// once per pane. Keying on worktreeId keeps each workspace independent.
export function TerminalErrorBannerOverlayLayer({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const errors = useAppStore((s) => s.terminalErrorsByWorktreeId[worktreeId])
  const clear = useAppStore((s) => s.clearTerminalErrors)
  if (!errors || errors.length === 0) {
    return null
  }
  return (
    <TerminalErrorBanner
      errors={errors as TerminalErrorEntry[]}
      onDismiss={() => clear(worktreeId)}
    />
  )
}
