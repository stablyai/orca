import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeTerminalPathResolution } from '../../../../../shared/terminal/runtime-terminal-file-path'
import {
  getTabEntryCannotOpenDirectoryMessage,
  getTabEntryFileNotFoundMessage
} from './tab-create-entry-copy'
import { toWorktreeRelativePath } from '../../../../../shared/terminal/links/terminal-links'
import { getRelativePathInsideRoot } from '@/lib/path'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import type { hostSavesGrantedFiles } from '@/runtime/files/grants/runtime-terminal-artifact-grant'
import type { hostAbsentRefusal } from '@/components/terminal-pane/host-files/host-file-refusal'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import {
  validateNewTabEntryAbsolutePath,
  type TabEntryLocalPlatform
} from './tab-create-entry-path-validation'
import type {
  statUserOpenedPath,
  UserOpenedPathStat
} from '@/lib/files/access/user-opened-local-path'

type AbsoluteFileOperations = {
  assertAbsolutePathAllowed: () => void
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; targetGroupId?: string }
  ) => void
  statUserOpenedPath: typeof statUserOpenedPath
  resolveTerminalPath: (
    target: RuntimeClientTarget & { kind: 'environment' },
    params: { worktree: string; pathText: string }
  ) => Promise<RuntimeTerminalPathResolution>
  hostSavesGrantedFiles: typeof hostSavesGrantedFiles
  hostAbsentRefusal: typeof hostAbsentRefusal
}

export async function openAbsoluteTabEntryFile(args: {
  assertCurrent?: () => void
  context: RuntimeFileOperationArgs
  groupId: string
  operations: AbsoluteFileOperations
  filePath: string
  localPlatform?: TabEntryLocalPlatform
  worktreeId: string
  worktreePath: string
}): Promise<void> {
  const filePath = validateNewTabEntryAbsolutePath(args.filePath, args.localPlatform)
  args.operations.assertAbsolutePathAllowed()

  if (args.context.target.kind === 'environment') {
    const target = args.context.target
    const resolved = await args.operations.resolveTerminalPath(target, {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      pathText: filePath
    })
    args.assertCurrent?.()
    args.operations.assertAbsolutePathAllowed()

    if (resolved.openTarget?.kind === 'absolute-file') {
      const grantReadOnly =
        resolved.openTarget.readOnly === true ||
        !(await args.operations.hostSavesGrantedFiles(target.environmentId))
      args.assertCurrent?.()
      args.operations.assertAbsolutePathAllowed()
      args.operations.openFile(
        {
          filePath: resolved.openTarget.absolutePath,
          relativePath: resolved.openTarget.absolutePath,
          worktreeId: args.worktreeId,
          runtimeEnvironmentId: target.environmentId,
          terminalArtifactGrantId: resolved.openTarget.grantId,
          ...(grantReadOnly ? { readOnly: true } : {}),
          language: detectLanguage(resolved.openTarget.absolutePath),
          mode: 'edit'
        },
        { preview: false, targetGroupId: args.groupId }
      )
      return
    }
    if (
      !resolved.exists &&
      getRelativePathInsideRoot(resolved.absolutePath ?? filePath, args.worktreePath) === null
    ) {
      throw await args.operations.hostAbsentRefusal(
        target.environmentId,
        resolved.absolutePath ?? filePath
      )
    }
    if (resolved.exists && resolved.isDirectory) {
      throw new Error(getTabEntryCannotOpenDirectoryMessage(filePath))
    }
    if (resolved.openTarget?.kind === 'unsupported') {
      throw new Error(resolved.openTarget.reason)
    }
    if (!resolved.exists || !resolved.absolutePath || resolved.relativePath === null) {
      throw new Error(getTabEntryFileNotFoundMessage(filePath))
    }
    args.operations.openFile(
      {
        filePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        worktreeId: args.worktreeId,
        runtimeEnvironmentId: target.environmentId,
        language: detectLanguage(resolved.absolutePath),
        mode: 'edit'
      },
      { preview: false, targetGroupId: args.groupId }
    )
    return
  }

  let stat: UserOpenedPathStat
  try {
    stat = await args.operations.statUserOpenedPath(args.context, filePath)
  } catch {
    throw new Error(getTabEntryFileNotFoundMessage(filePath))
  }
  args.assertCurrent?.()
  if (stat.isDirectory) {
    throw new Error(getTabEntryCannotOpenDirectoryMessage(filePath))
  }
  args.operations.assertAbsolutePathAllowed()

  args.operations.openFile(
    {
      filePath,
      // Why: a project link out of the project keeps its absolute path, so it reads as user-named.
      relativePath: stat.escapesWorktree
        ? filePath
        : toWorktreeRelativePath(filePath, args.worktreePath) || filePath,
      worktreeId: args.worktreeId,
      language: detectLanguage(filePath),
      mode: 'edit'
    },
    { preview: false, targetGroupId: args.groupId }
  )
}
