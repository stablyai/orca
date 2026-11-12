import React, { useRef } from 'react'
import { AgentSurfaceLaunchButton } from '@/components/agent/AgentSurfaceLaunchButton'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { terminalPendingReason } from './new-tab-agent-menu-model'
import { rowTitle } from './tab-agent-row-presentation'
import { useTranslate } from '@/i18n/use-translate'

const ROW_NAVIGATION_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

// Why: the row starts its own surface; its trailing button (or ArrowRight, then Enter) opens the other.
export function TabAgentSurfaceChoiceRow({
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
  runLaunch: (row: NewTabAgentMenuRow) => boolean | void | Promise<boolean>
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const otherButton = useRef<HTMLButtonElement>(null)
  const releaseTarget = useRef<{ event: PointerEvent; target: EventTarget } | null>(null)
  const title = rowTitle(row, label, t)
  return (
    <DropdownMenuItem
      variant="launch"
      disabled={disabled}
      title={title}
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
        const result = runLaunch(
          target instanceof Node && otherButton.current?.contains(target) ? other : row
        )
        if (result === false) {
          event.preventDefault()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' && !terminalPendingReason(terminalPending, other)) {
          event.preventDefault()
          otherButton.current?.focus()
        }
      }}
    >
      <span
        role="button"
        aria-disabled={!!terminalPendingReason(terminalPending, row, t) || undefined}
        aria-description={terminalPendingReason(terminalPending, row, t)}
        className="contents"
      >
        {children}
      </span>
      <AgentSurfaceLaunchButton
        ref={otherButton}
        surface={other.kind === 'chat' ? 'chat' : 'terminal'}
        title={rowTitle(other, label, t)}
        reason={terminalPendingReason(terminalPending, other, t)}
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
