import type { TerminalPasteRuntime } from './terminal-paste-model'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

const REMOTE_PTY_ID_PREFIX = 'remote:'

type TerminalPasteRuntimeTransport = {
  getConnectionId?: () => string | null | undefined
  getRemotePlatform?: () => NodeJS.Platform | null | undefined
  getLocalSessionMetadata?: () =>
    | {
        cwd?: string
        shellOverride?: string
      }
    | null
    | undefined
}

type ResolveTerminalPasteRuntimeArgs = {
  platform: NodeJS.Platform
  ptyId: string | null
  connectionId?: string | null
  remotePlatform?: NodeJS.Platform | null
  transport?: TerminalPasteRuntimeTransport | null
  isWindowsConpty?: boolean
}

export function resolveTerminalPasteRuntime({
  platform,
  ptyId,
  connectionId,
  remotePlatform,
  transport,
  isWindowsConpty
}: ResolveTerminalPasteRuntimeArgs): TerminalPasteRuntime {
  const windowsConpty = isWindowsConpty === undefined ? {} : { isWindowsConpty }

  if (isRemoteRuntimePastePtyId(ptyId)) {
    return { platform, runtimeKey: `remote:${ptyId}`, kind: 'remote-runtime', ...windowsConpty }
  }

  const transportConnectionId = transport?.getConnectionId?.()
  // Why: paste planning must follow the already-running terminal session, not
  // a worktree connection that may have changed after the PTY was created.
  const effectiveConnectionId =
    transportConnectionId === undefined ? (connectionId ?? null) : transportConnectionId

  if (effectiveConnectionId) {
    const sshPlatform = transport?.getRemotePlatform?.() ?? remotePlatform ?? platform
    return {
      platform: sshPlatform,
      runtimeKey: `ssh:${effectiveConnectionId}`,
      kind: 'ssh',
      ...windowsConpty
    }
  }

  const wslRuntimeKey = resolveWslRuntimeKey(transport?.getLocalSessionMetadata?.())
  if (wslRuntimeKey) {
    return { platform, runtimeKey: wslRuntimeKey, kind: 'wsl', ...windowsConpty }
  }

  return { platform, runtimeKey: `local:${platform}`, kind: 'local', ...windowsConpty }
}

export function isRemoteRuntimePastePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

function resolveWslRuntimeKey(
  metadata:
    | {
        cwd?: string
        shellOverride?: string
      }
    | null
    | undefined
): string | null {
  const parsedCwd = metadata?.cwd ? parseWslUncPath(metadata.cwd) : null
  if (parsedCwd?.distro) {
    return `wsl:${parsedCwd.distro}`
  }
  if (isWslShellOverride(metadata?.shellOverride)) {
    return 'wsl:default'
  }
  return null
}

function isWslShellOverride(shellOverride: string | null | undefined): boolean {
  return /(?:^|[/\\])wsl(?:\.exe)?$/i.test(shellOverride ?? '')
}
