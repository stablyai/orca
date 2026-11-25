import { useMemo } from 'react'
import { agentPickerCatalogAuthoritative } from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import { agentPickerChatLaunchModel } from '../../../../shared/agent-launch/picker/agent-launch-picker-chat-model'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuModel } from './launch-menu/new-tab-agent-menu-model'
import { agentPickerChatLaunchRefusal } from './agent-launch-picker-chat-model-refusal'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'

/** A form's agent pick as the picker's model list now reads, and why a chat can't run its model.
 *  The picker hands over its entry only when picked, so a chat pick made while the list loaded
 *  keeps watching the form's list and is checked again once it settles, without a new pick. */
export function useAgentPickerChatPick(
  model: NewTabAgentMenuModel,
  pick: { entry?: AgentPickerEntry; draft?: AgentPickerDraft } | null | undefined,
  chat: boolean,
  worktreeId?: string
): { entry: AgentPickerEntry | undefined; refusal: string | null } {
  const picked = pick?.entry
  const draft = pick?.draft
  const checked =
    chat && picked && draft ? agentPickerChatLaunchModel(picked, draft.choices.model) : undefined
  const watched =
    checked && 'refusal' in checked && checked.refusal === 'unproven' ? picked : undefined
  const entries = useAgentLaunchPickerInventory(worktreeId, model, !!watched, watched?.agent)
  const live = watched && entries.find((candidate) => candidate.agent === watched.agent)
  // Only a settled list replaces the pick's own; until then the pick stands as it was checked.
  const entry = live && agentPickerCatalogAuthoritative(live) ? live : picked
  const refusal = chat && entry && draft ? agentPickerChatLaunchRefusal(entry, draft) : null
  return useMemo(() => ({ entry, refusal }), [entry, refusal])
}
