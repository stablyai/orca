import type { Editor } from '@tiptap/core'
import { getConnectionId } from '@/lib/connection-context'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'

export type RichMarkdownImageRuntimeContext = Omit<RuntimeFileOperationArgs, 'connectionId'> & {
  connectionId?: string | null
}

export type RichMarkdownImageResolverContext = {
  filePath: string
  imageUrls?: Record<string, string>
  /** `null`: the owner is unresolved, so local images must not load; `undefined`: no workspace. */
  runtimeContext?: RichMarkdownImageRuntimeContext | null
}

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
    runtimeContext?: RichMarkdownImageRuntimeContext | null
  }
}

/** The image node view's storage; its context is validated on read. */
export type RichMarkdownImageNodeStorage = { runtimeContext?: unknown }

/** The stored image context; `null` (unresolved owner) is kept so readers refuse instead of going local. */
export function readRichMarkdownImageRuntimeContext(
  storage: RichMarkdownImageNodeStorage
): RichMarkdownImageRuntimeContext | null | undefined {
  const value = storage.runtimeContext
  if (value === null) {
    return null
  }
  return isRichMarkdownImageRuntimeContext(value) ? value : undefined
}

function isRichMarkdownImageRuntimeContext(
  value: unknown
): value is RichMarkdownImageRuntimeContext {
  return typeof value === 'object' && value !== null && 'target' in value && 'worktreeId' in value
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
  runtimeTarget,
  worktreeId,
  worktreeRoot
}: {
  filePath: string
  externalSshTargetId?: string
  /** The document owner's transport; `null` while unresolved, which blocks local image reads. */
  runtimeTarget: RuntimeClientTarget | null
  worktreeId: string
  worktreeRoot: string | null
}): RichMarkdownImageResolverContext {
  return {
    filePath,
    runtimeContext: !worktreeRoot
      ? undefined
      : runtimeTarget
        ? {
            target: runtimeTarget,
            worktreeId,
            worktreePath: worktreeRoot,
            connectionId: getConnectionId(worktreeId),
            expectedExternalSshTargetId: externalSshTargetId
          }
        : null
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
    context.runtimeContext === null
      ? 'unresolved'
      : context.runtimeContext?.target.kind === 'environment'
        ? context.runtimeContext.target.environmentId
        : 'client',
    context.runtimeContext?.connectionId ?? 'local',
    context.runtimeContext?.expectedExternalSshTargetId ?? '',
    context.runtimeContext?.worktreeId ?? 'unknown-worktree',
    context.runtimeContext?.worktreePath ?? ''
  ].join('\0')
}
