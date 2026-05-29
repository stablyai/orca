import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MASSCODE_SCAN_LIMITS,
  fetchMassCodeData,
  getMassCodeSnippetFilePath,
  normalizeMassCodePreviewLines
} from './masscode-manager'

type DirEntry = { name: string; isDirectory: boolean; isSymlink?: boolean }

const directoryEntries = new Map<string, DirEntry[]>()
const fileContents = new Map<string, string>()
let readDirErrorPath: string | null = null

function setDir(path: string, entries: DirEntry[]): void {
  directoryEntries.set(path, entries)
}

function setFile(path: string, content: string): void {
  fileContents.set(path, content)
}

function installFsMocks(): void {
  vi.stubGlobal('window', {
    api: {
      fs: {
        readDir: vi.fn(async ({ dirPath }: { dirPath: string }) => {
          if (dirPath === readDirErrorPath) {
            throw new Error('Access denied')
          }
          return directoryEntries.get(dirPath) ?? []
        }),
        stat: vi.fn(async ({ filePath }: { filePath: string }) => ({
          size: fileContents.get(filePath)?.length ?? 0,
          isDirectory: directoryEntries.has(filePath),
          mtime: 1
        })),
        readFile: vi.fn(async ({ filePath }: { filePath: string }) => ({
          content: fileContents.get(filePath) ?? ''
        })),
        writeFile: vi.fn()
      }
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  directoryEntries.clear()
  fileContents.clear()
  readDirErrorPath = null
})

describe('masscode manager', () => {
  it('keeps folder assignments from notes trees and reads favorite booleans from string frontmatter', async () => {
    setDir('/vault', [{ name: 'notes', isDirectory: true }])
    setDir('/vault/notes', [{ name: 'BibleScroll', isDirectory: true }])
    setDir('/vault/notes/BibleScroll', [{ name: 'u-version-app-key.md', isDirectory: false }])
    setFile(
      '/vault/notes/BibleScroll/u-version-app-key.md',
      ['---', 'name: U version app key', 'isFavorite: true', '---', 'snippet body'].join('\n')
    )
    installFsMocks()

    const data = await fetchMassCodeData('/vault')
    const snippet = data.snippets[0]

    expect(data.folders.map((folder) => folder.name)).toEqual(['BibleScroll'])
    expect(data.folders[0].parentId).toBeNull()
    expect(snippet.folderId).toBe('/vault/notes/BibleScroll')
    expect(snippet.isFavorite).toBe(true)
    expect(snippet.type).toBe(2)
    expect(data.truncated).toBe(false)
  })

  it('derives math and tools snippet types from vault root folders', async () => {
    setDir('/vault', [
      { name: 'math', isDirectory: true },
      { name: 'tools', isDirectory: true }
    ])
    setDir('/vault/math', [{ name: 'formula.md', isDirectory: false }])
    setDir('/vault/tools', [{ name: 'curl.md', isDirectory: false }])
    setFile('/vault/math/formula.md', ['---', 'name: Formula', '---', 'x = 1'].join('\n'))
    setFile('/vault/tools/curl.md', ['---', 'name: Curl', '---', 'curl example'].join('\n'))
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.snippets.map((snippet) => snippet.type).sort()).toEqual([4, 5])
  })

  it('treats numeric-string favorites as true for code snippets', async () => {
    setDir('/vault', [{ name: 'code', isDirectory: true }])
    setDir('/vault/code', [{ name: 'skills', isDirectory: true }])
    setDir('/vault/code/skills', [{ name: 'xc-docs.md', isDirectory: false }])
    setFile(
      '/vault/code/skills/xc-docs.md',
      ['---', 'name: xc docs.md', 'isFavorites: 1', '---', '<p>html</p>'].join('\n')
    )
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.snippets).toHaveLength(1)
    expect(data.snippets[0].isFavorite).toBe(true)
    expect(data.snippets[0].type).toBe(1)
  })

  it('keeps filesystem folder placement even when frontmatter folderId is null', async () => {
    setDir('/vault', [{ name: 'notes', isDirectory: true }])
    setDir('/vault/notes', [{ name: 'United folder one', isDirectory: true }])
    setDir('/vault/notes/United folder one', [{ name: 'untitled-no1.md', isDirectory: false }])
    setFile(
      '/vault/notes/United folder one/untitled-no1.md',
      ['---', 'name: Untitled no1', 'folderId: null', '---', 'body'].join('\n')
    )
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.snippets).toHaveLength(1)
    expect(data.snippets[0].folderId).toBe('/vault/notes/United folder one')
  })

  it('marks inbox and trash snippets without exposing system folders', async () => {
    setDir('/vault', [{ name: 'code', isDirectory: true }])
    setDir('/vault/code', [
      { name: '.masscode', isDirectory: true },
      { name: 'trash', isDirectory: true }
    ])
    setDir('/vault/code/.masscode', [{ name: 'inbox', isDirectory: true }])
    setDir('/vault/code/.masscode/inbox', [{ name: 'draft.md', isDirectory: false }])
    setDir('/vault/code/trash', [{ name: 'old.md', isDirectory: false }])
    setFile(
      '/vault/code/.masscode/inbox/draft.md',
      ['---', 'name: Draft', '---', 'body'].join('\n')
    )
    setFile('/vault/code/trash/old.md', ['---', 'name: Old', '---', 'body'].join('\n'))
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.folders).toEqual([])
    expect(data.snippets.find((snippet) => snippet.name === 'Draft')?.inInbox).toBe(true)
    expect(data.snippets.find((snippet) => snippet.name === 'Old')?.isTrash).toBe(true)
  })

  it('normalizes Windows-style vault paths while deriving types and folders', async () => {
    setDir('C:\\vault', [{ name: 'notes', isDirectory: true }])
    setDir('C:\\vault\\notes', [{ name: 'Team', isDirectory: true }])
    setDir('C:\\vault\\notes\\Team', [{ name: 'plan.md', isDirectory: false }])
    setFile('C:\\vault\\notes\\Team\\plan.md', ['---', 'name: Plan', '---', 'body'].join('\n'))
    installFsMocks()

    const data = await fetchMassCodeData('C:\\vault')

    expect(data.snippets[0].type).toBe(2)
    expect(data.snippets[0].folderId).toBe('C:\\vault\\notes\\Team')
  })

  it('bounds large vault scans and skips symlinked folders', async () => {
    const files = Array.from({ length: MASSCODE_SCAN_LIMITS.maxSnippets + 1 }, (_, index) => ({
      name: `snippet-${index}.md`,
      isDirectory: false
    }))
    setDir('/vault', [{ name: 'code', isDirectory: true }])
    setDir('/vault/code', [{ name: 'linked', isDirectory: true, isSymlink: true }, ...files])
    for (const file of files) {
      setFile(`/vault/code/${file.name}`, ['---', `name: ${file.name}`, '---', 'body'].join('\n'))
    }
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.snippets).toHaveLength(MASSCODE_SCAN_LIMITS.maxSnippets)
    expect(data.truncated).toBe(true)
    expect(data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('symlinked folder'),
        expect.stringContaining('snippet limit')
      ])
    )
  })

  it('skips oversized snippets before reading their content', async () => {
    setDir('/vault', [{ name: 'code', isDirectory: true }])
    setDir('/vault/code', [{ name: 'huge.md', isDirectory: false }])
    setFile('/vault/code/huge.md', 'x'.repeat(MASSCODE_SCAN_LIMITS.maxSnippetBytes + 1))
    installFsMocks()

    const data = await fetchMassCodeData('/vault')

    expect(data.snippets).toEqual([])
    expect(data.warnings).toEqual([expect.stringContaining('large snippet')])
  })

  it('propagates root authorization errors', async () => {
    readDirErrorPath = '/vault'
    installFsMocks()

    await expect(fetchMassCodeData('/vault')).rejects.toThrow('Access denied')
  })

  it('sanitizes new snippet paths and keeps them under the selected type folder', () => {
    expect(
      getMassCodeSnippetFilePath({
        vaultPath: '/vault',
        selectedFolderId: null,
        selectedType: 1,
        snippetName: '../secret/name'
      })
    ).toBe('/vault/code/-secret-name.md')
    expect(
      getMassCodeSnippetFilePath({
        vaultPath: 'C:\\vault',
        selectedFolderId: 'C:\\vault\\notes\\Team',
        selectedType: 2,
        snippetName: 'Plan'
      })
    ).toBe('C:\\vault\\notes\\Team\\Plan.md')
    expect(
      getMassCodeSnippetFilePath({
        vaultPath: '/vault',
        selectedFolderId: '/tmp/outside',
        selectedType: 2,
        snippetName: 'Plan'
      })
    ).toBe('/vault/notes/Plan.md')
  })

  it('clamps preview lines to the supported settings values', () => {
    expect(normalizeMassCodePreviewLines(0)).toBe(0)
    expect(normalizeMassCodePreviewLines(1)).toBe(1)
    expect(normalizeMassCodePreviewLines(2)).toBe(2)
    expect(normalizeMassCodePreviewLines(99)).toBe(1)
  })
})
