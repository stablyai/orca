import { useMemo } from 'react'
import { createConnectionIdForFileSelector } from '@/lib/connection-owner-resolution'
import { useFileOwnerRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { GltfResourceReader } from './gltf-model-parse'
import { createGltfResourceReader } from './gltf-resource-reader'
import {
  deriveMarkdownPreviewSourceRoot,
  resolveMarkdownPreviewSourceWorktree
} from './markdown-preview-source-routing'

type GltfDocumentOwner = {
  filePath: string
  relativePath: string | null | undefined
  worktreeId: string | null | undefined
  runtimeEnvironmentId: string | null | undefined
  externalSshTargetId: string | undefined
}

/** A reader for the `.gltf`'s sibling resources, or null while its owner is unresolved. */
export function useGltfResourceReader({
  filePath,
  relativePath,
  worktreeId,
  runtimeEnvironmentId,
  externalSshTargetId
}: GltfDocumentOwner): GltfResourceReader | null {
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const worktree = resolveMarkdownPreviewSourceWorktree(worktreesByRepo, worktreeId, filePath)
  const routingWorktreeId = worktree?.id ?? worktreeId ?? null
  const runtimeOwnerId = runtimeEnvironmentId?.trim()
  const connectionIdSelector = useMemo(
    () =>
      createConnectionIdForFileSelector(routingWorktreeId, filePath, {
        skip: Boolean(runtimeOwnerId)
      }),
    [filePath, routingWorktreeId, runtimeOwnerId]
  )
  const connectionId = useAppStore(connectionIdSelector) ?? undefined
  const worktreeRoot =
    worktree?.path ??
    (routingWorktreeId ? deriveMarkdownPreviewSourceRoot(filePath, relativePath) : null)
  const target = useFileOwnerRuntimeTarget(routingWorktreeId, runtimeEnvironmentId)

  return useMemo(() => {
    if (!routingWorktreeId || !worktreeRoot) {
      return createGltfResourceReader(
        { target: { kind: 'local' }, worktreeId: null, worktreePath: null, connectionId },
        filePath
      )
    }
    if (!target) {
      return null
    }
    return createGltfResourceReader(
      {
        target,
        worktreeId: routingWorktreeId,
        worktreePath: worktreeRoot,
        connectionId,
        expectedExternalSshTargetId: externalSshTargetId
      },
      filePath
    )
  }, [connectionId, externalSshTargetId, filePath, routingWorktreeId, target, worktreeRoot])
}
