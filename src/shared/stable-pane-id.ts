import { isWindowsAbsolutePathLike, normalizeRuntimePathSeparators } from './cross-platform-path'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeId } from './worktree-id'

// Why: paneKey crosses renderer reloads, PTY env, hook IPC, and retained UI
// rows, so it must use the durable terminal-layout leaf UUID instead of the
// renderer-local numeric PaneManager id.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

declare const stablePaneIdBrand: unique symbol
declare const terminalLeafIdBrand: unique symbol
declare const paneKeyBrand: unique symbol
declare const paneSpawnReservationKeyBrand: unique symbol

export type StablePaneId = string & { readonly [stablePaneIdBrand]: true }
export type TerminalLeafId = StablePaneId & { readonly [terminalLeafIdBrand]: true }
export type PaneKey = string & { readonly [paneKeyBrand]: true }
export type PaneSpawnReservationKey = string & {
  readonly [paneSpawnReservationKeyBrand]: true
}
export type PaneSpawnReservationPathFlavor = 'posix' | 'windows' | 'unknown'

export function isStablePaneId(value: string): value is StablePaneId {
  return UUID_RE.test(value)
}

export function isTerminalLeafId(value: string): value is TerminalLeafId {
  return isStablePaneId(value)
}

export function makePaneKey(tabId: string, stableLeafId: string): PaneKey {
  if (!tabId || tabId.includes(':')) {
    throw new Error('tabId must be non-empty and must not contain ":"')
  }
  if (!isTerminalLeafId(stableLeafId)) {
    throw new Error('stableLeafId must be a UUID')
  }
  return `${tabId}:${stableLeafId}` as PaneKey
}

function canonicalPaneReservationPath(
  path: string,
  pathFlavor: PaneSpawnReservationPathFlavor
): string {
  // Why: leading // is valid on POSIX; syntax alone cannot prove Windows ownership.
  if (pathFlavor !== 'windows' || !isWindowsAbsolutePathLike(path)) {
    return path
  }
  const normalized = normalizeRuntimePathSeparators(path)
  const trimmed = /^[A-Za-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, '')
  const wslUnc = trimmed.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i)
  return wslUnc ? `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}` : trimmed.toLowerCase()
}

export function arePaneSpawnReservationPathsEqual(
  left: string,
  right: string,
  pathFlavor: PaneSpawnReservationPathFlavor
): boolean {
  return (
    canonicalPaneReservationPath(left, pathFlavor) ===
    canonicalPaneReservationPath(right, pathFlavor)
  )
}

function canonicalWorkspaceIdentity(
  workspaceId: string,
  pathFlavor: PaneSpawnReservationPathFlavor
): readonly string[] | null {
  if (!workspaceId.trim() || workspaceId.length > 1024) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  const kind = scope?.type ?? 'worktree'
  const unscopedId =
    scope?.type === 'worktree'
      ? scope.worktreeId
      : scope?.type === 'folder'
        ? scope.folderWorkspaceId
        : workspaceId
  const parsed = splitWorktreeId(unscopedId)
  return parsed
    ? [kind, parsed.repoId, canonicalPaneReservationPath(parsed.worktreePath, pathFlavor)]
    : [kind, unscopedId]
}

export function makePaneSpawnReservationKey(args: {
  paneKey: PaneKey
  providerId: string
  connectionId?: string | null
  executionRuntime?: string | null
  pathFlavor: PaneSpawnReservationPathFlavor
  workspaceId?: string
  sessionId?: string | null
  spawnPath?: string | null
  routeOrReconnectFreshness?: string | null
}): PaneSpawnReservationKey | null {
  const workspace = args.workspaceId
    ? canonicalWorkspaceIdentity(args.workspaceId, args.pathFlavor)
    : null
  const providerId = args.providerId.trim()
  const connectionId = args.connectionId?.trim() || null
  const executionRuntime = args.executionRuntime?.trim() || null
  const sessionId = args.sessionId?.trim() || null
  const spawnPath = args.spawnPath
    ? canonicalPaneReservationPath(args.spawnPath, args.pathFlavor)
    : null
  const routeOrReconnectFreshness = args.routeOrReconnectFreshness?.trim() || null
  if (
    !workspace ||
    !providerId ||
    providerId.length > 256 ||
    (connectionId?.length ?? 0) > 512 ||
    (executionRuntime?.length ?? 0) > 256 ||
    (sessionId?.length ?? 0) > 512 ||
    (spawnPath?.length ?? 0) > 32_768 ||
    (routeOrReconnectFreshness?.length ?? 0) > 4_096
  ) {
    return null
  }
  return JSON.stringify([
    providerId,
    connectionId,
    executionRuntime,
    workspace,
    spawnPath,
    routeOrReconnectFreshness,
    sessionId,
    args.paneKey
  ]) as PaneSpawnReservationKey
}

export function parsePaneKey(
  paneKey: string
): { tabId: string; leafId: TerminalLeafId; stablePaneId: StablePaneId } | null {
  const first = paneKey.indexOf(':')
  if (first <= 0 || first !== paneKey.lastIndexOf(':') || first === paneKey.length - 1) {
    return null
  }
  const tabId = paneKey.slice(0, first)
  const leafId = paneKey.slice(first + 1)
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return { tabId, leafId, stablePaneId: leafId }
}

export function parseLegacyNumericPaneKey(
  paneKey: unknown
): { tabId: string; numericPaneId: string; paneKey: string } | null {
  if (typeof paneKey !== 'string' || paneKey.length > 256) {
    return null
  }
  const trimmed = paneKey.trim()
  const delimiter = trimmed.indexOf(':')
  if (
    delimiter <= 0 ||
    delimiter !== trimmed.lastIndexOf(':') ||
    delimiter === trimmed.length - 1
  ) {
    return null
  }
  const numericPaneId = trimmed.slice(delimiter + 1)
  if (!/^\d+$/.test(numericPaneId)) {
    return null
  }
  return { tabId: trimmed.slice(0, delimiter), numericPaneId, paneKey: trimmed }
}
