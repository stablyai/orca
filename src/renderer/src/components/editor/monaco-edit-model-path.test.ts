// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Uri } from 'monaco-editor'
import type { OpenFile } from '@/store/slices/editor'
import { disposeClosedEditorTabs } from './closed-editor-tab-disposal'
import { toMonacoEditModelPath } from './monaco-edit-model-path'
import {
  createMonacoModelRegistryWithRealUri,
  type RecordingMonacoModelRegistry
} from './monaco-model-registry-test-fixture'

const crashBreadcrumbs = vi.hoisted(() => ({ record: vi.fn() }))
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: crashBreadcrumbs.record
}))

beforeEach(() => {
  crashBreadcrumbs.record.mockClear()
})

// Why this exact shape: the field crash (`[UriError]: Scheme contains illegal characters.`) came
// from a Windows/WSL workspace. `Uri.parse` reads `\\wsl.localhost\...\notes` as the scheme
// because nothing before the first `:` is a `/`, `?` or `#`.
const WSL_COLON_PATH =
  '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\notes:2026.md'

function editTab(id: string, filePath: string): OpenFile {
  return { id, mode: 'edit', filePath } as OpenFile
}

describe('toMonacoEditModelPath', () => {
  it('leaves every path Monaco already accepts untouched', () => {
    for (const filePath of [
      '/home/mj/projects/acp-client/notes:2026.md',
      'C:\\Users\\mj\\notes:2026.md',
      '\\\\wsl.localhost\\Ubuntu-26.04\\home\\mj\\projects\\acp-client\\src\\index.ts'
    ]) {
      expect(toMonacoEditModelPath(Uri, filePath)).toBe(filePath)
    }
  })

  it('rewrites the path class that makes Monaco throw into a parseable one', () => {
    expect(() => Uri.parse(WSL_COLON_PATH)).toThrow(/Scheme contains illegal characters/)

    const modelPath = toMonacoEditModelPath(Uri, WSL_COLON_PATH)
    expect(modelPath).not.toBe(WSL_COLON_PATH)
    expect(() => Uri.parse(modelPath)).not.toThrow()
  })

  // Why: the rewrite is now the only trace of an input class whose producer is unidentified.
  it('leaves a shape-only crumb describing the rejected path', () => {
    toMonacoEditModelPath(Uri, WSL_COLON_PATH)

    expect(crashBreadcrumbs.record).toHaveBeenCalledWith('editor_model_path_uri_rejected', {
      length: WSL_COLON_PATH.length,
      colons: 1,
      hasBackslash: true,
      schemePrefixLength: WSL_COLON_PATH.indexOf(':'),
      schemePrefixCharset: 'alpha|backslash|digit|schemeSafePunct'
    })
    const [, data] = crashBreadcrumbs.record.mock.calls[0] as [string, Record<string, unknown>]
    expect(JSON.stringify(data)).not.toContain('wsl.localhost')
  })

  it('records nothing for a path Monaco already accepts', () => {
    toMonacoEditModelPath(Uri, '/repo/file.py')

    expect(crashBreadcrumbs.record).not.toHaveBeenCalled()
  })
})

describe('disposeClosedEditorTabs with the real Monaco URI parser', () => {
  it('does not throw the workbench down on the unparseable path class', () => {
    const registry = createMonacoModelRegistryWithRealUri([])

    expect(() =>
      disposeClosedEditorTabs(registry, [editTab('poisoned', WSL_COLON_PATH)])
    ).not.toThrow()
  })

  it('keeps disposing the rest of the close-all batch behind a poisoned tab', () => {
    const beforePath = '/repo/before.ts'
    const afterPath = '/repo/after.ts'
    const registry = createMonacoModelRegistryWithRealUri([
      beforePath,
      toMonacoEditModelPath(Uri, WSL_COLON_PATH),
      afterPath
    ])

    disposeClosedEditorTabs(registry, [
      editTab('before', beforePath),
      editTab('poisoned', WSL_COLON_PATH),
      editTab('after', afterPath)
    ])

    expect(registry.disposed).toContain(beforePath)
    expect(registry.disposed).toContain(afterPath)
    // Why: the poisoned tab's model is reachable too, because open and close now key it the same way.
    expect(registry.disposed).toContain(toMonacoEditModelPath(Uri, WSL_COLON_PATH))
  })

  it('crumbs instead of throwing when even the fallback URI form is unbuildable', () => {
    const registry: RecordingMonacoModelRegistry = {
      ...createMonacoModelRegistryWithRealUri([]),
      Uri: {
        parse: (value: string) => Uri.parse(value),
        file: () => {
          throw new Error('unbuildable')
        }
      }
    }

    expect(() =>
      disposeClosedEditorTabs(registry, [editTab('poisoned', WSL_COLON_PATH)])
    ).not.toThrow()
    expect(crashBreadcrumbs.record).toHaveBeenCalledWith(
      'editor_model_dispose_path_unkeyable',
      expect.objectContaining({ hasBackslash: true })
    )
  })
})
