import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { OdooTicketCommentComposer } from '@/components/odoo-ticket-comment-composer'
import { OdooTicketCommentList } from '@/components/odoo-ticket-comment-list'
import { OdooTicketHeader } from '@/components/odoo-ticket-header'
import { OdooTicketPager } from '@/components/odoo-ticket-pager'
import { isOdooTicketPanelKeepOpenTarget } from '@/components/odoo-ticket-panel-outside-dismiss'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { useAppStore } from '@/store'
import { odooListStages, odooTicketComments, odooUpdateTicket } from '@/runtime/runtime-odoo-client'
import { translate } from '@/i18n/i18n'
import type {
  OdooComment,
  OdooStage,
  OdooTicket,
  OdooTicketUpdate
} from '../../../shared/odoo-types'
type OdooTicketPosition = { index: number; total: number }

type OdooTicketWorkspaceProps = {
  ticket: OdooTicket | null
  onClose: () => void
  onTicketPatched: (ticketId: number, patch: Partial<OdooTicket>) => void
  /** The ticket immediately before/after `ticket` in the currently visible list, if any. */
  previousTicket?: OdooTicket | null
  nextTicket?: OdooTicket | null
  /** `ticket`'s 0-based position within the visible list, for the "3/24" pager label. */
  ticketPosition?: OdooTicketPosition | null
  onNavigate?: (ticket: OdooTicket) => void
}

const PANEL_WIDTH_KEY = 'odoo.ticketPanelWidth'
const DEFAULT_PANEL_WIDTH = 800
const MIN_PANEL_WIDTH = 420

function readStoredPanelWidth(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_PANEL_WIDTH
  }
  const stored = Number(window.localStorage.getItem(PANEL_WIDTH_KEY))
  return Number.isFinite(stored) && stored >= MIN_PANEL_WIDTH ? stored : DEFAULT_PANEL_WIDTH
}

/** Collapsible section header with a rotating chevron and optional count. */
function SectionToggle({
  open,
  onToggle,
  label,
  count
}: {
  open: boolean
  onToggle: () => void
  label: string
  count?: number
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
      <span>{label}</span>
      {typeof count === 'number' ? (
        <span className="text-muted-foreground/70">({count})</span>
      ) : null}
    </button>
  )
}

