import { releaseFiles, type StagedFiles } from './native-chat-staged-file-owner'
import { isNativeChatPendingAttachmentSource } from './native-chat-pending-attachment-cache'

export type NativeChatStagedTransfer = Pick<
  StagedFiles,
  'paths' | 'resources' | 'pending' | 'heldInputs' | 'leases'
>

export function transferNativeChatStagedFiles(files: StagedFiles, destination?: StagedFiles) {
  const incoming: NativeChatStagedTransfer = {
    paths: files.paths,
    resources: files.resources,
    pending: files.pending,
    heldInputs: files.heldInputs,
    leases: files.leases
  }
  const owner = destination ?? files
  if (destination) {
    for (const path of files.paths) {
      destination.paths.add(path)
    }
    for (const [path, resource] of files.resources) {
      if (!destination.resources.has(path)) {
        destination.resources.set(path, resource)
      }
    }
    files.pending.forEach((path, chip) => destination.pending.set(chip, path))
    files.heldInputs.forEach((held) => destination.heldInputs.add(held))
    files.leases.forEach((lease) => destination.leases.add(lease))
    for (const [target, uploads] of files.uploads) {
      const held = destination.uploads.get(target)
      if (held) {
        uploads.forEach((upload, path) => held.set(path, upload))
      } else {
        destination.uploads.set(target, uploads)
      }
    }
    files.movedTo = destination
    files.paths = new Set()
    files.resources = new Map()
    files.pending = new Map()
    files.draftPaths = new Set()
    files.heldInputs = new Set()
    files.leases = new Set()
    files.uploads = new Map()
    files.draft = undefined
    files.referenceText = undefined
    files.textReferences = new Set()
    files.draftReferences = new Set()
  }
  return { owner, incoming }
}

export function reconcileIncomingNativeChatStagedFiles(
  files: StagedFiles,
  incoming: NativeChatStagedTransfer
): void {
  const retained = new Set<string>()
  for (const [chip, path] of incoming.pending) {
    if (isNativeChatPendingAttachmentSource(files.scope, chip)) {
      retained.add(path)
    } else if (files.pending.get(chip) === path) {
      files.pending.delete(chip)
    }
  }
  for (const membership of [...incoming.heldInputs, ...incoming.leases]) {
    for (const path of membership) {
      retained.add(path)
    }
  }
  const released: string[] = []
  for (const path of incoming.paths) {
    if (files.resources.get(path) !== incoming.resources.get(path)) {
      continue
    }
    if (files.draftReferences.has(path)) {
      files.draftPaths.add(path)
    } else {
      files.draftPaths.delete(path)
      if (!retained.has(path)) {
        released.push(path)
      }
    }
  }
  releaseFiles(files, released)
}
