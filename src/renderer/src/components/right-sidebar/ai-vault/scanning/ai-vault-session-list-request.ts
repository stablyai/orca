import type {
  AiVaultListArgs,
  AiVaultListResult
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  parseRoutableExecutionHostId,
  type ExecutionHostScope
} from '../../../../../../shared/execution-host'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'
import {
  aiVaultSessionResultCacheKey,
  cacheAiVaultSessionResult,
  readCachedAiVaultSessionResult
} from './ai-vault-session-result-cache'

/** Match panel requests so readers share host/renderer caches instead of evicting one another. */
export type AiVaultSessionListRequest = {
  scopePaths: readonly string[]
  /** Workspace and Project list only their own sessions; All also lists the newest sessions everywhere. */
  scopeOnly: boolean
  executionHostScope: ExecutionHostScope
  sessionLimit: AiVaultSessionLimit
}

export function aiVaultSessionListArgs(
  request: AiVaultSessionListRequest,
  options: { force?: boolean; requestToken: string }
): AiVaultListArgs {
  return {
    includeAntigravityIdeSessions: true,
    limit: request.sessionLimit === 'unlimited' ? undefined : request.sessionLimit,
    unlimited: request.sessionLimit === 'unlimited',
    scopePaths: request.scopePaths,
    ...(request.scopeOnly ? { scopeOnly: true } : {}),
    executionHostScope: request.executionHostScope,
    force: options.force,
    requestToken: options.requestToken
  }
}

export function readCachedAiVaultSessionList(
  request: AiVaultSessionListRequest
): AiVaultListResult | null {
  return readCachedAiVaultSessionResult({
    key: aiVaultSessionResultCacheKey(
      request.executionHostScope,
      request.scopePaths,
      request.scopeOnly
    ),
    limit: request.sessionLimit,
    scopePaths: request.scopePaths
  })
}

export function cacheAiVaultSessionList(
  request: AiVaultSessionListRequest,
  result: AiVaultListResult,
  options: { replaceHostEntries: boolean }
): void {
  cacheAiVaultSessionResult({
    key: aiVaultSessionResultCacheKey(
      request.executionHostScope,
      request.scopePaths,
      request.scopeOnly
    ),
    executionHostScope: request.executionHostScope,
    limit: request.sessionLimit,
    scopePaths: request.scopePaths,
    result,
    replaceHostEntries: options.replaceHostEntries
  })
}

export type AiVaultConditionalSnapshot = { fingerprint: string; result: AiVaultListResult }

export async function refreshAiVaultSessionList(
  request: AiVaultSessionListRequest,
  options: { force?: boolean; requestToken: string },
  previous?: AiVaultConditionalSnapshot
): Promise<AiVaultListResult> {
  const args = aiVaultSessionListArgs(request, options)
  if (
    request.sessionLimit !== 'unlimited' &&
    parseRoutableExecutionHostId(request.executionHostScope)?.kind === 'runtime'
  ) {
    args.afterFingerprint = previous?.fingerprint ?? null
  }
  const result = await window.api.aiVault.listSessions(args)
  if (!result.unchanged) {
    return result
  }
  if (
    !previous ||
    typeof args.afterFingerprint !== 'string' ||
    result.fingerprint !== args.afterFingerprint
  ) {
    const full = await window.api.aiVault.listSessions(aiVaultSessionListArgs(request, options))
    if (full.unchanged) {
      throw new Error('Session refresh did not return the requested full history')
    }
    return full
  }
  return { ...previous.result, scannedAt: result.scannedAt, fingerprint: result.fingerprint }
}
