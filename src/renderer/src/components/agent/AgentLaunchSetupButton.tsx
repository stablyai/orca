import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import { flushSync } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { AgentLaunchSetupPanel } from './AgentLaunchSetupPanel'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'

// The menu and its popovers unmount on dismissal; authored setups live for this app session.
type RetainedSetup = {
  authority: string | undefined
  baseline: string
  acceptedBaseline?: string
  draft: AgentPickerDraft
}
type AgentPickerDraftOwner = object
const appSession: AgentPickerDraftOwner = {}
const sessionDrafts = new WeakMap<AgentPickerDraftOwner, Map<string, RetainedSetup>>()

export function invalidateAgentPickerDrafts(scope: AgentPickerDraftOwner) {
  sessionDrafts.delete(scope)
}

export function useAgentPickerDraftScope(resetSignal?: unknown) {
  const scope = useMemo(() => ({ resetSignal }), [resetSignal])
  useEffect(() => () => invalidateAgentPickerDrafts(scope), [scope])
  return scope
}

function baselineOf(draft?: AgentPickerDraft) {
  if (!draft?.recipeEdits) {
    return JSON.stringify(draft) ?? ''
  }
  const { surface: _surface, ...current } = draft.recipeEdits.selection.current
  return JSON.stringify({
    surface: draft.surface,
    current,
    source: draft.recipeEdits.selection.source
  })
}

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
  draftScope = appSession,
  draftId = 'agent',
  initial,
  mode,
  renderAnchor,
  disabled,
  open: controlledOpen,
  replacedByAnotherSetup = false,
  onOpenChange,
  onUse
}: {
  entry: AgentPickerEntry
  draftScope?: AgentPickerDraftOwner
  draftId?: string
  initial?: AgentPickerDraft
  mode?: 'launch' | 'select'
  renderAnchor?: (trigger: ReactElement) => ReactElement
  disabled?: boolean
  open?: boolean
  replacedByAnotherSetup?: boolean
  onOpenChange?: (open: boolean) => void
  onUse: (draft: AgentPickerDraft) => void
}) {
  const scopeGeneration = useRef({ scope: draftScope, version: 0 })
  if (scopeGeneration.current.scope !== draftScope) {
    scopeGeneration.current = { scope: draftScope, version: scopeGeneration.current.version + 1 }
  }
  const draftKey = JSON.stringify([entry.agent, draftId])
  const baseline = baselineOf(initial)
  const drafts = sessionDrafts.get(draftScope) ?? new Map<string, RetainedSetup>()
  const retained = drafts.get(draftKey)
  const matches =
    retained?.authority === entry.ownerKey &&
    (retained?.baseline === baseline || retained?.acceptedBaseline === baseline)
  if (retained && !matches) {
    drafts.delete(draftKey)
  }
  const retainedDraft =
    matches && retained
      ? {
          ...retained.draft,
          ...(retained.acceptedBaseline === baseline && initial?.recipeEdits
            ? { recipeEdits: initial.recipeEdits }
            : {})
        }
      : initial
  const retain = (draft: AgentPickerDraft, accepted = false) => {
    sessionDrafts.set(draftScope, drafts)
    drafts.set(draftKey, {
      authority: entry.ownerKey,
      baseline,
      ...(accepted ? { acceptedBaseline: baselineOf(draft) } : {}),
      draft:
        accepted && draft.recipeEdits
          ? {
              ...draft,
              recipeEdits: { ...draft.recipeEdits, changed: false, argumentsAuthored: false }
            }
          : draft
    })
  }
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
            key={JSON.stringify([
              scopeGeneration.current.version,
              draftKey,
              entry.ownerKey,
              baseline
            ])}
            entry={entry}
            mode={mode}
            initial={retainedDraft}
            disabled={disabled}
            onDraftChange={(draft) => retain(draft)}
            onUse={(draft) => {
              if (mode === 'select') {
                retain(draft, true)
              }
              onUse(draft)
              changeOpen(false)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
