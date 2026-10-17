import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

export type WindowsTerminalCapabilityLoadTarget = RuntimeClientTarget

async function reconcileWslAvailability(
  available: boolean,
  distros: string[],
  probe: () => Promise<boolean>
): Promise<boolean> {
  // A non-empty list can invalidate the negative cache after the parallel probe read it.
  if (available || distros.length === 0) {
    return available
  }
  return probe().catch(() => false)
}

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
    const [
      wslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      runtimeStatus,
      niubashAvailable
    ] = await Promise.all([
      window.api.wsl.isAvailable().catch(() => false),
      window.api.wsl.listDistros().catch(() => []),
      window.api.pwsh.isAvailable().catch(() => false),
      window.api.gitBash.isAvailable().catch(() => false),
      window.api.runtime.getStatus().catch(() => null),
      readNiubashAvailability(target)
    ])
    const reconciledWslAvailable = await reconcileWslAvailability(wslAvailable, wslDistros, () =>
      window.api.wsl.isAvailable()
    )
    return {
      wslAvailable: reconciledWslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable,
      ...(niubashAvailable ? { niubashAvailable: true } : {}),
      hostPlatform: runtimeStatus?.hostPlatform ?? null,
      isLoading: false
    }
  }

  const [
    wslAvailable,
    wslDistros,
    pwshAvailable,
    gitBashAvailable,
    hostPlatform,
    niubashAvailable
  ] = await Promise.all([
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
      .catch(() => null),
    readNiubashAvailability(target)
  ])
  const reconciledWslAvailable = await reconcileWslAvailability(wslAvailable, wslDistros, () =>
    callRuntimeRpc<boolean>(target, 'host.wsl.isAvailable', undefined, {
      timeoutMs: 15_000
    })
  )
  return {
    wslAvailable: reconciledWslAvailable,
    wslDistros,
    pwshAvailable,
    gitBashAvailable,
    ...(niubashAvailable ? { niubashAvailable: true } : {}),
    hostPlatform,
    isLoading: false
  }
}

async function readNiubashAvailability(target: RuntimeClientTarget): Promise<boolean> {
  // Older hosts keep their existing shell choices when this method is unavailable.
  try {
    return (
      (await callRuntimeRpc<boolean>(target, 'host.niubash.isAvailable', undefined, {
        timeoutMs: 15_000
      })) === true
    )
  } catch {
    return false
  }
}
