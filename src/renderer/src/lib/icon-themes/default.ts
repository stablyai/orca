import { File, Folder, FolderOpen } from 'lucide-react'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import type { IconNode, IconTheme } from './types'

/**
 * Wraps the original `getFileTypeIcon` table as the `default` icon theme.
 * Existing per-filename / per-extension matches and behavior parity for SSH
 * worktrees are preserved verbatim — the resolver delegates to the legacy
 * function instead of re-encoding ~150 rules in this file.
 */
export const defaultIconTheme: IconTheme = {
  id: 'default',
  name: 'Default (Lucide)',
  description: 'The built-in lucide-react icon set Orca has shipped with since launch.',
  monochrome: true,
  defaultFileIcon: File as IconNode,
  defaultFolder: { closed: Folder as IconNode, open: FolderOpen as IconNode },
  fileRules: [],
  folderRules: [],
  resolveFileIcon: (filePath) => getFileTypeIcon(filePath) as IconNode
}
