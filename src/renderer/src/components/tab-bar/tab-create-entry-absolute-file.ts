import { detectLanguage } from '@/lib/language-detect'
import { toWorktreeRelativePath } from '@/lib/terminal-links'
import type { RuntimeFileOperationArgs, statRuntimePath } from '@/runtime/runtime-file-client'
import type { OpenFile } from '@/store/slices/editor'
import {
  validateNewTabEntryAbsolutePath,
  type TabEntryLocalPlatform
} from './tab-create-entry-path-validation'

type AbsoluteFileOperations = {
  assertAbsolutePathAllowed: () => void
  authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
  openFile: (
    file: Omit<OpenFile, 'id' | 'isDirty'>,
    options?: { preview?: boolean; targetGroupId?: string }
  ) => void
  statRuntimePath: typeof statRuntimePath
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
  await args.operations.authorizeExternalPath({ targetPath: filePath })
  args.operations.assertAbsolutePathAllowed()
  let stat: Awaited<ReturnType<typeof statRuntimePath>>
  try {
    stat = await args.operations.statRuntimePath(args.context, filePath)
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
      relativePath: toWorktreeRelativePath(filePath, args.worktreePath) || filePath,
      worktreeId: args.worktreeId,
      language: detectLanguage(filePath),
      mode: 'edit'
    },
    { preview: false, targetGroupId: args.groupId }
  )
}
