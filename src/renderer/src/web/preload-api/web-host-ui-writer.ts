import { PROJECT_REPO_FILTER_EXACT_CAPABILITY } from '../../../../shared/project-repo-filter-capability'
import {
  callEnvironmentEnvelope,
  assertEnvironmentPairing,
  callRuntimeResult
} from './web-runtime-calls'
import {
  getClientForEnvironment,
  subscribeWebRuntimeStatus,
  requireActiveEnvironmentOrNull
} from './web-runtime-session'
import type { PreloadApi } from '../../../../preload/api-types'

/** Own filter action supersession while the existing status owner proves support. */
export function createWebHostUiWriter() {
  let filterAction = 0
  let pendingFilter: AbortController | null = null
  return async (
    hostUpdates: Parameters<PreloadApi['ui']['set']>[0],
    context?: Parameters<PreloadApi['ui']['set']>[1]
  ) => {
    if (hostUpdates.filterRepoIds === undefined) {
      await callRuntimeResult('ui.set', hostUpdates, 15_000)
      return
    }
    const environment = requireActiveEnvironmentOrNull()
    if (!environment) {
      throw new Error('No paired Orca server is selected.')
    }
    const revision = environment.pairingRevision ?? environment.createdAt
    const client = getClientForEnvironment(environment)
    const assertOwner = () => {
      assertEnvironmentPairing(environment.id, revision)
      if (getClientForEnvironment(environment) !== client) {
        throw new Error('The Orca connection changed during this action.')
      }
    }
    const hasFilter = hostUpdates.filterRepoIds !== undefined
    const authored = context?.projectFilter
    if (
      hasFilter &&
      authored &&
      (authored.environmentId !== environment.id || authored.pairingRevision !== revision)
    ) {
      throw new Error('The paired Orca server changed during this action.')
    }
    const snapshot = client.statusOwner?.read()
    const exact =
      hasFilter &&
      (authored?.exact ??
        !(
          snapshot?.verification === 'verified' &&
          snapshot.transport === 'ready' &&
          !snapshot.status?.capabilities?.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY)
        ))
    const action = hasFilter ? ++filterAction : filterAction
    const controller = hasFilter ? new AbortController() : null
    if (hasFilter) {
      pendingFilter?.abort()
      pendingFilter = controller
    }
    let superseded = false
    try {
      if (exact) {
        await new Promise<void>((resolve, reject) => {
          let release = () => {}
          const finish = (error?: Error) => {
            release()
            controller?.signal.removeEventListener('abort', abort)
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          }
          const abort = () => {
            superseded = true
            finish(new Error('Project filter action superseded.'))
          }
          const check = () => {
            try {
              assertOwner()
              const current = client.statusOwner?.read()
              if (current?.retired) {
                finish(new Error('The Orca connection was replaced.'))
                return
              }
              if (
                current?.verification === 'verified' &&
                current.transport === 'ready' &&
                current.status?.capabilities?.includes(PROJECT_REPO_FILTER_EXACT_CAPABILITY)
              ) {
                finish()
              }
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          }
          release = subscribeWebRuntimeStatus(check)
          controller?.signal.addEventListener('abort', abort, { once: true })
          check()
          // The existing owner coalesces request interest; foreground/reentry and retry publish the eventual answer.
          if (client.statusOwner?.read().verification !== 'verified') {
            client.statusOwner?.wake()
          }
        })
      }
    } catch (error) {
      if (!superseded) {
        throw error
      }
    } finally {
      if (pendingFilter === controller) {
        pendingFilter = null
      }
    }
    assertOwner()
    const wireUpdates = { ...hostUpdates }
    if (hasFilter && action !== filterAction) {
      delete wireUpdates.filterRepoIds
      superseded = true
    }
    if (Object.keys(wireUpdates).length) {
      const response = await callEnvironmentEnvelope(
        environment.id,
        'ui.set',
        {
          ...wireUpdates,
          ...(exact && wireUpdates.filterRepoIds !== undefined
            ? { filterRepoIdsMode: 'exact' }
            : {})
        },
        15_000,
        revision,
        exact && wireUpdates.filterRepoIds !== undefined
          ? client.statusOwner?.read().status?.runtimeId
          : undefined
      )
      assertOwner()
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code })
      }
    }
    if (hasFilter && (superseded || action !== filterAction)) {
      throw new Error('Project filter action superseded.')
    }
  }
}
