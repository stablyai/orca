import { nativeChatStagedLeaseRetired } from './native-chat-staged-ownership'
import { formatNativeChatFileReference } from '../../../../../shared/native-chat/input/composer/agent-image-paste'
import { nativeChatTextAttachmentParts } from '../../../../../shared/native-chat/attachments/native-chat-text-attachment-references'
import {
  adoptNativeChatStagedFile,
  reconcileNativeChatStagedDraft,
  currentFiles,
  inputPaths,
  namedNativeChatStagedPaths,
  nativeChatStagedFileHeld,
  nativeChatStagedFileOwners,
  pruneFiles,
  stagedNativeChatFiles,
  type NativeChatStagedInput,
  type StagedFiles
} from './native-chat-draft-attachment-staging'
import { nativeChatBrowserFileRefusal } from '../attachments/native-chat-browser-file-refusal'
import { agentSessionWriteNoticeText } from '../messages/notices/agent-session-write-notice-text'

type UploadSession = { sessionId: string; runtimeEnvironmentId: string | null }

/** The staging that holds this cached upload now: adoption can move it to another draft mid-flight. */
function uploadHolder(
  target: string,
  source: string,
  upload: Promise<string>
): StagedFiles | undefined {
  return nativeChatStagedFileOwners().find(
    (owner) => owner.uploads.get(target)?.get(source) === upload
  )
}

/**
 * This send lost custody of staged originals it names (another draft adopted them): it is refused
 * whole, and its message says so (see `nativeChatBrowserFileRefusal`).
 */
export class NativeChatStagedCustodyLostError extends Error {
  constructor(
    readonly references: readonly string[],
    sessionId: string
  ) {
    const parts = nativeChatBrowserFileRefusal(references, sessionId)
    super(parts ? agentSessionWriteNoticeText(parts) : '')
    this.name = 'NativeChatStagedCustodyLostError'
  }
}

/** What a send's grant still covers: the original is in its lease and its staging still owns it. */
type StagedCustody = { lost: (paths: readonly string[]) => string[] }

/**
 * Upload the staged originals `input` names, and map them to their host paths. Custody is checked
 * before any upload starts and again once every upload settled: an original another draft adopted
 * meanwhile is neither uploaded nor delivered by this send.
 */
async function uploadStagedInput<T extends NativeChatStagedInput>(
  files: StagedFiles | undefined,
  input: T,
  session: UploadSession,
  granted: ReadonlySet<string>,
  custody: StagedCustody
): Promise<T & { custodyLost?: () => readonly string[] }> {
  if (!files) {
    return input
  }
  const paths = namedNativeChatStagedPaths(granted, input)
  if (!paths.length) {
    return input
  }
  const custodyLost = (): readonly string[] => custody.lost(paths)
  const requireCustody = (): void => {
    const lost = custodyLost()
    if (lost.length) {
      throw new NativeChatStagedCustodyLostError(lost, session.sessionId)
    }
  }
  requireCustody()
  if (!session.runtimeEnvironmentId) {
    return { ...input, custodyLost }
  }
  const { prepareNativeChatSessionAttachmentUpload, uploadNativeChatSessionAttachmentPaths } =
    await import('../attachments/uploads/native-chat-session-attachment-upload')
  const { resolveNativeChatRuntimeSessionAttachmentOwner } =
    await import('../attachments/uploads/native-chat-attachment-owner')
  const owner = resolveNativeChatRuntimeSessionAttachmentOwner({
    sessionId: session.sessionId,
    runtimeEnvironmentId: session.runtimeEnvironmentId
  })
  if (owner.kind !== 'runtime-session') {
    throw new Error('The chat attachment host is unavailable.')
  }
  const prepared = await prepareNativeChatSessionAttachmentUpload(owner)
  if (!prepared.ok) {
    throw new Error(prepared.notice)
  }
  // The awaits above can outlast an adoption: no upload starts for an original this send lost.
  requireCustody()
  const ownerFiles = currentFiles(files)
  const key = JSON.stringify(prepared.target)
  const uploads = ownerFiles.uploads.get(key) ?? new Map<string, Promise<string>>()
  ownerFiles.uploads.set(key, uploads)
  const missing = paths.filter((path) => !uploads.has(path))
  if (missing.length) {
    const upload = uploadNativeChatSessionAttachmentPaths(missing, prepared.target)
    for (const source of missing) {
      // Settles with whichever staging holds it by then, not the one that started it.
      const saved: Promise<string> = upload.then((result) => {
        const uploaded = result.uploaded.find((file) => file.sourcePath === source)
        if (uploaded) {
          ;(uploadHolder(key, source, saved) ?? currentFiles(files)).uploaded.set(uploaded.path, {
            target: key,
            source,
            sessionId: prepared.target.sessionId,
            upload: saved
          })
          return uploaded.path
        }
        throw new Error(
          result.failed.find((file) => file.sourcePath === source)?.reason ||
            'Some attachments could not be uploaded.'
        )
      })
      uploads.set(source, saved)
      void saved.catch(() => {
        uploadHolder(key, source, saved)?.uploads.get(key)?.delete(source)
      })
    }
  }
  const uploaded = new Map(
    await Promise.all(paths.map(async (path) => [path, await uploads.get(path)!] as const))
  )
  // An upload that finished after an adoption is the adopter's now: this send may not deliver it.
  requireCustody()
  const text = nativeChatTextAttachmentParts(input.text, true, (path) => uploaded.has(path))
    .map((part) =>
      part.path ? formatNativeChatFileReference(uploaded.get(part.path)!) : part.text
    )
    .join('')
  return {
    ...input,
    text,
    attachments: input.attachments?.map((image) => ({
      ...image,
      path: uploaded.get(image.path) ?? image.path
    })),
    custodyLost
  }
}

