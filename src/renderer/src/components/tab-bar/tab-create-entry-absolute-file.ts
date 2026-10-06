import { detectLanguage } from '@/lib/language-detect'
import { toWorktreeRelativePath } from '@/lib/terminal-links'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import type { OpenFile } from '@/store/slices/editor'
import {
  validateNewTabEntryAbsolutePath,
  type TabEntryLocalPlatform
} from './tab-create-entry-path-validation'
import type { statUserOpenedPath, UserOpenedPathStat } from '@/lib/user-opened-local-path'

type AbsoluteFileOperations = {
  assertAbsolutePathAllowed: () => void
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; targetGroupId?: string }
  ) => void
  statUserOpenedPath: typeof statUserOpenedPath
}

export async function openAbsoluteTabEntryFile(args: {
  context: RuntimeFileOperationArgs
  groupId: string
  operations: AbsoluteFileOperations
  filePath: string
  localPlatform: TabEntryLocalPlatform
  worktreeId: string
  worktreePath: string
}): Promise<void> {
  const filePath = validateNewTabEntryAbsolutePath(args.filePath, args.localPlatform)
  args.operations.assertAbsolutePathAllowed()
  let stat: UserOpenedPathStat
  try {
    stat = await args.operations.statUserOpenedPath(args.context, filePath)
  } catch {
    throw new Error(`File not found: ${filePath}`)
  }
  if (stat.isDirectory) {
    throw new Error(`Cannot open a directory: ${filePath}`)
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
