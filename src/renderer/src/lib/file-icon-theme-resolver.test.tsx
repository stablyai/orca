import { FileCode, FileJson, Folder, FolderOpen } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { resolveFileIconTheme } from './file-icon-theme-resolver'

describe('resolveFileIconTheme', () => {
  it('preserves Lucide file and folder icons for the default Orca theme', () => {
    expect(resolveFileIconTheme({ themeId: 'orca', path: 'src/App.tsx' })).toMatchObject({
      Icon: FileCode,
      themed: false
    })
    expect(
      resolveFileIconTheme({ themeId: 'orca', path: 'src', isDirectory: true, isExpanded: false })
    ).toMatchObject({ Icon: Folder, themed: false })
    expect(
      resolveFileIconTheme({ themeId: 'orca', path: 'src', isDirectory: true, isExpanded: true })
    ).toMatchObject({ Icon: FolderOpen, themed: false })
  })

  it('normalizes invalid themes to the default Orca icon behavior', () => {
    expect(
      resolveFileIconTheme({ themeId: 'not-real' as never, path: 'data/config.json' })
    ).toMatchObject({ Icon: FileJson, themed: false })
  })

  it('uses colored themed icons for filename, extension, compound extension, and folders', () => {
    const packageIcon = resolveFileIconTheme({ themeId: 'orca-color', path: 'package.json' })
    const typescriptIcon = resolveFileIconTheme({ themeId: 'orca-color', path: 'src/App.tsx' })
    const archiveIcon = resolveFileIconTheme({ themeId: 'orca-color', path: 'release.tar.gz' })
    const sourceFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'src',
      isDirectory: true,
      isExpanded: false
    })
    const docsFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'docs',
      isDirectory: true,
      isExpanded: false
    })
    const closedFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'ordinary-folder',
      isDirectory: true,
      isExpanded: false
    })
    const openFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'ordinary-folder',
      isDirectory: true,
      isExpanded: true
    })

    expect(packageIcon.themed).toBe(true)
    expect(typescriptIcon.themed).toBe(true)
    expect(archiveIcon.themed).toBe(true)
    expect(sourceFolderIcon.themed).toBe(true)
    expect(docsFolderIcon.themed).toBe(true)
    expect(closedFolderIcon.themed).toBe(true)
    expect(openFolderIcon.themed).toBe(true)
    expect(sourceFolderIcon.Icon).not.toBe(docsFolderIcon.Icon)
    expect(sourceFolderIcon.Icon).not.toBe(closedFolderIcon.Icon)
    expect(closedFolderIcon.Icon).not.toBe(openFolderIcon.Icon)
  })

  it('resolves themed icons from Windows-style paths', () => {
    expect(
      resolveFileIconTheme({ themeId: 'orca-color', path: 'src\\components\\Button.tsx' })
    ).toMatchObject({ themed: true })
  })

  it('uses folder-name icons for nested folders on POSIX and Windows paths', () => {
    const nestedSharedFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'src/shared',
      isDirectory: true,
      isExpanded: false
    })
    const nestedWindowsSharedFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'src\\shared',
      isDirectory: true,
      isExpanded: false
    })
    const nestedOpenSharedFolderIcon = resolveFileIconTheme({
      themeId: 'orca-color',
      path: 'docs/src/shared',
      isDirectory: true,
      isExpanded: true
    })

    expect(nestedSharedFolderIcon.themed).toBe(true)
    expect(nestedWindowsSharedFolderIcon.Icon).toBe(nestedSharedFolderIcon.Icon)
    expect(nestedOpenSharedFolderIcon.Icon).not.toBe(nestedSharedFolderIcon.Icon)
  })
})
