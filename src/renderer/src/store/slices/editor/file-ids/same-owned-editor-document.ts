// Which open records show the same document as a closing one, so its close takes them too.

import type { OpenFile } from '../types/open-file'
import { isSameEditorOwner } from './editor-file-ids'

function isSameDocumentOwner(candidate: OpenFile, closedFile: OpenFile): boolean {
  const expectedRoute = closedFile.operationProvenance?.generation.route
  const actualRoute = candidate.operationProvenance?.generation.route
  return (
    isSameEditorOwner(candidate, closedFile.worktreeId, closedFile.runtimeEnvironmentId) &&
    candidate.filePath === closedFile.filePath &&
    candidate.externalSshTargetId === closedFile.externalSshTargetId &&
    actualRoute?.executionHostId === expectedRoute?.executionHostId &&
    actualRoute?.runtimeEnvironmentId === expectedRoute?.runtimeEnvironmentId
  )
}

/** A record of the same document under the same owner and connection generations. */
export function isSameOwnedDocument(candidate: OpenFile, closedFile: OpenFile): boolean {
  const expected = closedFile.operationProvenance
  const actual = candidate.operationProvenance
  const expectedGeneration = expected?.generation
  const actualGeneration = actual?.generation
  return (
    isSameDocumentOwner(candidate, closedFile) &&
    !closedFile.externalSshTargetId &&
    !candidate.externalSshTargetId &&
    actual?.ownershipProjection === expected?.ownershipProjection &&
    actual?.expectedSshConnectionGeneration === expected?.expectedSshConnectionGeneration &&
    actualGeneration?.runtimeConnectionGeneration ===
      expectedGeneration?.runtimeConnectionGeneration &&
    actualGeneration?.runtimePairingRevision === expectedGeneration?.runtimePairingRevision &&
    actualGeneration?.runtimeSshGeneration === expectedGeneration?.runtimeSshGeneration &&
    actualGeneration?.nestedSshGeneration === expectedGeneration?.nestedSshGeneration &&
    actualGeneration?.directSshGeneration === expectedGeneration?.directSshGeneration
  )
}
