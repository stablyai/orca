import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  isBrowserAttachmentToken,
  readBrowserAttachmentFile
} from '@/lib/files/drop/browser-attachment-files'
import {
  adoptNativeChatStagedFile,
  currentFiles,
  nativeChatStagedFileOwners,
  stagedNativeChatFiles,
  type NativeChatStagedInput,
  type NativeChatStagedUpload,
  type StagedFiles
} from './native-chat-draft-attachment-staging'

/** Expired host path → the one live upload record and its staging owner it may be restored from. */
export type NativeChatExpiredUploadRestore = Map<
  string,
  { owner: StagedFiles; origin: NativeChatStagedUpload }
>

/**
 * A host refused uploads it no longer stores, for a message of conversation `sessionId`. Decide (without
 * changing anything yet) which expired host paths may come back as their originals. The authority is
 * the upload's own identity: exactly one live record names the path, it was made for this same
 * conversation, and its original is still staged and its bytes still readable (a browser file's bytes
 * live only in this renderer). Anything else keeps the existing unavailable chip or reference.
 */
export function planNativeChatExpiredUploadRestore(
  sessionId: string,
  expiredHostPaths: Iterable<string>
): NativeChatExpiredUploadRestore {
  const plan: NativeChatExpiredUploadRestore = new Map()
  for (const host of new Set(expiredHostPaths)) {
    const owners = nativeChatStagedFileOwners().filter((owner) => owner.uploaded.has(host))
    const owner = owners.length === 1 ? owners[0] : undefined
    const origin = owner?.uploaded.get(host)
    if (
      owner &&
      origin &&
      origin.sessionId === sessionId &&
      owner.paths.has(origin.source) &&
      (!isBrowserAttachmentToken(origin.source) || readBrowserAttachmentFile(origin.source))
    ) {
      plan.set(host, { owner, origin })
    }
  }
  return plan
}

/**
 * The returned message is now installed in `scope`. Each planned original that draft actually holds
 * becomes this draft's: only its producing cached upload is forgotten (a healthy or newer upload of the
 * same original stays), and the original moves into `scope`'s own staging, its single owner from now
 * on. A planned original the installed draft does not hold is left exactly where it was. Returns the
 * expired host paths that were restored.
 *
 * Each record is looked up where it lives now, not where it was planned: adopting an original moves
 * all of its records, so a second expired upload of the same original is found in the recipient.
 */
export function commitNativeChatExpiredUploadRestore(
  scope: string,
  plan: NativeChatExpiredUploadRestore,
  held: (original: string) => boolean
): Set<string> {
  const restored = new Set<string>()
  for (const [host, { origin }] of plan) {
    const owner = nativeChatStagedFileOwners().find(
      (candidate) => candidate.uploaded.get(host) === origin
    )
    if (!owner || !held(origin.source)) {
      continue
    }
    owner.uploaded.delete(host)
    const cache = owner.uploads.get(origin.target)
    if (cache?.get(origin.source) === origin.upload) {
      cache.delete(origin.source)
    }
    adoptNativeChatStagedFile(owner, origin.source, scope)
    restored.add(host)
  }
  return restored
}

/**
 * The part of a send this draft can still make. A renderer-only browser-file reference that this draft
 * no longer stages (adopted by the chat a refusal returned it to, or released) names bytes it does not
 * own: it is left out, attachment and text reference alike, so a send or Retry from here never ships a
 * reference nothing on the host can read. Everything else is kept as it is.
 */
export function ownedNativeChatStagedInput<T extends NativeChatStagedInput>(
  scope: string,
  input: T
): T {
  const files = stagedNativeChatFiles(scope)
  return withoutUnownedBrowserFiles(files && currentFiles(files), input)
}

/**
 * The fail-closed rule, applied with the staging that sends: a browser-file reference `owner` does not
 * stage at this moment is removed, attachment and text reference alike. It is the same rule the first
 * send's plan applies, checked again where the payload leaves (see `captureNativeChatStagedInput`).
 */
export function withoutUnownedBrowserFiles<T extends NativeChatStagedInput>(
  owner: StagedFiles | undefined,
  input: T
): T {
  const foreign = (path: string): boolean =>
    isBrowserAttachmentToken(path) && !owner?.paths.has(path)
  const text = nativeChatTextAttachmentParts(input.text, true, foreign)
    .map((part) => (part.path ? '' : part.text))
    .join('')
  return {
    ...input,
    text,
    ...(input.attachments
      ? { attachments: input.attachments.filter(({ path }) => !foreign(path)) }
      : {})
  }
}