/** Keep the submitted files across draft moves, and retain successful uploads after a partial failure. */
export function captureNativeChatStagedInput(scope: string, input?: NativeChatStagedInput) {
  const files = stagedNativeChatFiles(scope)
  return captureStagedPaths(
    files,
    files ? (input ? inputPaths(currentFiles(files), input) : [...files.paths]) : []
  )
}

/**
 * The same capture, made only when `input` names an original this scope's staging holds (else
 * undefined): the named paths are found once, for the decision and the capture both.
 */
export function captureNativeChatStagedInputNamed(scope: string, input: NativeChatStagedInput) {
  const files = stagedNativeChatFiles(scope)
  const paths = files ? inputPaths(currentFiles(files), input) : []
  return paths.length ? captureStagedPaths(files, paths) : undefined
}

function captureStagedPaths(files: StagedFiles | undefined, paths: string[]) {
  // Each attempt owns its lease: releasing one never changes another's grant or prunes an original
  // another attempt still leases. A retained input hold for exactly these files becomes this
  // attempt's lease (it ends with this attempt, as it did before); a later attempt never shares it.
  const holder = files && currentFiles(files)
  const held = [...(holder?.heldInputs ?? [])].find(
    (candidate) => paths.length === candidate.size && paths.every((path) => candidate.has(path))
  )
  const lease = new Set(paths)
  holder?.leases.add(lease)
  if (held) {
    holder?.heldInputs.delete(held)
  }
  // The send's grant: the originals captured now. Adoption removes one from every lease of its old
  // staging, so a path still in this lease, and still in its staging, is still this send's to deliver.
  const granted: ReadonlySet<string> = new Set(paths)
  const custody: StagedCustody = {
    lost: (named) => {
      const owner = files && currentFiles(files)
      return named.filter((path) => !lease.has(path) || !owner?.paths.has(path))
    }
  }
  let released = false
  let retryHold: { owner: StagedFiles; paths: Set<string> } | undefined
  const release = (input?: NativeChatStagedInput): void => {
    if (released) {
      return
    }
    if (!input) {
      released = true
    }
    if (files) {
      const owner = currentFiles(files)
      const released = input ? inputPaths(owner, input) : [...lease]
      released.forEach((path) => lease.delete(path))
      if (!lease.size) {
        owner.leases.delete(lease)
        owner.heldInputs.delete(lease)
        owner.pendingLeases.delete(lease)
      }
      pruneFiles(owner)
    }
  }
  return {
    release,
    retainForRetry: (scope: string): void => {
      const owner = files && currentFiles(files)
      if (!owner) {
        return
      }
      for (const path of paths) {
        if (
          owner.scope !== scope &&
          !nativeChatStagedFileHeld(owner, path) &&
          owner.paths.has(path)
        ) {
          adoptNativeChatStagedFile(owner, path, scope)
        }
      }
      const recovery = stagedNativeChatFiles(scope)
      if (recovery && !retryHold) {
        const retained = new Set(paths.filter((path) => recovery.paths.has(path)))
        recovery.heldInputs.add(retained)
        retryHold = { owner: recovery, paths: retained }
        reconcileNativeChatStagedDraft(scope, { ...(recovery.draft ?? { text: '', images: [] }) })
      }
    },
    releaseRetry: (): void => {
      if (retryHold) {
        const owner = currentFiles(retryHold.owner)
        owner.heldInputs.delete(retryHold.paths)
        retryHold = undefined
        pruneFiles(owner)
      }
    },
    /**
     * Release once the draft holds every submitted file: now, or at the first draft change that makes
     * it so (a returned original, or a live host upload of it). Until then the originals stay readable.
     */
    releaseWhenHeld: (): void => {
      const owner = files && currentFiles(files)
      if (
        !owner ||
        nativeChatStagedLeaseRetired(lease) ||
        [...lease].every((path) => nativeChatStagedFileHeld(owner, path))
      ) {
        release()
      } else {
        owner.pendingLeases.add(lease)
      }
    },
    /**
     * Staged originals this capture covers become their host uploads; nothing else changes. One whose
     * custody this send lost is refused whole (here, or at the issue through `custodyLost`); any other
     * unmapped reference is refused whole where the message leaves.
     */
    prepare: <T extends NativeChatStagedInput>(
      input: T,
      session: UploadSession
    ): Promise<T & { custodyLost?: () => readonly string[] }> =>
      uploadStagedInput(files, input, session, granted, custody),
    /** The staged originals this capture covers: what its preparation may map to host uploads. */
    paths: [...granted]
  }
}
