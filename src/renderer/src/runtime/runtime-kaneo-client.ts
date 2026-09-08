import { createBrowserUuid } from '@/lib/browser-uuid'
import type { KaneoApi, KaneoTask } from '../../../shared/kaneo-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { callRuntimeRpc, getActiveRuntimeTarget, RuntimeRpcCallError } from './runtime-rpc-client'

export type KaneoRuntimeSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined

export function getKaneoApi(settings: KaneoRuntimeSettings): KaneoApi {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.kaneo
  }
  async function call<T>(method: string, params?: unknown): Promise<T> {
    try {
      return await callRuntimeRpc<T>(target, `kaneo.${method}`, params, { timeoutMs: 30_000 })
    } catch (error) {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        throw new Error('Update the selected Orca runtime to use Kaneo.')
      }
      throw error
    }
  }
  return {
    status: () => call('status'),
    connect: (args) => call('connect', args),
    disconnect: async () => {
      await call('disconnect')
    },
    getTask: (args) => call('getTask', args)
  }
}

export async function lookupKaneoTask(
  settings: KaneoRuntimeSettings,
  url: string,
  signal: AbortSignal
): Promise<KaneoTask> {
  signal.throwIfAborted()
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    try {
      return await callRuntimeRpc<KaneoTask>(
        target,
        'kaneo.getTask',
        { url },
        { timeoutMs: 30_000, signal }
      )
    } catch (error) {
      if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
        throw new Error('Update the selected Orca runtime to use Kaneo.')
      }
      throw error
    }
  }
  const requestId = createBrowserUuid()
  const api = getKaneoApi(settings)
  const abort = () => {
    void window.api.kaneo.cancelTask({ requestId }).catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const task = await api.getTask({ url, requestId })
    signal.throwIfAborted()
    return task
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
