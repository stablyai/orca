import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { WindowsTerminalCapabilities } from './windows-terminal-capabilities'

export type WindowsTerminalCapabilityReadResult = {
  capabilities: WindowsTerminalCapabilities
  gitBashProbed: boolean
}

async function probeGitBashAvailability(
  probe: () => Promise<boolean>
): Promise<{ available: boolean; probed: boolean }> {
  try {
    return { available: await probe(), probed: true }
  } catch {
    return { available: false, probed: false }
  }
}

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
  target: RuntimeClientTarget,
  sshConnectionId?: string | null
): Promise<WindowsTerminalCapabilityReadResult> {
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
        capabilities: {
          ...capabilities,
          wslDistros: capabilities.wslDistros ?? [],
          isLoading: false
        },
        gitBashProbed: true
      }))
      .catch(() => ({
        capabilities: {
          wslAvailable: false,
          wslDistros: [],
          pwshAvailable: false,
          gitBashAvailable: false,
          hostPlatform: null,
          isLoading: false
        },
        gitBashProbed: false
      }))
  }

  if (target.kind === 'local') {
    const [wslAvailable, wslDistros, pwshAvailable, gitBashProbe, runtimeStatus] =
      await Promise.all([
        window.api.wsl.isAvailable().catch(() => false),
        window.api.wsl.listDistros().catch(() => []),
        window.api.pwsh.isAvailable().catch(() => false),
        probeGitBashAvailability(() => window.api.gitBash.isAvailable()),
        window.api.runtime.getStatus().catch(() => null)
      ])
    const reconciledWslAvailable = await reconcileWslAvailability(wslAvailable, wslDistros, () =>
      window.api.wsl.isAvailable()
    )
    return {
      capabilities: {
        wslAvailable: reconciledWslAvailable,
        wslDistros,
        pwshAvailable,
        gitBashAvailable: gitBashProbe.available,
        hostPlatform: runtimeStatus?.hostPlatform ?? null,
        isLoading: false
      },
      gitBashProbed: gitBashProbe.probed
    }
  }

  const [wslAvailable, wslDistros, pwshAvailable, gitBashProbe, hostPlatform] = await Promise.all([
    callRuntimeRpc<boolean>(target, 'host.wsl.isAvailable', undefined, {
      timeoutMs: 15_000
    }).catch(() => false),
    callRuntimeRpc<string[]>(target, 'host.wsl.listDistros', undefined, {
      timeoutMs: 15_000
    }).catch(() => []),
    callRuntimeRpc<boolean>(target, 'host.pwsh.isAvailable', undefined, {
      timeoutMs: 15_000
    }).catch(() => false),
    probeGitBashAvailability(() =>
      callRuntimeRpc<boolean>(target, 'host.gitBash.isAvailable', undefined, { timeoutMs: 15_000 })
    ),
    callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, { timeoutMs: 15_000 })
      .then((status) => status.hostPlatform ?? null)
      .catch(() => null)
  ])
  const reconciledWslAvailable = await reconcileWslAvailability(wslAvailable, wslDistros, () =>
    callRuntimeRpc<boolean>(target, 'host.wsl.isAvailable', undefined, {
      timeoutMs: 15_000
    })
  )
  return {
    capabilities: {
      wslAvailable: reconciledWslAvailable,
      wslDistros,
      pwshAvailable,
      gitBashAvailable: gitBashProbe.available,
      hostPlatform,
      isLoading: false
    },
    gitBashProbed: gitBashProbe.probed
  }
}
