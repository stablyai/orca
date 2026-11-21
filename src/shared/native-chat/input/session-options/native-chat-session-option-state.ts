import type { AgentType } from '../../../agent-status/contracts/agent-status-types'
import type {
  CatalogMidSessionApply,
  AgentSessionOptionCatalog
} from '../../../agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type {
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionValueSource
} from '../native-chat-session-options'

export type TrackedNativeChatSessionOption = {
  value: SessionOptionValue
  source: Exclude<SessionOptionValueSource, 'unknown'>
}

export type NativeChatSessionOptionRecord = {
  agent: AgentType
  model?: TrackedNativeChatSessionOption
  valuesByModel: Record<string, Record<string, TrackedNativeChatSessionOption>>
}

export function createNativeChatSessionOptionRecord(
  agent: AgentType
): NativeChatSessionOptionRecord {
  return { agent, valuesByModel: {} }
}

export function cloneNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord
): NativeChatSessionOptionRecord {
  return {
    agent: record.agent,
    ...(record.model ? { model: { ...record.model } } : {}),
    valuesByModel: Object.fromEntries(
      Object.entries(record.valuesByModel).map(([modelId, values]) => [
        modelId,
        Object.fromEntries(Object.entries(values).map(([id, tracked]) => [id, { ...tracked }]))
      ])
    )
  }
}

export function isFlipOnlyMidSession(
  midSession: CatalogMidSessionApply | undefined
): midSession is Extract<CatalogMidSessionApply, { kind: 'toggle-command' }> {
  return midSession?.kind === 'toggle-command'
}

export function getTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): TrackedNativeChatSessionOption | undefined {
  return modelId ? record.valuesByModel[modelId]?.[optionId] : undefined
}

export function clearTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  modelId: string | null,
  optionId: string
): void {
  if (!modelId) {
    return
  }
  const current = record.valuesByModel[modelId]
  if (!current || !(optionId in current)) {
    return
  }
  const next = { ...current }
  delete next[optionId]
  if (Object.keys(next).length === 0) {
    delete record.valuesByModel[modelId]
  } else {
    record.valuesByModel[modelId] = next
  }
}

export function clearNativeChatSessionModel(record: NativeChatSessionOptionRecord): void {
  const modelId = typeof record.model?.value === 'string' ? record.model.value : null
  record.model = undefined
  if (modelId) {
    delete record.valuesByModel[modelId]
  }
}

export function setTrackedSessionOption(
  record: NativeChatSessionOptionRecord,
  optionId: string,
  value: SessionOptionValue,
  source: TrackedNativeChatSessionOption['source'],
  /** Picker model when none is tracked; retain options dispatched under the CLI default. */
  fallbackModelId: string | null = null
): string | null {
  if (optionId === 'model') {
    record.model = { value, source }
    return typeof value === 'string' ? value : null
  }
  const modelId =
    (typeof record.model?.value === 'string' ? record.model.value : null) ?? fallbackModelId
  if (!modelId) {
    return null
  }
  record.valuesByModel[modelId] = {
    ...record.valuesByModel[modelId],
    [optionId]: { value, source }
  }
  return modelId
}

export function flattenNativeChatSessionOptionRecord(
  record: NativeChatSessionOptionRecord,
  modelId: string
): Record<string, SessionOptionValue> {
  return {
    model: modelId,
    ...Object.fromEntries(
      Object.entries(record.valuesByModel[modelId] ?? {}).map(([id, tracked]) => [
        id,
        tracked.value
      ])
    )
  }
}

export function applyNativeChatReportedSessionOptions(
  record: NativeChatSessionOptionRecord,
  values: Record<string, SessionOptionValue>,
  /** Provider-confirmed ids; omitted means all values are read-back reports. */
  confirmed?: readonly string[]
): boolean {
  const sourceFor = (id: string): TrackedNativeChatSessionOption['source'] =>
    confirmed === undefined || confirmed.includes(id) ? 'reported' : 'dispatched'
  const modelId = typeof values.model === 'string' ? values.model : null
  if (!modelId) {
    return false
  }
  const modelChanged = record.model?.value !== modelId
  let changed = modelChanged || record.model?.source !== sourceFor('model')
  record.model = { value: modelId, source: sourceFor('model') }
  const modelValues = modelChanged ? {} : { ...record.valuesByModel[modelId] }
  for (const [id, value] of Object.entries(values)) {
    if (id === 'model') {
      continue
    }
    const current = modelValues[id]
    if (current?.value !== value || current.source !== sourceFor(id)) {
      changed = true
    }
    modelValues[id] = { value, source: sourceFor(id) }
  }
  record.valuesByModel[modelId] = modelValues
  return changed
}

export function selectedSessionOptionValue(
  snapshot: readonly SessionOptionDescriptor[],
  optionId: string
): string | null {
  const descriptor = snapshot.find((entry) => entry.id === optionId)
  const value = descriptor?.kind.currentValue
  return typeof value === 'string' ? value : null
}

