import type { AutomationDetailsSnapshot } from './automation-details-model'
import { translate } from '@/i18n/i18n'

const MAX_RETAINED_BYTES = 32 * 1024 * 1024
const LIMITS = { read: 24 * 1024 * 1024, draft: 8 * 1024 * 1024 }
const totals = { read: 0, draft: 0 }
const retained = new Map<string | symbol, { bytes: number; kind: 'read' | 'draft' }>()

/** Conservative payload accounting, including UTF-16 strings and object overhead. */
function payloadBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') {
    return 40 + value.length * 2
  }
  if (value === null || value === undefined) {
    return 0
  }
  if (typeof value !== 'object') {
    return 8
  }
  if (seen.has(value)) {
    return 0
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.length
      ? 64 + value.reduce((bytes, item) => bytes + payloadBytes(item, seen), 0)
      : 0
  }
  return Object.entries(value).reduce(
    (bytes, [key, item]) => bytes + 24 + key.length * 2 + payloadBytes(item, seen),
    64
  )
}

/** Admission is shared by all mounted detail consumers and retained section drafts. */
export function retainAutomationPayload(
  key: string | symbol,
  value: unknown,
  kind: 'read' | 'draft' = 'read'
): boolean {
  const bytes = payloadBytes(value)
  const previous = retained.get(key)
  const next = totals[kind] - (previous?.kind === kind ? previous.bytes : 0) + bytes
  if (
    next > LIMITS[kind] ||
    totals.read + totals.draft - (previous?.bytes ?? 0) + bytes > MAX_RETAINED_BYTES
  ) {
    return false
  }
  if (previous) {
    totals[previous.kind] -= previous.bytes
  }
  totals[kind] += bytes
  retained.set(key, { bytes, kind })
  return true
}

export function releaseAutomationPayload(key: string | symbol): void {
  const previous = retained.get(key)
  if (previous) {
    totals[previous.kind] -= previous.bytes
  }
  retained.delete(key)
}

export function admitAutomationDetailSnapshot(
  key: symbol,
  previous: AutomationDetailsSnapshot,
  next: AutomationDetailsSnapshot
): AutomationDetailsSnapshot {
  const payload = (value: AutomationDetailsSnapshot) =>
    [value.definition.value, ...value.runs.value, value.selected?.run].filter(Boolean)
  if (!retainAutomationPayload(key, payload(next))) {
    const error = {
      kind: 'failed' as const,
      message: translate(
        'bots.automationPanel.detailCapacity',
        'Open in Automations to read more details.'
      )
    }
    next = {
      ...next,
      definition:
        next.definition !== previous.definition
          ? {
              ...previous.definition,
              status: previous.definition.value ? 'ready' : 'error',
              error,
              stale: true
            }
          : next.definition,
      runs:
        next.runs !== previous.runs
          ? {
              ...previous.runs,
              status: previous.runs.value.length ? 'ready' : 'error',
              error,
              stale: true,
              loadingMore: false,
              capped: true
            }
          : next.runs,
      selected: next.selected ? { ...next.selected, status: 'error', run: null } : next.selected
    }
    retainAutomationPayload(key, payload(next))
  }
  return next
}
