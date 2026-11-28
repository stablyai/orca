import type { AutomationDetailsSnapshot } from './automation-details-model'
import { translate } from '@/i18n/i18n'

const MAX_RETAINED_BYTES = 24 * 1024 * 1024
let totalBytes = 0
const retained = new Map<symbol, number>()

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

function retainAutomationPayload(key: symbol, value: unknown): boolean {
  const bytes = payloadBytes(value)
  const next = totalBytes - (retained.get(key) ?? 0) + bytes
  if (next > MAX_RETAINED_BYTES) {
    return false
  }
  totalBytes = next
  retained.set(key, bytes)
  return true
}

export function releaseAutomationPayload(key: symbol): void {
  totalBytes -= retained.get(key) ?? 0
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
      acknowledgedRun:
        next.runs !== previous.runs ? previous.acknowledgedRun : next.acknowledgedRun,
      runs:
        next.runs !== previous.runs
          ? {
              ...previous.runs,
              status: previous.runs.value.length ? 'ready' : 'error',
              capacityError: error,
              loadingMore: false,
              capped: previous.runs.capped
            }
          : next.runs,
      selected:
        previous.selected?.runId === next.selected?.runId && previous.selected?.run
          ? previous.selected
          : next.selected
            ? { ...next.selected, status: 'error', run: null, error }
            : null
    }
    retainAutomationPayload(key, payload(next))
  }
  return next
}
