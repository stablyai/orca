import {
  Database,
  FileArchive,
  FileAxis3D,
  FileBox,
  FileBraces,
  FileChartColumn,
  FileCode,
  FileDiff,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileMusic,
  FileSpreadsheet,
  FileTerminal,
  FileType,
  FileVideo,
  type LucideIcon
} from 'lucide-react'
import {
  FileCsv,
  FileExcel,
  FileMarkdown,
  FileNotebook,
  FilePdf,
  FileWord
} from './document-file-icons'

export type FileIconColor = 'red' | 'blue' | 'green' | 'orange' | 'violet' | 'cyan'

const colors = new Map<LucideIcon, FileIconColor>([
  [FilePdf, 'red'],
  [FileWord, 'blue'],
  [FileMarkdown, 'blue'],
  [FileExcel, 'green'],
  [FileCsv, 'green'],
  [FileSpreadsheet, 'green'],
  [FileNotebook, 'orange'],
  [FileChartColumn, 'orange'],
  [FileArchive, 'orange'],
  [FileBox, 'orange'],
  [FileKey, 'orange'],
  [FileLock, 'orange'],
  [FileCode, 'blue'],
  [FileBraces, 'blue'],
  [FileJson, 'orange'],
  [FileType, 'violet'],
  [FileTerminal, 'green'],
  [FileDiff, 'green'],
  [FileImage, 'violet'],
  [FileMusic, 'violet'],
  [FileVideo, 'violet'],
  [FileAxis3D, 'cyan'],
  [Database, 'cyan']
])

export function getFileTypeIconColor(icon: LucideIcon): FileIconColor | undefined {
  return colors.get(icon)
}
