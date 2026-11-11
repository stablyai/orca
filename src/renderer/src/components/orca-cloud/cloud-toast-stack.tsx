// The persistent Orca Cloud toasts (agent sign-in prompt, push / setup notices) share one look and
// one order (DS-q):
// - Chrome: × inside the card at the top right; ⚠ only on warnings; one action, outline unless it
//   is the next required step (primary).
// - Order: sonner shows the newest toast on top, but the collapsed top card must be the most
//   important one: action-required, then warnings, then info; recency breaks ties within a tier.
//   When a less important toast arrives above a more important one, the more important one is
//   re-added on top under a fresh internal id.
// Re-adding never re-announces (its card stays aria-hidden for a moment), never animates in (no
// flicker), and keeps the toast's logical identity and state: content is rendered from this
// module's state by logical id, and × dismisses the logical toast.
import React, { useSyncExternalStore } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'

export type CloudToastPriority = 'action' | 'warning' | 'info'

export type CloudToastAction = {
  label: string
  onClick: () => void
  /** The next required step: a single primary button. Everything else is outline. */
  primary?: boolean
  icon?: React.ReactNode
  pending?: boolean
}

export type CloudToastLine = {
  /** Stable per line inside one toast (a toast may hold several lines). */
  key: string
  text: string
  description?: string
  action?: CloudToastAction
  /** Per-line ×; absent means the toast's own × closes it. */
  onDismissLine?: () => void
}

export type CloudToastView = {
  priority: CloudToastPriority
  lines: readonly CloudToastLine[]
  /** Accessible name of the card when it holds several lines. */
  label?: string
}

type Entry = {
  view: CloudToastView
  /** Called when the user closes it with ×; never on an internal re-add. */
  onDismiss?: () => void
  seq: number
  internalId: string
  generation: number
  /** Re-added: hide from assistive tech until this time (it was announced already). */
  quietUntil: number
}

/** How long a re-added card stays hidden from assistive tech: longer than the live region's read. */
export const READD_QUIET_MS = 1_000
const RANK: Record<CloudToastPriority, number> = { info: 0, warning: 1, action: 2 }

let entries = new Map<string, Entry>()
/** Logical ids in the order their current internal toast was added to sonner (bottom → top). */
let sonnerOrder: string[] = []
let seqCounter = 0
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function desiredOrder(): string[] {
  return [...entries.entries()]
    .sort(([, a], [, b]) => RANK[a.view.priority] - RANK[b.view.priority] || a.seq - b.seq)
    .map(([id]) => id)
}

/** Long enough for the re-added card to settle, after which it animates like any other toast. */
const READD_STILL_MS = 600

function addToSonner(logicalId: string, entry: Entry, readd: boolean): void {
  const internalId = entry.internalId
  const add = (className: string): void => {
    toast.custom(() => <CloudToastHost logicalId={logicalId} />, {
      id: internalId,
      duration: Number.POSITIVE_INFINITY,
      unstyled: true,
      dismissible: false,
      className
    })
  }
  // A re-add must look like the card stayed put: no slide-in. Later stack moves animate as usual.
  add(readd ? 'cloud-toast-readd' : '')
  if (readd) {
    setTimeout(() => {
      if (entries.get(logicalId)?.internalId === internalId) {
        add('')
      }
    }, READD_STILL_MS)
  }
}

/** Puts sonner's order right: everything from the first misplaced card up is re-added on top. */
function reconcile(now: number): void {
  const desired = desiredOrder()
  sonnerOrder = sonnerOrder.filter((id) => entries.has(id))
  let firstDiff = 0
  while (
    firstDiff < desired.length &&
    firstDiff < sonnerOrder.length &&
    desired[firstDiff] === sonnerOrder[firstDiff]
  ) {
    firstDiff += 1
  }
  for (const id of desired.slice(firstDiff)) {
    const entry = entries.get(id)
    if (!entry) {
      continue
    }
    const wasShown = sonnerOrder.includes(id)
    if (wasShown) {
      // Take the old card away without its exit animation, then add the new one on top.
      toast.custom(() => null, {
        id: entry.internalId,
        unstyled: true,
        className: 'cloud-toast-gone'
      })
      toast.dismiss(entry.internalId)
      entry.generation += 1
      entry.internalId = `${id}#${entry.generation}`
      entry.quietUntil = now + READD_QUIET_MS
    }
    addToSonner(id, entry, wasShown)
  }
  sonnerOrder = desired
}

