import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'

// Matches the Advanced section's expand transition so the choice is laid out before scrolling.
const REVEAL_AFTER_EXPAND_MS = 220

export function WorkspaceSetupChoice({
  decision,
  onChange,
  disabled = false,
  runLabel,
  skipLabel,
  revealRequest = 0,
  onRevealed
}: {
  decision: 'run' | 'skip' | null
  onChange: (decision: 'run' | 'skip') => void
  disabled?: boolean
  runLabel: string
  skipLabel: string
  revealRequest?: number
  onRevealed?: () => void
}): React.JSX.Element {
  const runButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (revealRequest === 0) {
      return
    }
    if (decision !== null) {
      // Chosen before the reveal fired: drop it rather than move focus onto Run.
      onRevealed?.()
      return
    }
    // A submit without a choice lands here; scroll the choice into the dialog's view and focus it.
    const timer = setTimeout(() => {
      runButtonRef.current?.scrollIntoView({ block: 'nearest' })
      runButtonRef.current?.focus()
      onRevealed?.()
    }, REVEAL_AFTER_EXPAND_MS)
    return () => clearTimeout(timer)
  }, [revealRequest, onRevealed, decision])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        ref={runButtonRef}
        type="button"
        disabled={disabled}
        onClick={() => onChange('run')}
        variant={decision === 'run' ? 'default' : 'outline'}
        size="sm"
      >
        {runLabel}
      </Button>
      <Button
        type="button"
        disabled={disabled}
        onClick={() => onChange('skip')}
        variant={decision === 'skip' ? 'secondary' : 'outline'}
        size="sm"
      >
        {skipLabel}
      </Button>
    </div>
  )
}
