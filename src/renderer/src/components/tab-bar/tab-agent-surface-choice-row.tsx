import React, { useRef } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AgentSurfaceLaunchButton } from '@/components/agent/AgentSurfaceLaunchButton'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import { rowTitle } from './tab-agent-row-presentation'
import { terminalPendingReason } from './new-tab-agent-menu-model'

const ROW_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

// Why: the row starts its own surface; its trailing button (or ArrowRight, then Enter) opens the other.
export function SurfaceChoiceRow({
  row,
  other,
  label,
  disabled,
  terminalPending,
  runLaunch,
  children
}: {
  row: NewTabAgentMenuRow
  other: NewTabAgentMenuRow
  label: string
  disabled: boolean
  terminalPending?: boolean
  runLaunch: (row: NewTabAgentMenuRow) => void
  children: React.ReactNode
}): React.JSX.Element {
  const otherButton = useRef<HTMLButtonElement>(null)
  const releaseTarget = useRef<{ event: PointerEvent; target: EventTarget } | null>(null)
  const title = rowTitle(row, label)
  const selectedOther = useRef(false)
  const unavailable = terminalPendingReason(terminalPending, row)
  const otherUnavailable = terminalPendingReason(terminalPending, other)
  return (
    <DropdownMenuItem
      variant="launch"
      disabled={disabled || (!!unavailable && !!otherUnavailable)}
      aria-disabled={disabled || !!unavailable}
      onSelect={(event) => {
        if (unavailable && !selectedOther.current) {
          event.preventDefault()
        }
      }}
      title={unavailable ?? title}
      aria-label={title}
      onPointerUp={(event) => {
        // Radix synchronously clicks the row on drag release, discarding the release target.
        const release = { event: event.nativeEvent, target: event.target }
        releaseTarget.current = release
        queueMicrotask(() => {
          if (releaseTarget.current === release) {
            releaseTarget.current = null
          }
        })
      }}
      onClick={(event) => {
        const release = releaseTarget.current
        releaseTarget.current = null
        if (disabled) {
          return
        }
        const target =
          event.target === event.currentTarget && release && release.event.eventPhase !== Event.NONE
            ? release.target
            : event.target
        selectedOther.current = target instanceof Node && !!otherButton.current?.contains(target)
        if (selectedOther.current ? !otherUnavailable : !unavailable) {
          runLaunch(selectedOther.current ? other : row)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' && !otherUnavailable) {
          event.preventDefault()
          otherButton.current?.focus()
        }
      }}
    >
      {children}
      {unavailable ? (
        <span className="font-normal text-muted-foreground">{unavailable}</span>
      ) : null}
      <AgentSurfaceLaunchButton
        ref={otherButton}
        surface={other.kind === 'chat' ? 'chat' : 'terminal'}
        disabled={disabled || !!otherUnavailable}
        title={otherUnavailable ?? rowTitle(other, label)}
        className="hover:bg-accent focus-visible:bg-accent [[data-highlighted]_&]:opacity-100"
        onKeyDown={(event) => {
          // Stopped so the row's own Enter handling does not start the row's surface instead.
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          } else if (ROW_NAVIGATION_KEYS.has(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            const item = event.currentTarget.closest<HTMLElement>('[role="menuitem"]')
            item?.focus()
            // Why: roving focus ignores keys from inside an item, so the row replays the move.
            if (event.key !== 'ArrowLeft') {
              item?.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }))
            }
          }
        }}
      />
    </DropdownMenuItem>
  )
}
