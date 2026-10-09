import type { Editor } from '@tiptap/core'
import { getConnectionId } from '@/lib/connection-context'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export type RichMarkdownImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

export type RichMarkdownImageResolverContext = {
  filePath: string
  imageUrls?: Record<string, string>
  runtimeContext?: RichMarkdownImageRuntimeContext
}

export type RichMarkdownImageResolverSettings = Parameters<typeof settingsForRuntimeOwner>[0]

type RichMarkdownImageUrls = Record<string, string>

function isRichMarkdownImageUrls(value: unknown): value is RichMarkdownImageUrls {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((url) => typeof url === 'string')
  )
}

export function resolveRichMarkdownImageUrl(storage: Record<string, unknown>, src: string): string {
  const imageUrls = storage.imageUrls
  if (isRichMarkdownImageUrls(imageUrls) && Object.hasOwn(imageUrls, src)) {
    return imageUrls[src] ?? src
  }
  return src
}

type RichMarkdownImageStorage = {
  image?: {
    contextVersion?: number
    filePath: string
    imageUrls?: Record<string, string>
    reloadListeners?: Set<() => void>
    runtimeContext?: RichMarkdownImageRuntimeContext
  }
}

export function getRichMarkdownImageResolverContextVersion(editor: Editor): number {
  const image: unknown = 'image' in editor.storage ? editor.storage.image : null
  if (!image || typeof image !== 'object') {
    return 0
  }
  const version: unknown = 'contextVersion' in image ? image.contextVersion : null
  return typeof version === 'number' ? version : 0
}

export function createRichMarkdownImageResolverContext({
  filePath,
  externalSshTargetId,
  runtimeEnvironmentId,
  settings,
  worktreeId,
  worktreeRoot
}: {
  filePath: string
  externalSshTargetId?: string
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
          connectionId: getConnectionId(worktreeId),
          expectedExternalSshTargetId: externalSshTargetId,
          expectedRuntimeEnvironmentId: runtimeEnvironmentId
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
    imageUrls: imageStorage.imageUrls,
    runtimeContext: imageStorage.runtimeContext
  })
  const nextSignature = getRichMarkdownImageContextSignature(context)
  if (previousSignature === nextSignature) {
    return false
  }

  // Why: nodeViews need a cheap change signal because the markdown src can
  // remain identical while the file/runtime resolver context changes.
  imageStorage.filePath = context.filePath
  imageStorage.imageUrls = context.imageUrls
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
    JSON.stringify(context.imageUrls ?? {}),
    context.runtimeContext?.settings?.activeRuntimeEnvironmentId?.trim() ?? 'client',
    context.runtimeContext?.connectionId ?? 'local',
    context.runtimeContext?.expectedExternalSshTargetId ?? '',
    context.runtimeContext?.worktreeId ?? 'unknown-worktree',
    context.runtimeContext?.worktreePath ?? ''
  ].join('\0')
}
