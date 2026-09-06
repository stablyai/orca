import type { PreloadApi } from '../../../../preload/api-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../../shared/ai-vault-resume-preparation'
import type { AiVaultDeleteSessionArgs } from '../../../../shared/ai-vault-session-deletion'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../../../shared/ai-vault-session-title'
import type { AiVaultListArgs, AiVaultListResult } from '../../../../shared/ai-vault-types'
import {
  normalizeExecutionHostScope,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'
import { noopUnsubscribe } from './web-storage'
import { translate } from '@/i18n/i18n'

export function createWebAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  return {
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
        limit: args?.limit,
        force: args?.force,
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
    // Why: the runtime RPC transport has no cancel verb, so the in-flight scan
    // settles on its own timeout. The renderer's refreshId guard already drops
    // the late result; this only means web pays for a scan nobody reads.
    cancelListSessions: () => Promise.resolve(),
    prepareSessionResume: (args: AiVaultPrepareSessionResumeArgs) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    // Why: no server-side RPC for subagent transcript listing yet, so report an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    // Why: full first-prompt re-parse is local-FS only; web/runtime falls back to preview text.
    getFirstUserPrompt: () => Promise.resolve({ prompt: null }),
    // Why: session deletion is local-only and has no runtime RPC; a web
    // client's sessions are runtime-hosted, so report the same non-local
    // rejection the UI already gates on rather than pretend to delete.
    deleteSession: (args: AiVaultDeleteSessionArgs) =>
      Promise.resolve({
        outcome: 'rejected',
        agent: args.agent,
        reason: 'non-local-host' as const
      }),
    onWindowFocused: () => noopUnsubscribe
  }
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
