import { subscribeRuntimeRpc } from '../rpc/subscriptions/runtime-rpc-subscribe'
import { getRemoteRuntimePtyOwner } from '../hosted-terminals/identity/remote-runtime-pty-owner'
import { runtimeTargetForOwnerEnvironment } from '../rpc/targets/runtime-client-target'
import { useAppStore } from '@/store/index'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseAppSshPtyId } from '../../../../shared/remote-runtime/ssh/ssh-pty-id'
import { parseWslUncPath } from '../../../../shared/file-access/wsl-paths'

export type AgentImagePreparationOptions = {
  signal?: AbortSignal
  isCurrent?: () => boolean
  executionHostId?: string | null
  cwd?: string
}

export async function prepareAgentImagePaths(
  ptyId: string,
  paths: readonly string[],
  environmentId?: string | null,
  options: AgentImagePreparationOptions = {}
): Promise<string[]> {
  // Legacy SSH relays have no fitting service; never resolve their paths on the outer host.
  if (parseAppSshPtyId(ptyId) || options.executionHostId?.startsWith('ssh:')) {
    return [...paths]
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (isRemoteRuntimePtyId(ptyId) && !owner && !environmentId) {
    return [...paths]
  }
  const controller = new AbortController()
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(120_000),
    ...(options.signal ? [options.signal] : [])
  ])
  const checkCurrent = (): void => {
    if (options.isCurrent?.() === false) {
      controller.abort()
    }
  }
  checkCurrent()
  const stopObserving = options.isCurrent
    ? useAppStore.subscribe((next, previous) => {
        if (
          next.tabsByWorktree !== previous.tabsByWorktree ||
          next.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey ||
          next.agentStatusByPaneKey !== previous.agentStatusByPaneKey
        ) {
          checkCurrent()
        }
      })
    : () => {}
  try {
    return await new Promise<string[]>((resolve, reject) => {
      let settled = false
      let subscription: { unsubscribe: () => void } | undefined
      const finish = (value: string[] | Error): void => {
        if (settled) {
          return
        }
        settled = true
        signal.removeEventListener('abort', abort)
        subscription?.unsubscribe()
        if (value instanceof Error) {
          reject(value)
        } else {
          resolve(value)
        }
      }
      const abort = (): void => finish(new Error('Image preparation cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
        return
      }
      void subscribeRuntimeRpc(
        owner?.target ?? runtimeTargetForOwnerEnvironment(environmentId ?? null),
        'files.prepareAgentImages',
        { paths, wslDistro: options.cwd ? parseWslUncPath(options.cwd)?.distro : undefined },
        {
          onEvent: (result) => {
            checkCurrent()
            if (signal.aborted) {
              return
            }
            if (
              result &&
              typeof result === 'object' &&
              'paths' in result &&
              Array.isArray(result.paths) &&
              result.paths.every((path) => typeof path === 'string')
            ) {
              finish(result.paths)
            } else {
              finish(new Error('Invalid prepared image paths'))
            }
          },
          onError: (error) => {
            checkCurrent()
            if (signal.aborted) {
              return
            }
            if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
              finish([...paths])
            } else {
              finish(error instanceof Error ? error : new Error('Image preparation failed'))
            }
          },
          onClose: () => finish(new Error('Image preparation connection closed'))
        }
      ).then(
        (opened) => {
          subscription = opened
          if (settled) {
            opened.unsubscribe()
          }
        },
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error)))
      )
    })
  } finally {
    stopObserving()
  }
}

export function prepareTerminalAgentImagePaths(
  tabId: string,
  leafId: string,
  ptyId: string | null,
  paths: readonly string[],
  environmentId?: string | null,
  options?: AgentImagePreparationOptions
): Promise<string[]> {
  const target = captureTerminalAgentImageTarget(tabId, leafId)
  return ptyId && target
    ? prepareAgentImagePaths(ptyId, paths, environmentId, {
        ...options,
        isCurrent: () => target.isCurrent() && options?.isCurrent?.() !== false
      })
    : Promise.resolve([...paths])
}

export function captureTerminalAgentImageTarget(tabId: string, leafId: string) {
  const key = `${tabId}:${leafId}`
  const readAgent = () => {
    const state = useAppStore.getState()
    const entry = state.agentStatusByPaneKey.get(key)
    const foreground = state.paneForegroundAgentByPaneKey[key]
    return entry?.restoredUnconfirmed !== true && isTuiAgent(entry?.agentType)
      ? entry.agentType
      : !foreground?.shellForeground && isTuiAgent(foreground?.agent)
        ? foreground.agent
        : null
  }
  const agent = readAgent()
  if (!agent) {
    return null
  }
  const entry = useAppStore.getState().agentStatusByPaneKey.get(key)
  const foregroundAtCapture = useAppStore.getState().paneForegroundAgentByPaneKey[key]
  const sessionId = entry?.orcaSessionId
  const providerSessionId = entry?.providerSession?.id
  return {
    isCurrent: () => {
      const state = useAppStore.getState()
      const current = state.agentStatusByPaneKey.get(key)
      const foreground = state.paneForegroundAgentByPaneKey[key]
      return (
        !(foreground !== foregroundAtCapture && foreground?.shellForeground) &&
        readAgent() === agent &&
        (!sessionId || current?.orcaSessionId === sessionId) &&
        (!providerSessionId || current?.providerSession?.id === providerSessionId)
      )
    }
  }
}
