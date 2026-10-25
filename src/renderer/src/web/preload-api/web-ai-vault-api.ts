import {
  createSessionSearchClient,
  unavailableSessionSearchStatus
} from '../../../../shared/ai-vault-search-client'
import type { PreloadApi } from '../../../../preload/api-types'
import type {
  AiVaultPrepareSessionResumeRequest,
  AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault-resume-preparation'
import type { AiVaultDeleteSessionArgs } from '../../../../shared/ai-vault-session-deletion'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  normalizeExecutionHostId,
  normalizeExecutionHostScope,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { translate } from '@/i18n/i18n'

export function createWebAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  const search = createSessionSearchClient(
    (method, params) => callRuntimeResult(method, params),
    'relay'
  )
  return {
    // A browser searches only its selected paired runtime.
    searchSessions: (request, executionHostScope) =>
      addressesOwnRuntime(executionHostScope)
        ? search.searchSessions(request)
        : Promise.resolve({ kind: 'unavailable', reason: 'no-service' }),
    searchStatus: (executionHostScope) =>
      addressesOwnRuntime(executionHostScope)
        ? search.searchStatus()
        : Promise.resolve(unavailableSessionSearchStatus()),
    // Host-index consent requires the desktop operator’s settings surface.
    setSearchEnabled: () => Promise.reject(new Error('unsupported')),
    clearSearchIndex: () =>
      Promise.reject(new Error('Clearing Agent Session History is unavailable in the browser.')),
    listSessions: (args?: AiVaultListArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      const requestedScope = normalizeExecutionHostScope(
        args?.executionHostScope ?? executionHostId
      )
      if (requestedScope !== 'all' && requestedScope !== executionHostId) {
        return Promise.resolve(webAiVaultUnavailableResult(requestedScope))
      }
      // Why: no local filesystem in the browser, so every history scan runs on and is stamped as the paired runtime host.
      return callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
        includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
        limit: args?.limit,
        force: args?.force,
        ...(requestedScope === executionHostId && args?.afterFingerprint !== undefined
          ? { afterFingerprint: args.afterFingerprint }
          : {}),
        scopePaths: args?.scopePaths,
        executionHostId
      })
    },
    resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      if (
        args.executionHostScope &&
        normalizeExecutionHostScope(args.executionHostScope) !== executionHostId
      ) {
        return Promise.resolve({ titles: [] })
      }
      return callRuntimeResult<AiVaultSessionTitlesResult>('aiVault.resolveSessionTitles', {
        requests: args.requests
      }).catch(() => ({ titles: [] }))
    },
    // No RPC cancel verb; refreshId drops late results, but the unused scan runs until its timeout.
    cancelListSessions: () => Promise.resolve(),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeRequest) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    // Why: no server-side RPC for subagent transcript listing yet, so report an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    // Why: full first-prompt re-parse is local-FS only; web/runtime falls back to preview text.
    getFirstUserPrompt: () => Promise.resolve({ prompt: null }),
    // No runtime delete RPC; return the UI’s non-local rejection for host-owned sessions.
    deleteSession: (args: AiVaultDeleteSessionArgs) =>
      Promise.resolve({
        outcome: 'rejected',
        agent: args.agent,
        reason: 'non-local-host' as const
      }),
    onWindowFocused: () => noopUnsubscribe,
    // Why: the runtime RPC has no progress stream, so the panel keeps its plain spinner here.
    getScanProgress: () => Promise.resolve(null),
    onScanProgress: () => noopUnsubscribe
  }
}

// Malformed scopes must not become everything; all is a desktop merge and cannot address this browser’s runtime.
function addressesOwnRuntime(executionHostScope: ExecutionHostScope | undefined): boolean {
  const ownRuntimeId = toRuntimeExecutionHostId(requireActiveEnvironment().id)
  return (
    executionHostScope === undefined ||
    normalizeExecutionHostId(executionHostScope) === ownRuntimeId
  )
}

export function webAiVaultUnavailableResult(executionHostId: ExecutionHostId): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId,
        agent: 'codex',
        path: executionHostId,
        message: translate(
          'auto.web.webPreloadApi.aiVaultUnavailableForHost',
          'Agent Session History is not available for this execution host.'
        )
      }
    ],
    scannedAt: new Date().toISOString()
  }
}
