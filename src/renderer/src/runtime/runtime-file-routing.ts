import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  isWindowsAbsolutePathLike,
  relativePathInsideRoot
} from '../../../shared/cross-platform-path'
import { normalizeRelativePath } from '@/lib/path'
import { getActiveRuntimeTarget } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'

export function assertExternalSshReadOwnership(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | undefined,
  expectedExternalSshTargetId: string | undefined
): void {
  const expectedTargetId = expectedExternalSshTargetId?.trim()
  if (
    expectedTargetId &&
    (getActiveRuntimeTarget(settings).kind === 'environment' || connectionId !== expectedTargetId)
  ) {
    throw new Error('External SSH files are not available after the workspace host changes.')
  }
}

export function withSshMutationExpectation<T extends object>(
  context: RuntimeFileOperationArgs,
  params: T
): T & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
} {
  const sshTargetId = context.expectedSshTargetId ?? context.connectionId
  return {
    ...params,
    expectedExecutionHostId:
      context.expectedExecutionHostId ??
      (sshTargetId ? `ssh:${encodeURIComponent(sshTargetId)}` : 'local'),
    ...(context.expectedSshTargetId === undefined
      ? {}
      : { expectedSshTargetId: context.expectedSshTargetId }),
    ...(context.expectedSshConnectionGeneration === undefined
      ? {}
      : { expectedSshConnectionGeneration: context.expectedSshConnectionGeneration })
  }
}

export function getRuntimeFileReadScope(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  connectionId: string | undefined
): string | undefined {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : connectionId
}

export function isRemoteRuntimeFileOperation(
  context: RuntimeFileOperationArgs,
  path: string
): boolean {
  return getRemoteFileArgs(context, path) !== null
}

export function canReadRelativeRuntimeFile(
  relativePath: string | undefined
): relativePath is string {
  return Boolean(relativePath && relativePath.trim() && !isAbsolutePathLike(relativePath))
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePathLike(value)
}

export function getRemoteFileArgs(
  context: RuntimeFileOperationArgs,
  absolutePath: string
): {
  target: ReturnType<typeof getActiveRuntimeTarget> & { kind: 'environment' }
  worktreeId: string
  worktreeSelector: string
  relativePath: string
} | null {
  const target = getActiveRuntimeTarget(context.settings)
  if (target.kind !== 'environment' || !context.worktreeId) {
    return null
  }
  const relativePath = getRelativePathInsideWorktree(context.worktreePath, absolutePath)
  if (relativePath === null) {
    return null
  }
  return {
    target,
    worktreeId: context.worktreeId,
    worktreeSelector: toRuntimeWorktreeSelector(context.worktreeId),
    relativePath
  }
}

export function hasRemoteRuntimeOwner(context: RuntimeFileOperationArgs): boolean {
  return (
    getActiveRuntimeTarget(context.settings).kind === 'environment' && Boolean(context.worktreeId)
  )
}

export function assertLocalFilesystemFallbackAllowed(context: RuntimeFileOperationArgs): void {
  if (hasRemoteRuntimeOwner(context)) {
    throw new Error('Remote file is outside the owning runtime worktree')
  }
}

export function getRelativePathInsideWorktree(
  worktreePath: string | null | undefined,
  absolutePath: string
): string | null {
  if (!worktreePath) {
    return null
  }
  return relativePathInsideRoot(worktreePath, absolutePath)
}

export function joinRuntimeRelativePath(basePath: string, relativePath: string): string {
  const normalizedBase = normalizeRelativePath(basePath)
  const normalizedRelative = normalizeRelativePath(relativePath)
  if (!normalizedBase) {
    return normalizedRelative
  }
  if (!normalizedRelative) {
    return normalizedBase
  }
  return `${normalizedBase}/${normalizedRelative}`
}
