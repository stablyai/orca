import {
  Database,
  File,
  FileArchive,
  FileBox,
  FileChartColumn,
  FileCode,
  FileCog,
  FileDiff,
  FileImage,
  FileJson,
  FileKey,
  FileLock,
  FileMusic,
  FileSliders,
  FileText,
  FileType,
  FileVideo
} from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { getFileTypeIcon } from './file-type-icons'
import {
  FileCsv,
  FileExcel,
  FileMarkdown,
  FileNotebook,
  FilePdf,
  FileWord
} from './document-file-icons'

describe('getFileTypeIcon', () => {
  it('prefers known filenames over generic extensions', () => {
    expect(getFileTypeIcon('package.json')).toBe(FileBox)
    expect(getFileTypeIcon('/repo/tsconfig.json')).toBe(FileSliders)
    expect(getFileTypeIcon('C:\\repo\\.env.local')).toBe(FileLock)
    expect(getFileTypeIcon('README')).toBe(FileText)
    expect(getFileTypeIcon('Dockerfile.dev')).toBe(FileCog)
  })

  it('matches common code, config, document, and media extensions', () => {
    expect(getFileTypeIcon('src/App.tsx')).toBe(FileCode)
    expect(getFileTypeIcon('config/settings.jsonc')).toBe(FileJson)
    expect(getFileTypeIcon('styles/app.css')).toBe(FileType)
    expect(getFileTypeIcon('README.md')).toBe(FileMarkdown)
    expect(getFileTypeIcon('assets/logo.png')).toBe(FileImage)
    expect(getFileTypeIcon('notes.patch')).toBe(FileDiff)
  })

  it('uses more specific icons for data, security, and presentation files', () => {
    expect(getFileTypeIcon('db/schema.sql')).toBe(Database)
    expect(getFileTypeIcon('reports/summary.xlsx')).toBe(FileExcel)
    expect(getFileTypeIcon('certs/server.pem')).toBe(FileKey)
    expect(getFileTypeIcon('slides/status.pptx')).toBe(FileChartColumn)
  })

  it('handles compound archive extensions before their trailing extension', () => {
    expect(getFileTypeIcon('release.tar.gz')).toBe(FileArchive)
  })

  it('matches audio and video extensions', () => {
    expect(getFileTypeIcon('sound/theme.mp3')).toBe(FileMusic)
    expect(getFileTypeIcon('demo.mov')).toBe(FileVideo)
  })

  it('falls back to the generic file icon for unknown files', () => {
    expect(getFileTypeIcon('unknown.customtype')).toBe(File)
  })

  it.each([
    ['C:\\Data\\ANALYSIS.IPYNB', FileNotebook],
    ['macros.xlsm', FileExcel],
    ['data.csv', FileCsv],
    ['/remote/data/DATA.TSV', FileCsv],
    ['C:\\Reports\\REPORT.PDF', FilePdf],
    ['/remote/docs/proposal.docx', FileWord],
    ['legacy.DOC', FileWord],
    ['notes.MARKDOWN', FileMarkdown],
    ['article.mdx', FileMarkdown],
    ['AGENTS.md', FileMarkdown],
    ['SECURITY.md', FileLock]
  ])('recognizes %s while preserving special filename semantics', (path, icon) => {
    expect(getFileTypeIcon(path)).toBe(icon)
  })

  it('keeps document formats visually distinct from plain text', () => {
    expect(
      new Set(
        [
          'report.pdf',
          'report.docx',
          'report.md',
          'report.txt',
          'analysis.ipynb',
          'budget.xlsx',
          'data.csv'
        ].map(getFileTypeIcon)
      ).size
    ).toBe(7)
  })
})