export function OdooTicketWorkspace({
  ticket,
  onClose,
  onTicketPatched,
  previousTicket = null,
  nextTicket = null,
  ticketPosition = null,
  onNavigate
}: OdooTicketWorkspaceProps): React.JSX.Element {
  const [panelWidth, setPanelWidth] = useState(readStoredPanelWidth)
  const widthRef = useRef(panelWidth)
  const endResizeRef = useRef<(() => void) | null>(null)

  // Why: a drag interrupted by unmount would otherwise leave the window
  // listeners attached and `user-select: none` stuck on the whole app.
  useEffect(() => () => endResizeRef.current?.(), [])

  const startResize = (event: React.PointerEvent): void => {
    event.preventDefault()
    document.body.style.userSelect = 'none'
    const onMove = (moveEvent: PointerEvent): void => {
      const next = Math.min(
        Math.max(window.innerWidth - moveEvent.clientX, MIN_PANEL_WIDTH),
        window.innerWidth * 0.96
      )
      widthRef.current = next
      setPanelWidth(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      endResizeRef.current = null
      document.body.style.userSelect = ''
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(widthRef.current)))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    endResizeRef.current = onUp
  }

  return (
    <Sheet
      open={ticket !== null}
      // Non-modal + click-through overlay keeps the ticket list interactive, so a
      // single click on another ticket swaps the detail without closing first.
      modal={false}
      onOpenChange={(open) => (!open ? onClose() : undefined)}
    >
      <SheetContent
        side="right"
        // The built-in top-right close collides with the OS/app window controls
        // on a full-height right panel; we render our own close in the header.
        showCloseButton={false}
        // Click on the list/toolbar or a filter dropdown keeps the panel open
        // (clicking another row swaps the detail); a click in the void dismisses.
        onInteractOutside={(event) => {
          if (isOdooTicketPanelKeepOpenTarget(event.detail.originalEvent.target)) {
            event.preventDefault()
          }
        }}
        // Why: non-modal — pointer-events-none keeps the ticket list clickable
        // underneath, but the default Sheet scrim/blur still pulls focus onto
        // the open ticket.
        overlayClassName="pointer-events-none"
        style={{ width: panelWidth }}
        className="flex max-w-[96vw] flex-col gap-0 p-0 sm:max-w-none"
      >
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startResize}
          className="group absolute inset-y-0 left-0 z-20 flex w-2 cursor-col-resize items-center justify-center hover:bg-border/30"
        >
          <span className="h-10 w-0.5 rounded bg-border/70 group-hover:bg-foreground/40" />
        </div>
        <VisuallyHidden.Root>
          <SheetTitle>{ticket?.title ?? ''}</SheetTitle>
          <SheetDescription>{ticket?.ref ?? ''}</SheetDescription>
        </VisuallyHidden.Root>
        {ticket ? (
          // Keyed remount resets per-ticket state (draft, comments, stages)
          // without effect-driven state adjustments on prop changes.
          <OdooTicketDetail
            key={`${ticket.instanceId ?? ''}:${ticket.id}`}
            ticket={ticket}
            onClose={onClose}
            onTicketPatched={onTicketPatched}
            previousTicket={previousTicket}
            nextTicket={nextTicket}
            ticketPosition={ticketPosition}
            onNavigate={onNavigate}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function OdooTicketDetail({
  ticket,
  onClose,
  onTicketPatched,
  previousTicket,
  nextTicket,
  ticketPosition,
  onNavigate
}: {
  ticket: OdooTicket
  onClose: () => void
  onTicketPatched: (ticketId: number, patch: Partial<OdooTicket>) => void
  previousTicket: OdooTicket | null
  nextTicket: OdooTicket | null
  ticketPosition: OdooTicketPosition | null
  onNavigate?: (ticket: OdooTicket) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const patchOdooTicket = useAppStore((s) => s.patchOdooTicket)

  const [stages, setStages] = useState<OdooStage[]>([])
  const [comments, setComments] = useState<OdooComment[]>([])
  // Starts true: the keyed remount means this component always begins by
  // loading its ticket's comments, so no effect needs to flip it on.
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  // Description and comments collapse independently.
  const [descriptionOpen, setDescriptionOpen] = useState(true)
  const [commentsOpen, setCommentsOpen] = useState(true)

  const ticketId = ticket.id
  const projectId = ticket.project?.id ?? null
  const instanceId = ticket.instanceId ?? null

  // Depend on the runtime target's identity, not the whole settings object, so
  // unrelated settings writes don't refetch comments/stages while open.
  const runtimeContextKey = getProviderRuntimeContextKey(settings)
  useEffect(() => {
    let cancelled = false
    const activeSettings = useAppStore.getState().settings
    void odooTicketComments(activeSettings, ticketId, instanceId)
      .then((rows) => {
        if (!cancelled) {
          setComments(rows)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setCommentsLoading(false)
        }
      })
    if (projectId !== null) {
      void odooListStages(activeSettings, projectId, instanceId)
        .then((rows) => {
          if (!cancelled) {
            setStages(rows)
          }
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [ticketId, projectId, instanceId, runtimeContextKey])

  const applyUpdate = async (
    updates: OdooTicketUpdate,
    patch: Partial<OdooTicket>
  ): Promise<void> => {
    setSaving(true)
    try {
      const result = await odooUpdateTicket(settings, ticket.id, updates, ticket.instanceId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      patchOdooTicket(ticket.id, ticket.instanceId ?? null, patch)
      onTicketPatched(ticket.id, patch)
      toast.success(
        translate('auto.components.odoo.ticket.workspace.57e34ae785', 'Ticket updated.')
      )
    } catch {
      toast.error(
        translate(
          'auto.components.odoo.ticket.workspace.9311b4efd0',
          'Could not update the ticket.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  const reloadComments = (): void => {
    void odooTicketComments(settings, ticketId, instanceId)
      .then((rows) => setComments(rows))
      .catch(() => undefined)
  }

  return (
    <>
      <OdooTicketPager
        position={ticketPosition}
        hasPrevious={previousTicket !== null}
        hasNext={nextTicket !== null}
        onPrevious={() => previousTicket && onNavigate?.(previousTicket)}
        onNext={() => nextTicket && onNavigate?.(nextTicket)}
      />
      <OdooTicketHeader
        ticket={ticket}
        stages={stages}
        saving={saving}
        onClose={onClose}
        applyUpdate={(updates, patch) => void applyUpdate(updates, patch)}
      />

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek px-5 py-4">
        <SectionToggle
          open={descriptionOpen}
          onToggle={() => setDescriptionOpen((open) => !open)}
          label={translate('auto.components.odoo.ticket.workspace.795c4960cb', 'Description')}
        />
        {descriptionOpen ? (
          ticket.description ? (
            <CommentMarkdown className="mt-2" content={ticket.description} />
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {translate('auto.components.odoo.ticket.workspace.425ca8bd04', 'No description')}
            </p>
          )
        ) : null}

        <div className="my-4 border-t border-border/60" />

        <SectionToggle
          open={commentsOpen}
          onToggle={() => setCommentsOpen((open) => !open)}
          label={translate('auto.components.odoo.ticket.workspace.c4a1981a5a', 'Comments')}
          count={comments.length}
        />
        {commentsOpen ? (
          <OdooTicketCommentList
            comments={comments}
            loading={commentsLoading}
            ticket={ticket}
            onCommentUpdated={reloadComments}
          />
        ) : null}
      </div>

      <OdooTicketCommentComposer ticket={ticket} onPosted={reloadComments} />
    </>
  )
}
