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
  const executable = getShellOverrideExecutableToken(shellOverride)
  const segmentStart = getShellOverridePathSegmentStart(executable)
  const name = executable.slice(segmentStart).toLowerCase()
  return name === 'wsl' || name === 'wsl.exe'
}

function getShellOverrideExecutableToken(shellOverride: string | null | undefined): string {
  const value = shellOverride ?? ''
  let index = 0
  while (index < value.length && isShellOverrideWhitespace(value.charCodeAt(index))) {
    index += 1
  }
  if (index >= value.length) {
    return ''
  }

  const quote = value[index]
  if (quote === '"' || quote === "'") {
    const tokenStart = index + 1
    for (let end = tokenStart; end < value.length; end += 1) {
      if (value[end] === quote) {
        return value.slice(tokenStart, end)
      }
    }
    return value.slice(tokenStart)
  }

  const tokenStart = index
  while (index < value.length && !isShellOverrideWhitespace(value.charCodeAt(index))) {
    index += 1
  }
  return value.slice(tokenStart, index)
}

function getShellOverridePathSegmentStart(token: string): number {
  for (let index = token.length - 1; index >= 0; index -= 1) {
    const code = token.charCodeAt(index)
    if (code === 47 || code === 92) {
      return index + 1
    }
  }
  return 0
}

function isShellOverrideWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}
