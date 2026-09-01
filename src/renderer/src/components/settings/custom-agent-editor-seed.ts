// Edit-mode seed loader for the custom-agent dialog: fetches the addressed
// definition through the local preload draft path and maps host too-large/stale
// outcomes to secret-safe form-level messages. Kept out of the hook so the
// controller stays under the module line budget.

import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent, CustomTuiAgentId } from '../../../../shared/types'
import { draftFromEditableFields, type CustomAgentEditorDraft } from './custom-agent-editor-state'
import type { CustomAgentEditorFormError } from './custom-agent-editor-copy'

export type CustomAgentSeedResult =
  | { kind: 'ready'; draft: CustomAgentEditorDraft }
  | { kind: 'error'; error: CustomAgentEditorFormError }

export function seedEditDraft(
  id: CustomTuiAgentId,
  baseAgent: BuiltInTuiAgent
): Promise<CustomAgentSeedResult> {
  return seedDraft({ id }, baseAgent)
}

/** Repair-edit seeds by opaque repair token, not id: the token addresses the
 *  exact physical corrupt row at the current revision (plan §186). */
export function seedRepairEditDraft(
  repairToken: string,
  baseAgent: BuiltInTuiAgent
): Promise<CustomAgentSeedResult> {
  return seedDraft({ repairToken }, baseAgent)
}

async function seedDraft(
  locator: { id: CustomTuiAgentId } | { repairToken: string },
  baseAgent: BuiltInTuiAgent
): Promise<CustomAgentSeedResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const snapshot = await window.api.settings.agentCatalog.getLocal()
    const result = await window.api.settings.agentCatalog.getLocalDraft({
      locator,
      expectedRevision: snapshot.revision
    })
    if (result.status === 'stale') {
      continue
    }
    if (result.status === 'too-large') {
      return { kind: 'error', error: { message: tooLargeToEditMessage() } }
    }
    return { kind: 'ready', draft: draftFromEditableFields(result.draft, baseAgent) }
  }
  return { kind: 'error', error: { message: reloadAndRetryMessage() } }
}

function tooLargeToEditMessage(): string {
  return translate(
    'auto.components.settings.CustomAgentEditorDialog.editorTooLarge',
    'This agent has too much configuration to edit here. Reduce it on the desktop host.'
  )
}

function reloadAndRetryMessage(): string {
  return translate(
    'auto.components.settings.CustomAgentEditorDialog.reloadAndRetry',
    'Reload settings and try again.'
  )
}
