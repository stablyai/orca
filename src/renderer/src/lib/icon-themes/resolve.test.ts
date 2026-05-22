import { describe, expect, it } from 'vitest'
import { File, Folder, FolderOpen } from 'lucide-react'
import { resolveIcon } from './resolve'
import type { IconNode, IconTheme } from './types'

const ExtIcon: IconNode = () => null
const FilenameIcon: IconNode = () => null
const PatternIcon: IconNode = () => null
const FallbackIcon: IconNode = () => null
const FolderClosed: IconNode = () => null
const FolderOpenWrap: IconNode = () => null
const NodeModulesIcon: IconNode = () => null

const theme: IconTheme = {
  id: 'test',
  name: 'Test Theme',
  monochrome: true,
  defaultFileIcon: FallbackIcon,
  defaultFolder: { closed: FolderClosed, open: FolderOpenWrap },
  fileRules: [
    { filename: 'package.json', icon: FilenameIcon },
    { pattern: /^\.env(\..+)?$/, icon: PatternIcon },
    { extension: 'tsx', icon: ExtIcon }
  ],
  folderRules: [{ name: 'node_modules', closed: NodeModulesIcon }]
}

describe('resolveIcon', () => {
  it('resolves filename match (case-insensitive)', () => {
    expect(resolveIcon(theme, '/x/y/Package.json', false, false)).toBe(FilenameIcon)
    expect(resolveIcon(theme, '/x/y/package.json', false, false)).toBe(FilenameIcon)
  })

  it('resolves pattern match', () => {
    expect(resolveIcon(theme, '/x/.env', false, false)).toBe(PatternIcon)
    expect(resolveIcon(theme, '/x/.env.local', false, false)).toBe(PatternIcon)
  })

  it('resolves extension match', () => {
    expect(resolveIcon(theme, '/x/Foo.tsx', false, false)).toBe(ExtIcon)
  })

  it('returns fallback when nothing matches', () => {
    expect(resolveIcon(theme, '/x/random.unknown', false, false)).toBe(FallbackIcon)
  })

  it('resolves folder rules', () => {
    expect(resolveIcon(theme, '/x/node_modules', true, false)).toBe(NodeModulesIcon)
  })

  it('returns folder fallback open/closed', () => {
    expect(resolveIcon(theme, '/x/src', true, false)).toBe(FolderClosed)
    expect(resolveIcon(theme, '/x/src', true, true)).toBe(FolderOpenWrap)
  })

  it('folder rule open falls back to closed when open is undefined', () => {
    expect(resolveIcon(theme, '/x/node_modules', true, true)).toBe(NodeModulesIcon)
  })

  it('honors `resolveFileIcon` escape hatch when present', () => {
    const escaped: IconTheme = {
      ...theme,
      resolveFileIcon: (p) => (p.endsWith('.escaped') ? FallbackIcon : null)
    }
    expect(resolveIcon(escaped, '/x/y.escaped', false, false)).toBe(FallbackIcon)
    expect(resolveIcon(escaped, '/x/y.tsx', false, false)).toBe(ExtIcon)
  })

  it('handles compound extensions (tar.gz)', () => {
    const t: IconTheme = {
      ...theme,
      fileRules: [{ extension: 'tar.gz', icon: ExtIcon }]
    }
    expect(resolveIcon(t, '/x/archive.tar.gz', false, false)).toBe(ExtIcon)
  })

  it('lucide components are assignable to IconNode (compile-time guard)', () => {
    const lucideTheme: IconTheme = {
      id: 'lucide',
      name: 'Lucide',
      monochrome: true,
      defaultFileIcon: File as IconNode,
      defaultFolder: { closed: Folder as IconNode, open: FolderOpen as IconNode },
      fileRules: [],
      folderRules: []
    }
    expect(resolveIcon(lucideTheme, '/x/y.txt', false, false)).toBe(File)
  })
})
