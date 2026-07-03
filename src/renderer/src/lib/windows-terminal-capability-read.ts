import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

export type WindowsTerminalCapabilityLoadTarget = RuntimeClientTarget

export async function readWindowsTerminalCapabilities(
  target: WindowsTerminalCapabilityLoadTarget,
  sshConnectionId?: string | null
): Promise<WindowsTerminalCapabilities> {
  if (sshConnectionId) {
    const remoteCapabilityPromise =
      target.kind === 'environment'
        ? callRuntimeRpc<Omit<WindowsTerminalCapabilities, 'isLoading'>>(
            target,
            'preflight.detectRemoteWindowsTerminalCapabilities',
            { connectionId: sshConnectionId },
            { timeoutMs: 15_000 }
          )
        : window.api.preflight.detectRemoteWindowsTerminalCapabilities({
            connectionId: sshConnectionId
          })
    return remoteCapabilityPromise
      .then((capabilities) => ({
        ...capabilities,
        wslDistros: capabilities.wslDistros ?? [],
        isLoading: false
      }))
      .catch(() => ({
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null,
        isLoading: false
      }))
  }

  if (target.kind === 'local') {
    const [wslAvailable, wslDistros, pwshAvailable, gitBashAvailable, hostPlatform] =
      await Promise.all([
        window.api.wsl.isAvailable().catch(() => false),
        window.api.wsl.listDistros().catch(() => []),
        window.api.pwsh.isAvailable().catch(() => false),
        window.api.gitBash.isAvailable().catch(() => false),
        window.api.runtime
          .getStatus()
          .then((status) => status.hostPlatform ?? null)
          .catch(() => null)
      ])
    return {
      wslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      hostPlatform,
      isLoading: false
    }
  }

  const [wslAvailable, wslDistros, pwshAvailable, gitBashAvailable, hostPlatform] =
    await Promise.all([
      callRuntimeRpc<boolean>(target, 'host.wsl.isAvailable', undefined, {
        timeoutMs: 15_000
      }).catch(() => false),
      callRuntimeRpc<string[]>(target, 'host.wsl.listDistros', undefined, {
        timeoutMs: 15_000
      }).catch(() => []),
      callRuntimeRpc<boolean>(target, 'host.pwsh.isAvailable', undefined, {
        timeoutMs: 15_000
      }).catch(() => false),
      callRuntimeRpc<boolean>(target, 'host.gitBash.isAvailable', undefined, {
        timeoutMs: 15_000
      }).catch(() => false),
      callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, { timeoutMs: 15_000 })
        .then((status) => status.hostPlatform ?? null)
        .catch(() => null)
    ])
  return {
    wslAvailable,
    wslDistros,
    pwshAvailable,
    gitBashAvailable,
    hostPlatform,
    isLoading: false
  }
}
