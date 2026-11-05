import type { PreloadApi } from '../../../../preload/api-types'
import { createFallbackProxy } from './web-fallback-api'
import { callRuntimeResult } from './web-runtime-calls'
import { mapRepoPathArg } from '@/runtime/runtime-repo-selector-params'
import { repoHooksCheckWakeParams } from '../../../../shared/repo-hooks-check-wake'

export function createRuntimeNamespaceApi(prefix: string): never {
  return createFallbackProxy([prefix], (path, args) => {
    const method = `${prefix}.${path.at(-1) ?? ''}`
    return callRuntimeResult(method, mapRuntimeNamespaceArg(prefix, args[0]))
  }) as never
}

export function createHooksApi(): NonNullable<Partial<PreloadApi>['hooks']> {
  return {
    check: async ({ repoId, background }) =>
      callRuntimeResult('repo.hooksCheck', {
        repo: repoId,
        ...repoHooksCheckWakeParams(background)
      }),
    inspectSetupScriptImports: async ({ repoId }) =>
      callRuntimeResult('repo.setupScriptImports', { repo: repoId }),
    readIssueCommand: async ({ repoId, wakeWslDistro, kind }) =>
      callRuntimeResult(kind === 'review' ? 'repo.reviewCommandRead' : 'repo.issueCommandRead', {
        repo: repoId,
        ...(wakeWslDistro ? { wakeWslDistro } : {})
      }),
    writeIssueCommand: async ({ repoId, content, wakeWslDistro, kind }) => {
      await callRuntimeResult(
        kind === 'review' ? 'repo.reviewCommandWrite' : 'repo.issueCommandWrite',
        { repo: repoId, content, ...(wakeWslDistro ? { wakeWslDistro } : {}) }
      )
    }
  }
}

export function mapRuntimeNamespaceArg(prefix: string, args: unknown): unknown {
  if (prefix !== 'hostedReview') {
    return args
  }
  return mapRepoPathArg(args)
}
