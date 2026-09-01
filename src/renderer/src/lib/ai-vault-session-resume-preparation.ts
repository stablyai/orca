import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  aiVaultSessionNeedsResumePreparation,
  applyAiVaultResumePreparation
} from '../../../shared/ai-vault-resume-preparation'

/** Renderer-side repin, kept for the legacy (pre-identity) arm that still builds
 *  the command client-side. The host-owned arm repins on the host instead. */
export function prepareAiVaultSessionForResume(session: AiVaultSession): Promise<AiVaultSession> {
  return applyAiVaultResumePreparation(session, window.api.aiVault.prepareSessionResume)
}

export { aiVaultSessionNeedsResumePreparation }
