import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT } from '../../../../shared/ai-vault-session-title'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  requestedExecutionHostScope,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { subscribeAiVaultStructuredTitles } from './ai-vault-session-result-cache'
import {
  applyAiVaultTitleProjection,
  type AiVaultSavedTitle
} from './ai-vault-structured-title-projection'

/** Names published while a list request is pending; released with that request. */
export class AiVaultPendingTitleProjection {
  private readonly titles = new Map<string, AiVaultSavedTitle>()
  private readonly unsubscribe: () => void
  overflowed = false

  constructor(scope: ExecutionHostScope) {
    const host = requestedExecutionHostScope(scope)
    this.unsubscribe = subscribeAiVaultStructuredTitles((update) => {
      if (update.kind !== 'saved') {
        return
      }
      for (const title of update.titles) {
        if (host !== ALL_EXECUTION_HOSTS_SCOPE && host !== title.executionHostId) {
          continue
        }
        const key = JSON.stringify([
          title.executionHostId,
          title.workspaceId,
          title.agent,
          title.sessionId
        ])
        if (!this.titles.has(key) && this.titles.size >= AI_VAULT_SESSION_TITLE_REQUEST_MAX_COUNT) {
          const oldest = this.titles.keys().next().value
          if (oldest !== undefined) {
            this.titles.delete(oldest)
          }
          this.overflowed = true
        }
        this.titles.set(key, title)
      }
    })
  }

  apply(result: AiVaultListResult): AiVaultListResult {
    return applyAiVaultTitleProjection(result, { kind: 'saved', titles: [...this.titles.values()] })
  }

  stop(): void {
    this.unsubscribe()
    this.titles.clear()
  }
}
