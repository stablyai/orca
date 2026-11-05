// @vitest-environment happy-dom

import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'

import { act, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { OpenFile } from '@/store/slices/editor'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginPanelsStore } from '@/store/plugin-panels'
import { useCustomEditorViewStore } from '@/store/plugin-custom-editors'
import type { PluginHostListEntry } from '../../../../shared/plugins/plugin-list-entry'
import type { FileContent, EditorPanelFileContentLoader } from './editor-panel-content-types'
import { useEditorPanelFileContentLoader } from './useEditorPanelFileContentLoader'

const mocks = vi.hoisted(() => ({ fullRead: vi.fn() }))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.fullRead
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const originalApi = window.api

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useCustomEditorViewStore.setState({ choices: {} })
  mocks.fullRead.mockReset()
  mocks.fullRead.mockResolvedValue({ content: '{"source":true}', isBinary: false })
})
afterEach(() => {
  usePluginPanelsStore.setState({ plugins: [] })
  Object.assign(window, { api: originalApi })
})

function install(priority: 'default' | 'option' = 'default', extension = '.bin'): void {
  const plugin: PluginHostListEntry = {
    pluginKey: 'test.range',
    consentFingerprint: null,
    name: 'Range',
    version: '1.0.0',
    publisher: 'test',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    customEditors: [
      {
        id: 'bytes',
        title: 'Bytes',
        extensions: [extension],
        filenames: [],
        priority,
        contentKind: 'bytes',
        documentAccess: 'ranges'
      }
    ]
  }
  usePluginPanelsStore.setState({ plugins: [plugin] })
}

function loader() {
  const root = createRoot(document.createElement('div'))
  let load: EditorPanelFileContentLoader | undefined
  let contents: Record<string, FileContent> = {}
  function Loader(): null {
    load = useEditorPanelFileContentLoader({
      fileLoadRetryAttemptsRef: { current: {} },
      fileReadGenerationCounterRef: { current: 0 },
      fileReadGenerationRef: { current: {} },
      openFilesRef: { current: [] },
      outstandingFileReadsRef: { current: {} },
      fileContentsRef: {
        get current() {
          return contents
        }
      },
      setFileContents: (update) => {
        contents = typeof update === 'function' ? update(contents) : update
      }
    })
    return null
  }
  act(() => root.render(<Loader />))
  return {
    load: (
      path = '/repo/data.bin',
      id = 'file',
      options?: Parameters<EditorPanelFileContentLoader>[4]
    ) => load!(path, id, undefined, undefined, options),
    content: () => contents.file,
    dispose: () => {
      for (const value of Object.values(contents)) {
        value.rangeDocument?.dispose()
      }
      act(() => root.unmount())
    }
  }
}

it.each([
  [68157440, 'default'],
  [1073741824, 'default'],
  [68157440, 'option']
] as const)(
  'opens a %i-byte selected %s source without old full-file admission',
  async (byteLength, priority) => {
    install(priority)
    if (priority === 'option') {
      useCustomEditorViewStore.setState({ choices: { file: 'test.range/bytes' } })
    }
    mocks.fullRead.mockRejectedValue(new Error('Old whole-file admission must not run'))
    Object.assign(window, {
      api: {
        fs: {
          rangeDocumentOpen: async () => ({
            id: 'host-only',
            version: 1,
            byteLength,
            maxReadBytes: 262144,
            readOnly: true,
            isBinary: true,
            valid: true
          }),
          rangeDocumentClose: async () => {}
        }
      }
    })
    const view = loader()
    try {
      await act(async () => {
        await view.load()
      })
      expect(view.content()).toMatchObject({
        isBinary: true,
        size: byteLength,
        content: '',
        rangeDocument: { descriptor: { byteLength } }
      })
      expect(view.content().loadError).toBeUndefined()
    } finally {
      view.dispose()
    }
  }
)

it.each([
  ['.json', 'option', undefined],
  ['.bin', 'default', 'source']
] as const)(
  'preserves normal Source text for %s with priority %s and choice %s',
  async (extension, priority, choice) => {
    install(priority, extension)
    if (choice) {
      useCustomEditorViewStore.setState({ choices: { file: choice } })
    }
    Object.assign(window, {
      api: {
        fs: {
          rangeDocumentOpen: async () => {
            throw new Error('An unselected editor must not acquire range authority')
          }
        }
      }
    })
    const view = loader()
    try {
      await act(async () => {
        await view.load(`/repo/data${extension}`)
      })
      expect(view.content()).toMatchObject({ content: '{"source":true}', isBinary: false })
      expect(view.content().rangeDocument).toBeUndefined()
      expect(view.content().loadError).toBeUndefined()
    } finally {
      view.dispose()
    }
  }
)

