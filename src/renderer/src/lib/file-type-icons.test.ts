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
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo
} from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { getFileTypeIcon } from './file-type-icons'
import { getPluginFileTypeIconImage } from './file-type-icons'

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
    expect(getFileTypeIcon('README.md')).toBe(FileText)
    expect(getFileTypeIcon('assets/logo.png')).toBe(FileImage)
    expect(getFileTypeIcon('notes.patch')).toBe(FileDiff)
  })

  it('uses more specific icons for data, security, and presentation files', () => {
    expect(getFileTypeIcon('db/schema.sql')).toBe(Database)
    expect(getFileTypeIcon('reports/summary.xlsx')).toBe(FileSpreadsheet)
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

  it('resolves plugin file-name and extension mappings before the generic plugin icon', () => {
    const theme = {
      id: 'plugin:acme.icons/main' as const,
      pluginKey: 'acme.icons',
      label: 'Acme',
      icons: {
        file: { dataUrl: 'data:image/svg+xml;base64,ZmlsZQ==', rendering: 'image' as const }
      },
      fileNames: {
        'readme.md': {
          dataUrl: 'data:image/svg+xml;base64,cmVhZG1l',
          rendering: 'image' as const
        }
      },
      fileExtensions: {
        ts: { dataUrl: 'data:image/svg+xml;base64,dHM=', rendering: 'image' as const }
      }
    }

    expect(getPluginFileTypeIconImage(theme, '/repo/README.md')?.dataUrl).toContain('cmVhZG1l')
    expect(getPluginFileTypeIconImage(theme, 'src/index.ts')?.dataUrl).toContain('dHM=')
    expect(getPluginFileTypeIconImage(theme, 'unknown.bin')?.dataUrl).toContain('ZmlsZQ==')
  })

  it('rejects unexpected plugin icon URLs and preserves built-in fallback', () => {
    expect(
      getPluginFileTypeIconImage(
        {
          id: 'plugin:acme.icons/main',
          pluginKey: 'acme.icons',
          label: 'Acme',
          icons: {
            file: { dataUrl: 'https://example.com/icon.svg', rendering: 'image' }
          },
          fileNames: {},
          fileExtensions: {}
        },
        'unknown.bin'
      )
    ).toBeNull()
  })
})