function modelRouteBase(id: string): string {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? id : id.slice(slash + 1)
}

function providerSegment(id: string): string | null {
  const slash = id.lastIndexOf('/')
  return slash === -1 ? null : id.slice(0, slash)
}

/** A qualified id may substring-match only the same provider. A bare id may match only another bare id. */
function allowsLooseModelMatch(reported: string, candidate: string): boolean {
  const reportedProvider = providerSegment(reported)
  const candidateProvider = providerSegment(candidate)
  if (reportedProvider === null || candidateProvider === null) {
    return reportedProvider === candidateProvider
  }
  return reportedProvider.toLowerCase() === candidateProvider.toLowerCase()
}

/** Several listed routes share this base, so a bare report does not say which one is running. */
function baseIsShared(catalog: AgentSessionOptionCatalog, base: string): boolean {
  let count = 0
  for (const model of catalog.models) {
    if (model.id === base || modelRouteBase(model.id) === base) {
      count += 1
    }
  }
  return count > 1
}

function selectedRouteMatchesReport(
  model: { id: string; resolvedModel?: string },
  reported: string
): boolean {
  const normalized = reported.toLowerCase()
  if (modelRouteBase(model.id).toLowerCase() === normalized) {
    return true
  }
  const resolved = model.resolvedModel?.trim().toLowerCase()
  return resolved === normalized && resolved.length > 0
}

function resolvedModelIsShared(catalog: AgentSessionOptionCatalog, resolved: string): boolean {
  const normalized = resolved.trim().toLowerCase()
  if (!normalized) {
    return false
  }
  let count = 0
  for (const model of catalog.models) {
    if (model.resolvedModel?.trim().toLowerCase() === normalized) {
      count += 1
    }
  }
  return count > 1
}

/** A bare or resolved-model report matches the selected route, so it does not name a different provider. */
function selectedBareModelReport(
  catalog: AgentSessionOptionCatalog,
  reported: string,
  selectedId: string | null | undefined
): string | null {
  const selected = selectedId ? catalog.models.find((model) => model.id === selectedId) : undefined
  if (!selected || selected.id === reported || !selectedRouteMatchesReport(selected, reported)) {
    return null
  }
  const resolved = selected.resolvedModel?.trim() ?? ''
  if (
    !reported.includes('/') ||
    resolved.toLowerCase() === reported.toLowerCase() ||
    baseIsShared(catalog, modelRouteBase(selected.id)) ||
    resolvedModelIsShared(catalog, resolved || reported)
  ) {
    return selected.id
  }
  return null
}

/** Match reported model by exact-case id, case-insensitive id, label, then longest contained id; retain raw reports for unseeded catalogs. Callers may keep unlisted selectors without fuzzy matching. */
export function matchNativeChatCatalogModelId(
  catalog: AgentSessionOptionCatalog,
  reported: string,
  options?: { allowUnlisted?: boolean; selectedId?: string | null }
): string | null {
  const trimmed = reported.trim()
  const normalized = trimmed.toLowerCase()
  if (!normalized) {
    return null
  }
  // OMP seeds no models; its reported provider/id is already the exact reusable CLI selector.
  if (catalog.models.length === 0) {
    return trimmed
  }
  const exactCase = catalog.models.find((model) => model.id === trimmed)
  const caseFoldRoute = catalog.models.find(
    (model) => model.id.toLowerCase() === normalized && modelRouteBase(model.id) !== model.id
  )
  // A full route in the report is an explicit switch, including a case-variant of that id.
  // A bare id is resolved before any label match.
  if (exactCase && modelRouteBase(exactCase.id) !== exactCase.id) {
    return exactCase.id
  }
  if (caseFoldRoute) {
    return caseFoldRoute.id
  }
  const preserved = selectedBareModelReport(catalog, trimmed, options?.selectedId)
  if (preserved) {
    return preserved
  }
  const caseFold = catalog.models.find((model) => model.id.toLowerCase() === normalized)
  const byLabel = catalog.models.find((model) => model.label.toLowerCase() === normalized)
  let matched = exactCase?.id ?? caseFold?.id ?? byLabel?.id ?? null
  if (!matched && options?.allowUnlisted && !/\s/.test(normalized)) {
    matched = trimmed
  }
  if (!matched) {
    let containingId: string | null = null
    for (const model of catalog.models) {
      if (
        (containingId === null || model.id.length > containingId.length) &&
        allowsLooseModelMatch(trimmed, model.id) &&
        normalized.includes(model.id.toLowerCase())
      ) {
        containingId = model.id
      }
    }
    matched = containingId
  }
  const selected = options?.selectedId
  const selectedBase = selected ? modelRouteBase(selected) : null
  // A bare id is shared by the selected provider route and other rows, so it does not name a different model.
  if (
    selected &&
    selectedBase &&
    matched === selectedBase &&
    selected !== matched &&
    catalog.models.some((model) => model.id === selected) &&
    baseIsShared(catalog, selectedBase)
  ) {
    return selected
  }
  return matched
}
