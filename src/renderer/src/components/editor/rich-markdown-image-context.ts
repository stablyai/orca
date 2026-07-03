import type { Editor } from '@tiptap/core'
import { getConnectionId } from '@/lib/connection-context'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export type RichMarkdownImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

export type RichMarkdownImageResolverContext = {
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext
}

export type RichMarkdownImageResolverSettings = Parameters<typeof settingsForRuntimeOwner>[0]

type RichMarkdownImageStorage = {
  image?: {
    contextVersion?: number
    filePath: string
    reloadListeners?: Set<() => void>
    runtimeContext?: RichMarkdownImageRuntimeContext
  }
}

export function createRichMarkdownImageResolverContext({
  filePath,
  runtimeEnvironmentId,
  settings,
  worktreeId,
  worktreeRoot
}: {
  filePath: string
  runtimeEnvironmentId?: string | null
  settings: RichMarkdownImageResolverSettings
  worktreeId: string
  worktreeRoot: string | null
}): RichMarkdownImageResolverContext {
  return {
    filePath,
    runtimeContext: worktreeRoot
      ? {
          settings: settingsForRuntimeOwner(settings, runtimeEnvironmentId),
          worktreeId,
          worktreePath: worktreeRoot,
          connectionId: getConnectionId(worktreeId)
        }
      : undefined
  }
}

export function setRichMarkdownImageResolverContext(
  editor: Editor,
  context: RichMarkdownImageResolverContext
): boolean {
  const storage = editor.storage as unknown as RichMarkdownImageStorage
  const imageStorage = storage.image ?? {
    filePath: ''
  }
  const previousSignature = getRichMarkdownImageContextSignature({
    filePath: imageStorage.filePath,
    runtimeContext: imageStorage.runtimeContext
  })
  const nextSignature = getRichMarkdownImageContextSignature(context)
  if (previousSignature === nextSignature) {
    return false
  }

  // Why: nodeViews need a cheap change signal because the markdown src can
  // remain identical while the file/runtime resolver context changes.
  imageStorage.filePath = context.filePath
  imageStorage.runtimeContext = context.runtimeContext
  imageStorage.contextVersion = (imageStorage.contextVersion ?? 0) + 1
  storage.image = imageStorage
  for (const listener of imageStorage.reloadListeners ?? []) {
    listener()
  }
  return true
}

function getRichMarkdownImageContextSignature(context: RichMarkdownImageResolverContext): string {
  return [
    context.filePath,
    context.runtimeContext?.settings?.activeRuntimeEnvironmentId?.trim() ?? 'client',
    context.runtimeContext?.connectionId ?? 'local',
    context.runtimeContext?.worktreeId ?? 'unknown-worktree',
    context.runtimeContext?.worktreePath ?? ''
  ].join('\0')
}
