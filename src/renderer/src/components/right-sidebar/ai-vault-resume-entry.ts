import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AgentLaunchVaultResumeEntry } from '../../../../shared/agent-launch-spawn-request'

/** Echo only host-discovered identity. filePath remains a trusted desktop
 * compatibility field and is stripped by every runtime/web transport. */
export function buildAiVaultResumeEntry(session: AiVaultSession): AgentLaunchVaultResumeEntry {
  return {
    executionHostId: session.executionHostId,
    agent: session.agent,
    sessionId: session.sessionId,
    ...(session.resumeLocator ? { resumeLocator: session.resumeLocator } : {}),
    filePath: session.filePath
  }
}
