/**
 * Boundary validation for an `automation.list` response.
 *
 * A client validates rather than casts: a host that answers a scoped request
 * with the legacy `{ automations }` shape is reporting the whole authority, and
 * committing that as one host's rows would attribute other hosts' automations to
 * the selected one. Individual malformed rows are dropped and counted so one bad
 * row neither hides a host nor produces an unqualified row, and a returned
 * selector that does not match the request is never reclassified into Self.
 */

import type { Automation } from './automations-types'
import type { AutomationUsageSummary } from './automation-usage-summary'
import {
  automationSelectorMatchesScope,
  type AutomationListItem,
  type AutomationListItemSelector,
  type AutomationListResult,
  type AutomationListScopeSelector
} from './automation-list-scope'

export type AutomationListResponseFailure = {
  code: 'unsupported_host_scope' | 'invalid_response'
  message: string
}

export type AutomationListResponseValidation =
  | { ok: true; result: AutomationListResult; invalidRows: number }
  | { ok: false; error: AutomationListResponseFailure }

const UNSUPPORTED_HOST_SCOPE_MESSAGE =
  'This host does not support per-host automation lists. Update the Orca server to filter by host.'
const INVALID_RESPONSE_MESSAGE = 'This host returned an automation list Orca could not read.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseAutomation(value: unknown): Automation | null {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    ? (value as Automation)
    : null
}

const USAGE_SUMMARY_FIELDS = [
  'knownRuns',
  'unavailableRuns',
  'inputTokens',
  'outputTokens',
  'cacheTokens',
  'reasoningOutputTokens',
  'totalTokens'
] as const

function parseUsageSummary(value: unknown): AutomationUsageSummary | null {
  if (!isRecord(value)) {
    return null
  }
  if (!USAGE_SUMMARY_FIELDS.every((field) => typeof value[field] === 'number')) {
    return null
  }
  const cost = value.estimatedCostUsd
  return cost === null || typeof cost === 'number' ? (value as AutomationUsageSummary) : null
}

function parseSelector(value: unknown): AutomationListItemSelector | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'self') {
    return { kind: 'self' }
  }
  if (value.kind === 'orphan') {
    return { kind: 'orphan', issue: typeof value.issue === 'string' ? value.issue : '' }
  }
  if (
    value.kind !== 'ssh' ||
    typeof value.targetId !== 'string' ||
    value.targetId.length === 0 ||
    !Number.isSafeInteger(value.targetGeneration)
  ) {
    return null
  }
  return {
    kind: 'ssh',
    targetId: value.targetId,
    targetGeneration: value.targetGeneration as number
  }
}

type ParsedItems = { byId: Map<string, AutomationListItem>; invalidRows: number }

function parseItems(raw: readonly unknown[]): ParsedItems {
  const byId = new Map<string, AutomationListItem>()
  const duplicated = new Set<string>()
  let invalidRows = 0
  for (const entry of raw) {
    const selector = isRecord(entry) ? parseSelector(entry.selector) : null
    const automationId =
      isRecord(entry) && typeof entry.automationId === 'string' && entry.automationId.length > 0
        ? entry.automationId
        : null
    if (!selector || !automationId) {
      invalidRows++
      continue
    }
    if (byId.has(automationId) || duplicated.has(automationId)) {
      // A second item for one ID makes both unusable: neither can be trusted as the row's owner.
      byId.delete(automationId)
      duplicated.add(automationId)
      invalidRows++
      continue
    }
    byId.set(automationId, {
      automationId,
      selector,
      usageSummary: parseUsageSummary((entry as { usageSummary?: unknown }).usageSummary)
    })
  }
  return { byId, invalidRows }
}

function failure(code: AutomationListResponseFailure['code']): AutomationListResponseValidation {
  return {
    ok: false,
    error: {
      code,
      message:
        code === 'unsupported_host_scope'
          ? UNSUPPORTED_HOST_SCOPE_MESSAGE
          : INVALID_RESPONSE_MESSAGE
    }
  }
}

export function validateAutomationListResponse(
  raw: unknown,
  scope: AutomationListScopeSelector
): AutomationListResponseValidation {
  if (!isRecord(raw) || !Array.isArray(raw.automations)) {
    return failure('invalid_response')
  }
  if (raw.items === undefined || raw.items === null) {
    return failure('unsupported_host_scope')
  }
  if (!Array.isArray(raw.items)) {
    return failure('invalid_response')
  }
  const orphanCount = typeof raw.orphanCount === 'number' ? raw.orphanCount : undefined
  if (
    raw.orphanCount !== undefined &&
    (orphanCount === undefined || !Number.isSafeInteger(orphanCount) || orphanCount < 0)
  ) {
    return failure('invalid_response')
  }
  const parsedItems = parseItems(raw.items)
  let invalidRows = parsedItems.invalidRows
  const automations: Automation[] = []
  const items: AutomationListItem[] = []
  for (const entry of raw.automations) {
    const automation = parseAutomation(entry)
    const item = automation ? parsedItems.byId.get(automation.id) : undefined
    if (!automation || !item || !automationSelectorMatchesScope(item.selector, scope)) {
      invalidRows++
      continue
    }
    automations.push(automation)
    items.push(item)
  }
  return {
    ok: true,
    // Omitted rather than defaulted: a host is allowed not to report, and "not
    // reported" must not read downstream as "authoritatively none".
    result: { automations, items, ...(orphanCount === undefined ? {} : { orphanCount }) },
    invalidRows
  }
}
