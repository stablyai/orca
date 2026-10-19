import type { TerminalPasteRuntime } from './terminal-paste-model'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId
} from '../../../../shared/remote-runtime-pty-id'
import { runtimeEnvironmentIdWithLegacyFallbackUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import type { PtyTransport } from './pty-transport-types'

type TerminalPasteRuntimeTransport = {
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
  transport?: TerminalPasteRuntimeTransport | null
  isWindowsConpty?: boolean
}

export function resolveTerminalPasteRuntime({
  platform,
  ptyId,
  transport,
  isWindowsConpty
}: ResolveTerminalPasteRuntimeArgs): TerminalPasteRuntime {
  const windowsConpty = isWindowsConpty === undefined ? {} : { isWindowsConpty }

  if (isRemoteRuntimePtyId(ptyId)) {
    return { platform, runtimeKey: `remote:${ptyId}`, kind: 'remote-runtime', ...windowsConpty }
  }

  const wslRuntimeKey = resolveWslRuntimeKey(transport?.getLocalSessionMetadata?.())
  if (wslRuntimeKey) {
    return { platform, runtimeKey: wslRuntimeKey, kind: 'wsl', ...windowsConpty }
  }

  return { platform, runtimeKey: `local:${platform}`, kind: 'local', ...windowsConpty }
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

export function isWslShellOverride(shellOverride: string | null | undefined): boolean {
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

/** The server a paste uploads images to: the one its PTY id names, else the workspace owner's. */
export function resolveTerminalPasteRuntimeEnvironmentId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  transport: Pick<PtyTransport, 'getPtyId'> | null | undefined
): string | null {
  const ptyId = transport?.getPtyId() ?? null
  return (
    (ptyId ? parseRemoteRuntimePtyId(ptyId)?.environmentId : null) ??
    runtimeEnvironmentIdWithLegacyFallbackUnlessTwin(state, worktreeId)
  )
}
