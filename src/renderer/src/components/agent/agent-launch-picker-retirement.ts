import {
  agentPickerCatalogAuthoritative,
  type AgentPickerRetainedSetup
} from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { launchDraftSources } from '../native-chat/drafts/native-chat-launch-draft-source'

export function retireAgentPickerSetups(
  entries: readonly AgentPickerEntry[],
  selected: Map<string, AgentPickerRetainedSetup> | undefined,
  targetAlive: ((target: NonNullable<AgentPickerEntry['draftTarget']>) => boolean) | undefined,
  mode: 'launch' | 'select'
) {
  const entryKey = (entry: AgentPickerEntry) =>
    mode === 'select'
      ? JSON.stringify([entry.draftTarget?.key, entry.agent])
      : JSON.stringify([
          entry.worktreeId ?? '',
          entry.rows[0]?.executionHostId ?? 'local',
          entry.agent
        ])
  const membership = new Map(
    entries.map((entry) => [
      entryKey(entry),
      agentPickerCatalogAuthoritative(entry)
        ? new Map(
            entry.catalog.models.map((model) => [
              model.id,
              model.effortsKnown === false
                ? undefined
                : new Set(model.efforts.map((effort) => effort.value))
            ])
          )
        : undefined
    ])
  )
  const retire = (
    drafts: Map<string, AgentPickerRetainedSetup>,
    currentKey?: string,
    currentOwner?: { workspaceId: string; executionHostId: string }
  ) => {
    for (const [key, retained] of drafts) {
      const models = membership.get(
        currentKey ?? JSON.stringify([retained.target?.key, retained.agent])
      )
      // Accepted relocation owns the slot now; an obsolete address cannot retire its options.
      const target =
        retained.target && currentOwner
          ? {
              ...retained.target,
              executionHostId: currentOwner.executionHostId,
              worktreeId: retained.target.worktreeId ? currentOwner.workspaceId : undefined
            }
          : retained.target
      if (target && targetAlive && !targetAlive(target)) {
        drafts.delete(key)
      } else if (models && retained.preset && !retained.active) {
        const { model, effort } = retained.preset
        if (
          !models.has(model) ||
          (effort !== undefined && models.get(model)?.has(effort) === false)
        ) {
          drafts.delete(key)
        }
      }
    }
  }
  if (mode === 'select') {
    if (selected) {
      retire(selected)
    }
  } else {
    for (const source of launchDraftSources()) {
      if (source.options) {
        retire(
          source.options,
          JSON.stringify([source.workspaceId, source.executionHostId, source.agent]),
          source
        )
      }
    }
  }
}