it('keeps independent document owners when two panels load the same file', async () => {
  install()
  const openIds = new Set<string>()
  let nextId = 0
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => {
          const id = `owner-${++nextId}`
          openIds.add(id)
          return {
            id,
            version: 1,
            byteLength: 2,
            maxReadBytes: 262144,
            readOnly: true,
            isBinary: true,
            valid: true
          }
        },
        rangeDocumentClose: async ({ id }: { id: string }) => {
          openIds.delete(id)
        },
        rangeDocumentRead: async ({ id }: { id: string }) => {
          if (!openIds.has(id)) {
            throw new Error('Document authority closed')
          }
          return { version: 1, contentBase64: 'FiE=', bytesRead: 2, eof: true }
        }
      }
    }
  })
  const first = loader()
  const second = loader()
  try {
    await act(async () => {
      await Promise.all([first.load(), second.load()])
    })
    first.content().rangeDocument!.dispose()
    const result = await second.content().rangeDocument!.read({ version: 1, offset: 0, length: 2 })
    expect([...new Uint8Array(result.bytes)]).toEqual([22, 33])
  } finally {
    first.dispose()
    second.dispose()
  }
})

it('reads from the current range owner after an explicit panel Reload retires the previous content', async () => {
  install()
  const initialOpen = Promise.withResolvers<void>()
  const initialCommitted = Promise.withResolvers<void>()
  const openIds = new Set<string>()
  let nextId = 0
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => {
          await initialOpen.promise
          const id = `reload-owner-${++nextId}`
          openIds.add(id)
          return {
            id,
            version: 1,
            byteLength: 2,
            maxReadBytes: 262144,
            readOnly: true,
            isBinary: true,
            valid: true
          }
        },
        rangeDocumentClose: async ({ id }: { id: string }) => {
          openIds.delete(id)
        },
        rangeDocumentRead: async ({ id }: { id: string }) => {
          if (!openIds.has(id)) {
            throw new Error('Document authority closed')
          }
          return { version: 1, contentBase64: 'FiE=', bytesRead: 2, eof: true }
        }
      }
    }
  })
  const file: OpenFile = {
    id: 'file',
    filePath: '/repo/data.bin',
    relativePath: 'data.bin',
    worktreeId: '',
    language: 'plaintext',
    mode: 'edit',
    isDirty: false
  }
  const openFiles = [file]
  const root = createRoot(document.createElement('div'))
  let current: ReturnType<typeof useEditorPanelContentState> | undefined
  function Panel(): null {
    current = useEditorPanelContentState({
      activeFile: file,
      openFiles,
      isChangesMode: false,
      gitStatusEntries: undefined,
      editorViewMode: {}
    })
    const contents = current.fileContents
    useLayoutEffect(() => {
      if (contents.file) {
        initialCommitted.resolve()
      }
    }, [contents])
    return null
  }
  try {
    act(() => root.render(<Panel />))
    await act(async () => {
      initialOpen.resolve()
    })
    await initialCommitted.promise
    expect(current?.fileContents.file).toMatchObject({ isBinary: true })
    act(() => flushSync(() => current!.reloadContent(file, { wakeWslDistro: true })))
    await act(async () => {})
    const document = current!.fileContents.file.rangeDocument!
    await document.bind()
    const result = await document.read({ version: document.value().version, offset: 0, length: 2 })
    expect([...new Uint8Array(result.bytes)]).toEqual([22, 33])
  } finally {
    act(() => root.unmount())
  }
})

it('keeps an invalidated range version when a watcher refresh omits the initial wake hint', async () => {
  install()
  Object.assign(window, {
    api: {
      fs: {
        rangeDocumentOpen: async () => ({
          id: 'watch-owner',
          version: 1,
          byteLength: 2,
          maxReadBytes: 262144,
          readOnly: true,
          isBinary: true,
          valid: true
        }),
        rangeDocumentClose: async () => {},
        rangeDocumentRead: async () => ({
          version: 1,
          contentBase64: 'FiE=',
          bytesRead: 2,
          eof: true
        })
      }
    }
  })
  const view = loader()
  try {
    await act(async () => {
      await view.load(undefined, undefined, { wakeWslDistro: true })
    })
    const source = view.content().rangeDocument!
    const before = await source.read({ version: 1, offset: 0, length: 2 })
    expect([...new Uint8Array(before.bytes)]).toEqual([22, 33])
    source.invalidate()
    await act(async () => {
      await view.load(undefined, undefined, { force: true, externalEventGeneration: 1 })
    })
    const current = view.content().rangeDocument!
    await current.bind()
    await expect(current.read({ version: 1, offset: 0, length: 2 })).rejects.toThrow(
      'Reload explicitly'
    )
  } finally {
    view.dispose()
  }
})
