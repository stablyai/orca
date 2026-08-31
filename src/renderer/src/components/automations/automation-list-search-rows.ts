import { getAutomationRunRepoId } from '../../../../shared/automation-run-identity'
import type { Automation } from '../../../../shared/automations-types'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationListRow } from './automation-list-row-identity'
import { getAgentLabel } from './automation-draft-model'
import {
  automationListSearchIndexMatches,
  buildAutomationListSearchFingerprint,
  buildAutomationListSearchIndex,
  buildAutomationProjectSearchText,
  type AutomationListSearchFields,
  type AutomationListSearchIndex
} from './automation-list-search'
import { getExternalProviderLabel } from './external-automation-display'
import type { ExternalAutomationListEntry } from './external-automation-list-entries'

/** Row identity is the authority-qualified row key / external key, so reorders invalidate the index. */
export type AutomationListSearchRowSource = {
  key: string
  fields: AutomationListSearchFields
}

export type AutomationListSearchRow = {
  key: string
  index: AutomationListSearchIndex
}

/** Only display names are read; the map accepts the page's worktree map as-is. */
export type AutomationWorkspaceNameLookup = ReadonlyMap<string, { displayName?: string | null }>

export type AutomationSearchRowContext = {
  repoMap: ReadonlyMap<string, Repo>
  worktreeMap?: AutomationWorkspaceNameLookup
}

function buildAutomationWorkspaceSearchText(
  automation: Automation,
  worktreeMap: AutomationWorkspaceNameLookup | undefined
): string {
  // Why: a per-run automation has no workspace yet, so its base ref is the only durable term.
  if (automation.workspaceMode === 'new_per_run') {
    return automation.baseBranch ?? ''
  }
  if (!automation.workspaceId) {
    return ''
  }
  return worktreeMap?.get(automation.workspaceId)?.displayName ?? ''
}

export function buildAutomationSearchFields(
  row: AutomationListRow,
  context: AutomationSearchRowContext
): AutomationListSearchFields {
  const { automation } = row
  const repo = context.repoMap.get(getAutomationRunRepoId(automation))
  return {
    name: automation.name,
    project: buildAutomationProjectSearchText({
      displayName: repo?.displayName,
      path: repo?.path
    }),
    workspace: buildAutomationWorkspaceSearchText(automation, context.worktreeMap),
    agent: getAgentLabel(automation.agentId),
    // The row's own host: a lookup by automation id would give two hosts' rows
    // one label, so a search for host B could only ever match host A's row.
    host: row.hostLabel,
    prompt: automation.prompt
  }
}

export function buildExternalAutomationSearchFields(
  entry: ExternalAutomationListEntry
): AutomationListSearchFields {
  return {
    name: entry.job.name,
    project: entry.job.workdir ?? '',
    workspace: '',
    // Why: an external job runs under its manager, so the provider is the closest agent term.
    agent: getExternalProviderLabel(entry.manager),
    host: entry.manager.targetLabel,
    prompt: entry.job.prompt ?? entry.job.promptPreview ?? ''
  }
}

export function buildAutomationSearchRowSources(
  rows: readonly AutomationListRow[],
  context: AutomationSearchRowContext
): AutomationListSearchRowSource[] {
  return rows.map((row) => ({
    key: row.key,
    fields: buildAutomationSearchFields(row, context)
  }))
}

export function buildExternalAutomationSearchRowSources(
  entries: readonly ExternalAutomationListEntry[]
): AutomationListSearchRowSource[] {
  return entries.map((entry) => ({
    key: entry.key,
    fields: buildExternalAutomationSearchFields(entry)
  }))
}

/** Single pass over the changed row set; the only place indexes are built. */
export function buildAutomationListSearchRows(
  sources: readonly AutomationListSearchRowSource[]
): AutomationListSearchRow[] {
  return sources.map((source) => ({
    key: source.key,
    index: buildAutomationListSearchIndex(source.fields)
  }))
}

/** Single pass over prebuilt indexes; no indexing work per keystroke. */
export function matchAutomationListSearchRowKeys(
  rows: readonly AutomationListSearchRow[],
  activeQuery: string
): string[] {
  const keys: string[] = []
  for (const row of rows) {
    if (automationListSearchIndexMatches(row.index, activeQuery)) {
      keys.push(row.key)
    }
  }
  return keys
}

/** Rebuild gate: identical content across a refresh tick keeps the existing indexes. */
export function buildAutomationListSearchRowFingerprint(
  sources: readonly AutomationListSearchRowSource[]
): string {
  return buildAutomationListSearchFingerprint(
    sources.map((source) => source.fields),
    sources.map((source) => source.key)
  )
}
