import type { NativeChatDraftReturnSource } from './native-chat-draft-return-products'
import {
  currentFiles,
  pendingResources,
  pruneFiles,
  reconcileNativeChatStagedDraft,
  type NativeChatStagedRemoval,
  type StagedFiles
} from './native-chat-draft-attachment-staging'

/** Resolve grants by their actual owner before any selected record is cleared. */
export function collectNativeChatStagedRemovals(
  captures: readonly { captured: NativeChatStagedRemoval; selected: boolean }[],
  sources: Iterable<NativeChatDraftReturnSource>
) {
  const owners = new Map<StagedFiles, NativeChatStagedRemoval>()
  const include = (files: StagedFiles) => {
    files = currentFiles(files)
    let selection = owners.get(files)
    if (!selection) {
      selection = {
        files,
        resources: new Map(),
        heldInputs: new Set(),
        chips: [],
        deferPrune: true
      }
      owners.set(files, selection)
    }
    return selection
  }
  for (const { captured, selected } of captures) {
    if (!captured.files) {
      continue
    }
    const target = include(captured.files)
    captured.resources.forEach((resource, path) => target.resources.set(path, resource))
    if (selected) {
      captured.heldInputs.forEach((held) => target.heldInputs.add(held))
    }
  }
  for (const source of sources) {
    for (const [path, grant] of pendingResources.get(source) ?? []) {
      include(grant.files).resources.set(path, grant.resource)
    }
  }
  for (const [files, selection] of owners) {
    selection.heldInputs.forEach((held) => files.heldInputs.delete(held))
  }
  return {
    byScope: new Map([...owners].map(([files, selection]) => [files.scope, selection])),
    finish: () => {
      for (const [files, selection] of owners) {
        reconcileNativeChatStagedDraft(files.scope, files.draft, selection)
        pruneFiles(files, selection.resources)
      }
    }
  }
}
