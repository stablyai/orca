import { debounceRuntimeFileRequest } from '@/runtime/runtime-file-request-debounce'
import { useEffect, useRef } from 'react'
import { quickOpenRecentCandidateSet } from '../../../shared/quick-open-recent-candidates'
import { cancelRuntimeFileList, listRuntimeFiles } from '@/runtime/runtime-file-client'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'

type EligibleRecentResult = { paths: string[]; error?: string }
type EligibleRecentRequest = {
  key: string
  readonly settled: boolean
  load: Promise<EligibleRecentResult>
  dispose: () => void
}
export type QuickOpenRecentCache = { current: EligibleRecentRequest | null }

export function clearQuickOpenRecentCache(cache: QuickOpenRecentCache, pendingOnly = false): void {
  if (pendingOnly && cache.current?.settled) {
    return
  }
  cache.current?.dispose()
  cache.current = null
}

export async function mergeQuickOpenRecentCandidates(args: {
  result: { files: string[]; truncated: boolean }
  candidatePaths: string[]
  completeInventory?: boolean
  cache: QuickOpenRecentCache
  key: string
  context: RuntimeFileOperationArgs
  options: Parameters<typeof listRuntimeFiles>[1]
  cancelled: () => boolean
}): Promise<{ files: string[]; truncated: boolean; recentError?: string } | undefined> {
  if (args.cancelled()) {
    return
  }
  const candidates = [...quickOpenRecentCandidateSet(args.candidatePaths)]
  if (candidates.length === 0 || args.completeInventory) {
    return args.result
  }
  if (args.cache.current?.key !== args.key) {
    clearQuickOpenRecentCache(args.cache)
    const controller = new AbortController()
    const requestToken = createBrowserUuid()
    const requested = new Set(candidates)
    let settled = false
    let started = false
    const load = debounceRuntimeFileRequest(200, controller.signal, () => {
      started = true
      return listRuntimeFiles(args.context, {
        ...args.options,
        signal: controller.signal,
        requestToken,
        candidatePaths: candidates,
        maxResults: candidates.length
      })
    })
      .then((paths) => ({ paths: paths.filter((path) => requested.has(path)) }))
      .catch((error: unknown) => ({
        paths: [],
        error: translate(
          'quickOpen.recentValidationFailed',
          'Recent files could not be checked: {{error}}',
          {
            error: error instanceof Error ? error.message : String(error)
          }
        )
      }))
      .finally(() => {
        settled = true
      })
    args.cache.current = {
      key: args.key,
      get settled() {
        return settled
      },
      load,
      dispose: () => {
        controller.abort()
        if (!settled && started) {
          cancelRuntimeFileList(args.context, requestToken)
        }
      }
    }
  }
  const request = args.cache.current
  const eligible = await request.load
  if (args.cancelled() || args.cache.current !== request) {
    return
  }
  const requested = new Set(candidates)
  const allowed = new Set(eligible.paths)
  return {
    ...args.result,
    files: [
      ...new Set([
        ...args.result.files.filter(
          (path) => eligible.error || !requested.has(path) || allowed.has(path)
        ),
        ...eligible.paths
      ])
    ],
    recentError: eligible.error
  }
}

export function useQuickOpenRecentCache(enabled: boolean, key: string): QuickOpenRecentCache {
  const cache = useRef<QuickOpenRecentCache['current']>(null)
  useEffect(() => {
    clearQuickOpenRecentCache(cache)
    return () => clearQuickOpenRecentCache(cache)
  }, [enabled, key])
  return cache
}
