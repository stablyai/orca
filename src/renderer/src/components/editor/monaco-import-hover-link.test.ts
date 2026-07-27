import { describe, expect, it, vi } from 'vitest'
import {
  buildImportHoverCommandUri,
  IMPORT_HOVER_RESOLUTION_CACHE_MAX,
  OPEN_IMPORT_TARGET_COMMAND_ID,
  provideImportLinkHover,
  registerImportHoverContext,
  resolveImportHoverTargetWithCache
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

function registerContext(): () => void {
  return registerImportHoverContext(MODEL_KEY, {
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
    const dispose = registerContext()
    try {
      const resolve = vi.fn(async () => target)
      const hover = await provideImportLinkHover(model, { lineNumber: 1, column: 22 }, resolve)
      expect(hover?.range).toEqual({
        startLineNumber: 1,
        startColumn: 21,
        endLineNumber: 1,
        endColumn: 30
      })
      expect(hover?.contents[0].isTrusted).toEqual({
        enabledCommands: [OPEN_IMPORT_TARGET_COMMAND_ID]
      })
      expect(hover?.contents[0].value).toContain('src/utils/cn.ts')
      expect(hover?.contents[0].value).toContain(`command:${OPEN_IMPORT_TARGET_COMMAND_ID}?`)
    } finally {
      dispose()
    }
  })

  it('returns null off-link, when unresolved, or for unregistered models', async () => {
    const dispose = registerContext()
    try {
      const resolve = vi.fn(async () => target)
      expect(await provideImportLinkHover(model, { lineNumber: 1, column: 2 }, resolve)).toBeNull()
      const unresolved = vi.fn(async () => null)
      expect(
        await provideImportLinkHover(model, { lineNumber: 1, column: 22 }, unresolved)
      ).toBeNull()
    } finally {
      dispose()
    }
    expect(
      await provideImportLinkHover(
        model,
        { lineNumber: 1, column: 22 },
        vi.fn(async () => target)
      )
    ).toBeNull()
  })

  it.each(['first', 'second'] as const)(
    'keeps hover registered when the %s split pane is disposed',
    async (disposedPane) => {
      const disposeFirst = registerContext()
      const disposeSecond = registerContext()
      const disposed = disposedPane === 'first' ? disposeFirst : disposeSecond
      const remaining = disposedPane === 'first' ? disposeSecond : disposeFirst
      disposed()
      try {
        const hover = await provideImportLinkHover(
          model,
          { lineNumber: 1, column: 22 },
          vi.fn(async () => target)
        )
        expect(hover?.contents[0].value).toContain('src/utils/cn.ts')
      } finally {
        remaining()
      }
    }
  )

  it('escapes the target label and trusts only the open-import command', async () => {
    const dispose = registerContext()
    try {
      const injectedTarget = {
        ...target,
        targetLabel: 'src/evil](command:workbench.action.deleteFile)[x.ts'
      }
      const hover = await provideImportLinkHover(
        model,
        { lineNumber: 1, column: 22 },
        vi.fn(async () => injectedTarget)
      )
      const markdown = hover?.contents[0]

      expect(markdown?.value).not.toContain('](command:workbench.action.deleteFile)')
      expect(markdown?.value).toContain(
        String.raw`src/evil\]\(command:workbench.action.deleteFile\)\[x.ts`
      )
      expect(markdown?.isTrusted).toEqual({ enabledCommands: [OPEN_IMPORT_TARGET_COMMAND_ID] })
    } finally {
      dispose()
    }
  })
})

describe('import hover resolution cache', () => {
  it('drops a model resolution when its hover context is unregistered', async () => {
    const resolve = vi.fn(async () => target)
    const link = getImportSpecifierLinks('import x from "./x"')[0]
    const source = { filePath: '/repo/a.ts', fileId: 'a', worktreeId: 'wt1' }
    const modelKey = 'cache-cleanup-model'

    const disposeFirst = registerImportHoverContext(modelKey, {
      getLinks: () => [link],
      getSource: () => source
    })
    await resolveImportHoverTargetWithCache(modelKey, link, source, resolve)
    disposeFirst()
    const disposeSecond = registerImportHoverContext(modelKey, {
      getLinks: () => [link],
      getSource: () => source
    })
    await resolveImportHoverTargetWithCache(modelKey, link, source, resolve)
    disposeSecond()

    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest resolution when the cache reaches its size limit', async () => {
    const resolve = vi.fn(async () => target)
    const link = getImportSpecifierLinks('import x from "./x"')[0]
    const source = { filePath: '/repo/a.ts', fileId: 'a', worktreeId: 'wt1' }

    for (let index = 0; index <= IMPORT_HOVER_RESOLUTION_CACHE_MAX; index += 1) {
      await resolveImportHoverTargetWithCache(`cache-model-${index}`, link, source, resolve)
    }
    await resolveImportHoverTargetWithCache('cache-model-0', link, source, resolve)

    expect(resolve).toHaveBeenCalledTimes(IMPORT_HOVER_RESOLUTION_CACHE_MAX + 2)
  })
})
