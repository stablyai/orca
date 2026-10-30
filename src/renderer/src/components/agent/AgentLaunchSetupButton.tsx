import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'

// The menu and its popovers unmount on dismissal; authored setups live for this app session.
const sessionDrafts = new Map<string, AgentPickerDraft>()

function setupKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.click()
  } else if (['ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    const row = event.currentTarget.closest<HTMLElement>('[role="menuitem"]')
    if (row) {
      event.preventDefault()
      event.stopPropagation()
      row.focus()
      if (event.key !== 'ArrowLeft') {
        row.dispatchEvent(new window.KeyboardEvent('keydown', { key: event.key, bubbles: true }))
      }
    }
  }
}

export function AgentLaunchSetupButton({
  entry,
  initial,
  renderAnchor,
  disabled,
  open: controlledOpen,
  replacedByAnotherSetup = false,
  onOpenChange,
  onUse
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  renderAnchor?: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  open?: boolean
  replacedByAnotherSetup?: boolean
  onOpenChange?: (open: boolean) => void
  onUse: (draft: AgentPickerDraft) => void
}) {
  const draftKey = JSON.stringify([entry.ownerKey, entry.agent, initial])
  const [localOpen, setOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const closeFocus = useRef({ open, restore: true })
  useLayoutEffect(() => {
    if (closeFocus.current.open && !open) {
      // Preserve the close cause until Radix's deferred unmount autofocus runs.
      closeFocus.current.restore = !replacedByAnotherSetup
    }
    closeFocus.current.open = open
  }, [open, replacedByAnotherSetup])
  const [placement, setPlacement] = useState<'right' | 'bottom'>('right')
  const content = useRef<HTMLDivElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) {
      return
    }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      // Let Radix publish collision space after the external resize and horizontal placement.
      frame = requestAnimationFrame(() => {
        flushSync(() => setPlacement('right'))
        frame = requestAnimationFrame(() => {
          if (!content.current) {
            return
          }
          const style = window.getComputedStyle(content.current)
          const available = Number.parseFloat(
            style.getPropertyValue('--radix-popover-content-available-width')
          )
          if (available < Number.parseFloat(style.minWidth)) {
            setPlacement('bottom')
          }
        })
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(document.documentElement)
    if (anchor.current) {
      observer.observe(anchor.current)
    }
    measure()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [open])
  const changeOpen = (next: boolean) => {
    if (next) {
      setPlacement('right')
    }
    if (controlledOpen === undefined) {
      setOpen(next)
    }
    onOpenChange?.(next)
  }
  const trigger = (
    <div className="flex shrink-0 items-center gap-1">
      <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
            agent: entry.label
          })}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={setupKeyDown}
        >
          <ChevronRight className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
    </div>
  )
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      {renderAnchor ? (
        <PopoverAnchor asChild ref={anchor}>
          {renderAnchor(trigger)}
        </PopoverAnchor>
      ) : (
        trigger
      )}
      <PopoverContent
        ref={content}
        side={placement}
        sticky="always"
        align="start"
        sideOffset={6}
        aria-label={translate('agentPicker.configure', 'Configure {{agent}}', {
          agent: entry.label
        })}
        className="flex w-104 min-w-64 max-w-(--radix-popover-content-available-width) max-h-(--radix-popover-content-available-height) flex-col"
        onClick={(event) => event.stopPropagation()}
        // Hovering another menu row moves focus there; only a click outside or Escape closes the panel.
        onFocusOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          if (!closeFocus.current.restore) {
            event.preventDefault()
          }
        }}
      >
        <div className="min-h-0 overflow-y-auto scrollbar-sleek">
          <AgentLaunchSetupPanel
            key={draftKey}
            entry={entry}
            initial={sessionDrafts.get(draftKey) ?? initial}
            disabled={disabled}
            onDraftChange={(draft) => sessionDrafts.set(draftKey, draft)}
            onUse={(draft) => {
              onUse(draft)
              changeOpen(false)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
