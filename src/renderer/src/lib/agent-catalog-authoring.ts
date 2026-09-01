// Renderer entry point for agent-catalog and agent-reference authoring writes.
// The catalog/reference settings keys can no longer be written through
// settings.set (main strips them); every desktop authoring caller routes here
// so the revision-checked, atomic mutation APIs stay the single write path.

import type {
  AgentCatalogMutation,
  AgentCatalogMutationResult,
  BuiltInAgentEditableFields
} from '../../../shared/agent-catalog-snapshot'
import type {
  AgentReferenceMutation,
  AgentReferenceMutationResult,
  LocalAgentReferenceSnapshot
} from '../../../shared/agent-reference-snapshot'
import type {
  BuiltInTuiAgent,
  CommitMessageAiSettings,
  CustomTuiAgentId,
  GlobalSettings,
  TerminalQuickCommand,
  TuiAgent
} from '../../../shared/types'
import type { SourceControlAiSettings } from '../../../shared/source-control-ai-types'
import {
  applyAgentPermissionMode,
  type AgentPermissionMode
} from '../../../shared/tui-agent-permissions'
import { isBuiltInTuiAgent } from '../../../shared/tui-agent-config'
import { useAppStore } from '@/store'

type ReferenceMutationResult = AgentReferenceMutationResult<LocalAgentReferenceSnapshot>

// Why: catalog and reference edits are revision-checked full-snapshot
// replacements sharing one revision per domain. Serialize each domain's writes
// so back-to-back edits (rapid enable/disable toggles, permission-mode fan-out)
// read a fresh revision instead of racing on a stale one.
let catalogChain: Promise<unknown> = Promise.resolve()
let referenceChain: Promise<unknown> = Promise.resolve()

async function runCatalogMutation(
  mutation: AgentCatalogMutation
): Promise<AgentCatalogMutationResult> {
  const snapshot = await window.api.settings.agentCatalog.getLocal()
  let result = await window.api.settings.agentCatalog.mutate({
    expectedRevision: snapshot.revision,
    mutation
  })
  // Bounded retry: these are programmatic writes, so on a revision conflict we
  // refresh from the returned snapshot and reapply once. The draft-preserving
  // editor UX for interactive conflicts lands in the catalog UI unit.
  if (!result.ok && result.code === 'catalog_revision_conflict') {
    result = await window.api.settings.agentCatalog.mutate({
      expectedRevision: result.snapshot?.revision ?? result.revision,
      mutation
    })
  }
  if (!result.ok) {
    console.warn('[agent-catalog] mutation rejected', mutation.kind, result.code)
  }
  return result
}

export function mutateAgentCatalog(
  mutation: AgentCatalogMutation
): Promise<AgentCatalogMutationResult> {
  const run = catalogChain.catch(() => {}).then(() => runCatalogMutation(mutation))
  catalogChain = run
  return run
}

async function runReferenceMutation(
  mutation: AgentReferenceMutation
): Promise<ReferenceMutationResult> {
  const snapshot = await window.api.settings.agentReferences.getLocal()
  let result = await window.api.settings.agentReferences.mutate({
    expectedReferenceRevision: snapshot.revision,
    mutation
  })
  if (!result.ok && result.code === 'reference_revision_conflict') {
    result = await window.api.settings.agentReferences.mutate({
      expectedReferenceRevision: result.snapshot?.revision ?? result.referenceRevision,
      mutation
    })
  }
  if (!result.ok) {
    console.warn('[agent-reference] mutation rejected', mutation.kind, result.code)
  }
  return result
}

export function mutateAgentReferences(
  mutation: AgentReferenceMutation
): Promise<ReferenceMutationResult> {
  const run = referenceChain.catch(() => {}).then(() => runReferenceMutation(mutation))
  referenceChain = run
  return run
}

// Null maps to Auto so callers that previously wrote `defaultTuiAgent: null`
// keep their existing "Auto" behavior under the catalog mutation.
export function setDefaultTuiAgent(
  agent: TuiAgent | 'auto' | 'blank' | null
): Promise<AgentCatalogMutationResult> {
  return mutateAgentCatalog({ kind: 'set-default', agent: agent ?? 'auto' })
}

export function setTuiAgentEnabled(
  agent: TuiAgent,
  enabled: boolean
): Promise<AgentCatalogMutationResult> {
  return mutateAgentCatalog({ kind: 'set-enabled', agent, enabled })
}

