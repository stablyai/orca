import React, { useEffect, useId, useRef } from 'react'
import { DropdownMenuItem, useCloseDropdownMenu } from '@/components/ui/dropdown-menu'
import { AgentSurfaceLaunchButton } from '@/components/agent/AgentSurfaceLaunchButton'
import {
  keepLaunchItemHighlight,
  LAUNCH_ROW_ATTRIBUTE,
  LAUNCH_ROW_REVEAL,
  returnToLaunchItem
} from '@/components/agent/agent-launch-row'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch-picker-rows'
import { rowTitle } from './tab-agent-row-presentation'
import { terminalPendingReason } from './new-tab-agent-menu-model'

// Why: the row starts its own surface; the button beside it (or ArrowRight, then Enter) opens the other.
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
  // Radix chooses the item a press-and-drag releases on; the button beside it does the same.
  // Set while a press that began on the button is down; it removes its own window listeners.
  const endPress = useRef<(() => void) | null>(null)
  useEffect(() => () => endPress.current?.(), [])
  const closeMenu = useCloseDropdownMenu()
  const reasonId = useId()
  const title = rowTitle(row, label)
  const unavailable = terminalPendingReason(terminalPending, row)
  const otherUnavailable = terminalPendingReason(terminalPending, other)
  return (
    <div
      {...LAUNCH_ROW_ATTRIBUTE}
      className="flex items-center rounded-[7px] pr-2 has-[[data-highlighted]]:bg-black/8 dark:has-[[data-highlighted]]:bg-white/14"
    >
      <DropdownMenuItem
        variant="launch-row"
        className="min-w-0 flex-1"
        disabled={disabled}
        // A waiting launch stays focusable so arrow keys still reach it and the other surface.
        aria-disabled={disabled || !!unavailable || undefined}
        aria-describedby={unavailable ? reasonId : undefined}
        onSelect={(event) => {
          if (unavailable) {
            event.preventDefault()
            return
          }
          runLaunch(row)
        }}
        title={unavailable ?? title}
        aria-label={title}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !otherUnavailable) {
            event.preventDefault()
            otherButton.current?.focus()
          }
        }}
        onPointerLeave={keepLaunchItemHighlight}
      >
        {children}
        {unavailable ? (
          <span id={reasonId} className="font-normal text-muted-foreground">
            {unavailable}
          </span>
        ) : null}
      </DropdownMenuItem>
      <AgentSurfaceLaunchButton
        ref={otherButton}
        surface={other.kind === 'chat' ? 'chat' : 'terminal'}
        disabled={disabled}
        reason={otherUnavailable}
        title={rowTitle(other, label)}
        className={`hover:bg-accent focus-visible:bg-accent ${LAUNCH_ROW_REVEAL}`}
        onPointerDown={() => {
          endPress.current?.()
          // Ends wherever the press is released or cancelled, so it can't swallow a later drag release.
          const end = () => {
            window.removeEventListener('pointerup', end)
            window.removeEventListener('pointercancel', end)
            if (endPress.current === end) {
              endPress.current = null
            }
          }
          endPress.current = end
          window.addEventListener('pointerup', end)
          window.addEventListener('pointercancel', end)
        }}
        onPointerUp={(event) => {
          if (!endPress.current) {
            event.currentTarget.click()
          }
        }}
        onClick={() => {
          if (!disabled && !otherUnavailable) {
            runLaunch(other)
            closeMenu()
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.click()
          } else {
            returnToLaunchItem(event)
          }
        }}
      />
    </div>
  )
}
