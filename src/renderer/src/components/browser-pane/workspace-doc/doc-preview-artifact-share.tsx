import type { ArtifactWriteRequest } from '../../../../../shared/artifacts'
import {
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../../shared/execution-host'
import type { DocPreviewGrantOwner } from '../../../../../preload/api/doc-preview-api'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import type { BrowserChromeShareControl } from '@/components/browser-pane/assemble-chrome/browser-chrome-toolbar'
import { isShareableHtmlPath } from '@/components/editor/editor-artifact-upload'
import type { DocPreviewGrantLocation } from '@/lib/doc-preview-grants'
import { fileArtifactSourceKey, type FileArtifactOwner } from '@/lib/file-artifact-source-key'
import { basename } from '@/lib/path'
import { readRuntimeFilePreview } from '@/runtime/runtime-file-read-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../../../../shared/cross-platform-path'
import type { RuntimeFilePreviewResult } from '../../../../../shared/runtime-types'
import {
  acquireTerminalArtifactGrant,
  pinTerminalArtifactGrantTarget,
  type TerminalArtifactGrantTarget
} from '@/runtime/runtime-terminal-artifact-grant'

/** The host a grant reads from, spelled as the editor's route for that host. */
export function docPreviewGrantFileOwner(owner: DocPreviewGrantOwner): FileArtifactOwner {
  return owner.kind === 'ssh'
    ? {
        executionHostId: getConnectionExecutionHostId(owner.connectionId),
        runtimeEnvironmentId: null
      }
    : {
        executionHostId: toRuntimeExecutionHostId(owner.environmentId),
        runtimeEnvironmentId: owner.environmentId
      }
}

async function readDocPreviewGrantFile(
  owner: DocPreviewGrantOwner,
  filePath: string
): Promise<RuntimeFilePreviewResult> {
  if (owner.kind === 'ssh') {
    // Why the connection id is kept: dropping it would read this path on this machine.
    const context = { target: { kind: 'local' as const }, worktreeId: null, worktreePath: null }
    return readRuntimeFilePreview({ ...context, connectionId: owner.connectionId }, filePath)
  }
  if (owner.fileAccess === 'terminal-artifact') {
    const target = { kind: 'environment' as const, environmentId: owner.environmentId }
    const context: TerminalArtifactGrantTarget = pinTerminalArtifactGrantTarget({
      target,
      worktreeId: owner.worktreeSelector,
      absolutePath: filePath
    })
    const grant = await acquireTerminalArtifactGrant(context)
    const samePath =
      grant &&
      (isWindowsAbsolutePathLike(filePath)
        ? normalizeRuntimePathForComparison(grant.absolutePath) ===
          normalizeRuntimePathForComparison(filePath)
        : grant.absolutePath === filePath)
    if (!grant || !samePath) {
      throw new Error('outside_grant_root')
    }
    return callRuntimeRpc<RuntimeFilePreviewResult>(
      target,
      'files.readTerminalArtifactPreview',
      {
        worktree: owner.worktreeSelector,
        grantId: grant.grantId,
        absolutePath: grant.absolutePath
      },
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: context.expectedEnvironmentPairingRevision
      }
    )
  }
  // The grant's own selector and root, which may be a chat's scratch folder rather than a workspace.
  const relativePath = relativePathInsideRoot(owner.worktreeRoot, filePath)
  if (!relativePath) {
    throw new Error('outside_grant_root')
  }
  return callRuntimeRpc<RuntimeFilePreviewResult>(
    { kind: 'environment', environmentId: owner.environmentId },
    'files.readPreview',
    { worktree: owner.worktreeSelector, relativePath },
    { timeoutMs: 15_000 }
  )
}

/** Reads the document from the host its grant was minted for, never the one selected now. */
export async function readDocPreviewArtifactRequest(
  location: DocPreviewGrantLocation,
  filePath: string,
  sourceKey: string
): Promise<ArtifactWriteRequest> {
  let result: RuntimeFilePreviewResult
  try {
    result = await readDocPreviewGrantFile(location.owner, filePath)
  } catch {
    throw new ArtifactPublishPreparationError('unreadable')
  }
  if (result.isBinary) {
    throw new ArtifactPublishPreparationError('binary')
  }
  return {
    sourceKey,
    content: result.content,
    contentType: 'text/html',
    fileName: basename(filePath)
  }
}

/** The toolbar's Share button for an HTML preview with a live grant; undefined for anything else. */
export function buildDocPreviewShareControl(
  filePath: string,
  location: DocPreviewGrantLocation | null
): ((control: BrowserChromeShareControl) => React.ReactNode) | undefined {
  if (!location || !isShareableHtmlPath(filePath)) {
    return undefined
  }
  const sourceKey = fileArtifactSourceKey(docPreviewGrantFileOwner(location.owner), filePath)
  return (control) => (
    <ArtifactPublishButton
      sourceKey={sourceKey}
      className="h-7 w-7"
      createRequest={() => readDocPreviewArtifactRequest(location, filePath, sourceKey)}
      {...control}
    />
  )
}
