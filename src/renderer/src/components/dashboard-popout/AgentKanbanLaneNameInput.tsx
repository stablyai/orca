import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { DASHBOARD_MAX_LANE_LABEL_LENGTH } from '../../../../shared/dashboard-lanes'

/** Inline lane-name field: Enter or blur commits, Escape cancels. */
export function AgentKanbanLaneNameInput({
  initialValue = '',
  placeholder,
  ariaLabel,
  onCommit,
  onCancel
}: {
  initialValue?: string
  placeholder?: string
  ariaLabel: string
  onCommit: (label: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue)
  const commit = (): void => {
    const trimmed = value.trim()
    if (trimmed && trimmed !== initialValue) {
      onCommit(trimmed)
    } else {
      onCancel()
    }
  }

  return (
    <Input
      autoFocus
      value={value}
      maxLength={DASHBOARD_MAX_LANE_LABEL_LENGTH}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          // Why: Escape would otherwise also close the in-window board.
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
      className="h-7 min-w-0 flex-1"
    />
  )
}