// The reference-aware disable confirmation must recheck the revision the user
// saw and, on conflict, refresh its summary WITHOUT applying (plan §973) — the
// opposite of the auto-retrying `mutateAgentCatalog`. So this mutates at the
// captured revision exactly once and surfaces a conflict for the caller to
// handle, while still serializing on the shared catalog chain.
export function setTuiAgentEnabledAtRevision(
  agent: TuiAgent,
  enabled: boolean,
  expectedRevision: number
): Promise<AgentCatalogMutationResult> {
  const run = catalogChain
    .catch(() => {})
    .then(() =>
      window.api.settings.agentCatalog.mutate({
        expectedRevision,
        mutation: { kind: 'set-enabled', agent, enabled }
      })
    )
  catalogChain = run
  return run
}

// Permanent delete. `onDefault` is honored only when this id is the current
// default at the host's revision; the caller omits it for non-default agents.
export function deleteCustomTuiAgent(
  id: CustomTuiAgentId,
  onDefault?: 'keep' | 'base' | 'auto' | 'clear'
): Promise<AgentCatalogMutationResult> {
  return mutateAgentCatalog({ kind: 'delete-custom', id, ...(onDefault ? { onDefault } : {}) })
}

// update-built-in replaces all three launch fields for the agent, so a
// single-field edit carries the current persisted values of the other two.
export function updateBuiltInTuiAgent(
  agent: BuiltInTuiAgent,
  change: Partial<BuiltInAgentEditableFields>
): Promise<AgentCatalogMutationResult> {
  const settings = useAppStore.getState().settings
  const changes: BuiltInAgentEditableFields = {
    commandOverride:
      change.commandOverride !== undefined
        ? change.commandOverride
        : (settings?.agentCmdOverrides?.[agent] ?? null),
    args: change.args !== undefined ? change.args : (settings?.agentDefaultArgs?.[agent] ?? ''),
    env: change.env !== undefined ? change.env : (settings?.agentDefaultEnv?.[agent] ?? {})
  }
  return mutateAgentCatalog({ kind: 'update-built-in', agent, changes })
}

function sameEnv(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightEntries = Object.entries(right ?? {})
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  return leftEntries.every(([key, value]) => right?.[key] === value)
}

// The permission toggle is a bulk args/env change across the built-in agents it
// covers; decompose it into one update-built-in per changed agent so it flows
// through the same catalog mutation as the individual launch-field edits.
export async function applyAgentPermissionModeViaCatalog(
  mode: Exclude<AgentPermissionMode, 'mixed'>,
  settings: Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>
): Promise<void> {
  const currentArgs = settings.agentDefaultArgs ?? {}
  const currentEnv = settings.agentDefaultEnv ?? {}
  const { agentDefaultArgs: nextArgs, agentDefaultEnv: nextEnv } = applyAgentPermissionMode({
    mode,
    agentDefaultArgs: currentArgs,
    agentDefaultEnv: currentEnv
  })
  const changed = new Set<TuiAgent>()
  for (const agent of new Set([
    ...Object.keys(nextArgs),
    ...Object.keys(currentArgs)
  ]) as Set<TuiAgent>) {
    if ((nextArgs[agent] ?? '') !== (currentArgs[agent] ?? '')) {
      changed.add(agent)
    }
  }
  for (const agent of new Set([
    ...Object.keys(nextEnv),
    ...Object.keys(currentEnv)
  ]) as Set<TuiAgent>) {
    if (!sameEnv(nextEnv[agent], currentEnv[agent])) {
      changed.add(agent)
    }
  }
  for (const agent of changed) {
    if (!isBuiltInTuiAgent(agent)) {
      continue
    }
    await updateBuiltInTuiAgent(agent, { args: nextArgs[agent] ?? '', env: nextEnv[agent] ?? {} })
  }
}

export function saveTerminalQuickCommand(
  command: TerminalQuickCommand
): Promise<ReferenceMutationResult> {
  return mutateAgentReferences({ kind: 'quick-command-save', command })
}

export function deleteTerminalQuickCommand(id: string): Promise<ReferenceMutationResult> {
  return mutateAgentReferences({ kind: 'quick-command-delete', id })
}

export function saveCommitMessageAiSettings(
  changes: Partial<CommitMessageAiSettings>
): Promise<ReferenceMutationResult> {
  return mutateAgentReferences({ kind: 'commit-message-update', changes })
}

export function saveSourceControlAiSettings(
  changes: Partial<SourceControlAiSettings>
): Promise<ReferenceMutationResult> {
  return mutateAgentReferences({ kind: 'source-control-update', changes })
}
