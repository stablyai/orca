import { describe, expect, it, vi } from 'vitest'
import {
  buildImportHoverCommandUri,
  OPEN_IMPORT_TARGET_COMMAND_ID,
  provideImportLinkHover,
  registerImportHoverContext,
  unregisterImportHoverContext
} from './monaco-import-hover-link'
import { getImportSpecifierLinks } from './import-specifier-links'
import type { ResolvedImportLinkTarget } from './import-link-target-resolution'

const MODEL_KEY = 'file:///repo/src/a.ts'
const model = { uri: { toString: () => MODEL_KEY } } as Parameters<typeof provideImportLinkHover>[0]

const target: ResolvedImportLinkTarget = {
  specifier: '@utils/cn',
  targetPath: 'c:/repo/src/utils/cn.ts',
  targetLabel: 'src/utils/cn.ts',
  lineNumber: 1,
  column: 21
}

function registerContext(): void {
  registerImportHoverContext(MODEL_KEY, {
    getLinks: () => getImportSpecifierLinks('import { cn } from "@utils/cn"'),
    getSource: () => ({ filePath: 'c:/repo/src/a.ts', fileId: 'a', worktreeId: 'wt1' })
  })
}

describe('buildImportHoverCommandUri', () => {
  it('encodes the open command with json args', () => {
    const uri = buildImportHoverCommandUri(target, { fileId: 'a', worktreeId: 'wt1' })
    expect(uri.startsWith(`command:${OPEN_IMPORT_TARGET_COMMAND_ID}?`)).toBe(true)
    const args = JSON.parse(decodeURIComponent(uri.split('?')[1]))
    expect(args).toEqual({ targetPath: 'c:/repo/src/utils/cn.ts', worktreeId: 'wt1', fileId: 'a' })
  })
})

describe('provideImportLinkHover', () => {
  it('returns a trusted command link for a position on an import link', async () => {
    registerContext()
    try {
      const resolve = vi.fn(async () => target)
      const hover = await provideImportLinkHover(model, { lineNumber: 1, column: 22 }, resolve)
      expect(hover?.range).toEqual({
        startLineNumber: 1,
        startColumn: 21,
        endLineNumber: 1,
        endColumn: 30
      })
      expect(hover?.contents[0].isTrusted).toBe(true)
      expect(hover?.contents[0].value).toContain('src/utils/cn.ts')
      expect(hover?.contents[0].value).toContain(`command:${OPEN_IMPORT_TARGET_COMMAND_ID}?`)
    } finally {
      unregisterImportHoverContext(MODEL_KEY)
    }
  })

  it('returns null off-link, when unresolved, or for unregistered models', async () => {
    registerContext()
    try {
      const resolve = vi.fn(async () => target)
      expect(await provideImportLinkHover(model, { lineNumber: 1, column: 2 }, resolve)).toBeNull()
      const unresolved = vi.fn(async () => null)
      expect(
        await provideImportLinkHover(model, { lineNumber: 1, column: 22 }, unresolved)
      ).toBeNull()
    } finally {
      unregisterImportHoverContext(MODEL_KEY)
    }
    expect(
      await provideImportLinkHover(
        model,
        { lineNumber: 1, column: 22 },
        vi.fn(async () => target)
      )
    ).toBeNull()
  })
})