/** Shows or updates a persistent cloud toast. Updating keeps its place and state. */
export function showCloudToast(
  logicalId: string,
  view: CloudToastView,
  options: { onDismiss?: () => void } = {},
  now = Date.now()
): void {
  const existing = entries.get(logicalId)
  if (existing) {
    const priorityChanged = existing.view.priority !== view.priority
    existing.view = view
    existing.onDismiss = options.onDismiss
    if (priorityChanged) {
      reconcile(now)
    }
    emit()
    return
  }
  seqCounter += 1
  entries.set(logicalId, {
    view,
    onDismiss: options.onDismiss,
    seq: seqCounter,
    internalId: `${logicalId}#0`,
    generation: 0,
    quietUntil: 0
  })
  reconcile(now)
  emit()
}

/** Takes a toast down without telling its owner (it asked, or its workspace went away). */
export function hideCloudToast(logicalId: string): void {
  const entry = entries.get(logicalId)
  if (!entry) {
    return
  }
  entries.delete(logicalId)
  sonnerOrder = sonnerOrder.filter((id) => id !== logicalId)
  toast.dismiss(entry.internalId)
  emit()
}

/** The user closed it with ×: down, and its owner is told (by logical id). */
export function dismissCloudToastByUser(logicalId: string): void {
  const onDismiss = entries.get(logicalId)?.onDismiss
  hideCloudToast(logicalId)
  onDismiss?.()
}

export function isCloudToastShown(logicalId: string): boolean {
  return entries.has(logicalId)
}

/** Test seam: the internal sonner id a logical toast currently uses. */
export function cloudToastInternalId(logicalId: string): string | null {
  return entries.get(logicalId)?.internalId ?? null
}

/** Test seam. */
export function resetCloudToasts(): void {
  entries = new Map()
  sonnerOrder = []
  seqCounter = 0
  emit()
}

function useEntry(logicalId: string): Entry | undefined {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version
  )
  return entries.get(logicalId)
}

function CloudToastHost({ logicalId }: { logicalId: string }): React.JSX.Element | null {
  const entry = useEntry(logicalId)
  const [now, setNow] = React.useState(() => Date.now())
  const quietFor = entry ? entry.quietUntil - now : 0
  React.useEffect(() => {
    if (quietFor <= 0) {
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), quietFor)
    return () => clearTimeout(timer)
  }, [quietFor])
  if (!entry) {
    return null
  }
  return (
    <CloudToastCard
      view={entry.view}
      quiet={quietFor > 0}
      onDismiss={() => dismissCloudToastByUser(logicalId)}
    />
  )
}

/** The shared card. Exported for fixtures and tests; live toasts go through showCloudToast. */
export function CloudToastCard({
  view,
  quiet = false,
  onDismiss
}: {
  view: CloudToastView
  /** Re-added: already announced, so hidden from assistive tech for a moment. */
  quiet?: boolean
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const warning = view.priority === 'warning'
  const single = view.lines.length === 1
  return (
    <div
      data-cloud-toast={view.priority}
      aria-hidden={quiet || undefined}
      aria-label={!single ? view.label : undefined}
      role={single ? undefined : 'group'}
      className="w-[var(--width,356px)] max-w-full rounded-lg border border-border bg-card font-sans text-card-foreground shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
    >
      <ul className="divide-y divide-border">
        {view.lines.map((line) => (
          <li key={line.key} className="flex items-start gap-2.5 px-3 py-2.5">
            {warning ? (
              <TriangleAlert
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-status-warning-text"
              />
            ) : null}
            {/* The sentence reads first; its one action sits under it so neither gets squeezed. */}
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
              <div className="space-y-0.5">
                <p className="text-xs leading-5 text-foreground">{line.text}</p>
                {line.description ? (
                  <p className="text-xs text-muted-foreground">{line.description}</p>
                ) : null}
              </div>
              {line.action ? (
                <Button
                  type="button"
                  size="xs"
                  variant={line.action.primary ? 'default' : 'outline'}
                  onClick={line.action.pending ? undefined : line.action.onClick}
                  aria-disabled={line.action.pending || undefined}
                  aria-busy={line.action.pending || undefined}
                >
                  {line.action.icon}
                  {line.action.label}
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              size="icon-xs"
              variant="quiet"
              className={cn('-mr-1 shrink-0')}
              aria-label={t('orcaCloud.toast.dismiss', 'Dismiss')}
              onClick={line.onDismissLine ?? onDismiss}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
