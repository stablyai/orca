// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import type { OpenFile } from '@/store/slices/editor'
import type * as RuntimeFileReadClient from '@/runtime/runtime-file-read-client'
import { openAiVaultSessionLogInOrca } from '../right-sidebar/ai-vault-session-log-open'
import { useEditorPanelContentState } from './useEditorPanelContentState'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({ readRuntimeFileContent: vi.fn(), toastError: vi.fn() }))
vi.mock('@/runtime/runtime-file-read-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeFileReadClient>()),
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-file-watch-client', () => ({ subscribeRuntimeFileChanges: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: mocks.toastError }) }))

const fsApi = {
  onLocalLogTailChanged: vi.fn(() => () => {}),
  startLocalLogTail: vi.fn().mockResolvedValue(undefined),
  stopLocalLogTail: vi.fn().mockResolvedValue(undefined),
  readLocalLogTail: vi.fn(async ({ fromByteOffset }: { fromByteOffset: number }) => ({
    contentBase64: '',
    nextByteOffset: fromByteOffset,
    fileSize: fromByteOffset,
    fileIdentity: 'grok-log',
    hasMore: false,
    reset: false
  }))
}
let latestFileContents: Record<string, FileContent> = {}

function HookProbe({
  activeFile,
  openFiles
}: {
  activeFile: OpenFile
  openFiles: OpenFile[]
}): null {
  latestFileContents = useEditorPanelContentState({
    activeFile,
    openFiles,
    isChangesMode: false,
    gitStatusEntries: undefined,
    editorViewMode: {}
  }).fileContents
  return null
}

describe('History conversation resources through editor content and tailing', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    latestFileContents = {}
    vi.clearAllMocks()
    Object.defineProperty(window, 'api', { configurable: true, value: { fs: fsApi } })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    Reflect.deleteProperty(window, 'api')
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it.each([true, false])(
    'compares metadata and companion reads in an SSH workspace (companion exists: %s)',
    async (companionExists) => {
      const metadataPath = '/Users/me/grok/session/summary.json'
      const logPath = '/Users/me/grok/session/chat_history.jsonl'
      const loadError = `ENOENT: no such file or directory, open '${logPath}'`
      const store = useAppStore
      store.setState({
        activeWorktreeId: 'wt-1',
        repos: [
          { ...TEST_REPO, id: 'repo-1', executionHostId: 'ssh:ssh-1', connectionId: 'ssh-1' }
        ],
        worktreesByRepo: {
          'repo-1': [
            makeWorktree({
              id: 'wt-1',
              repoId: 'repo-1',
              path: '/work/demo-project',
              hostId: 'ssh:ssh-1'
            })
          ]
        }
      })
      expect(getConnectionIdForFile('wt-1', metadataPath)).toBe('ssh-1')
      mocks.readRuntimeFileContent.mockImplementation(
        async ({ filePath }: { filePath: string }) => {
          if (filePath === metadataPath) {
            return { content: '{"title":"Summary"}', isBinary: false }
          }
          if (filePath === logPath && companionExists) {
            return {
              content: '{"role":"user","content":"Hello"}\n',
              isBinary: false,
              fileIdentity: 'grok-log'
            }
          }
          throw new Error(loadError)
        }
      )
      container = document.body.appendChild(document.createElement('div'))
      root = createRoot(container)
      // The former action passed the metadata locator into this same editor contract.
      store.getState().openFile(
        {
          filePath: metadataPath,
          relativePath: metadataPath,
          worktreeId: 'wt-1',
          runtimeEnvironmentId: null,
          language: 'json',
          mode: 'edit',
          readOnly: true,
          liveTail: true
        },
        { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
      )
      let file = store.getState().openFiles[0]
      await act(async () => root?.render(<HookProbe activeFile={file} openFiles={[file]} />))
      expect(latestFileContents[file.id]).toMatchObject({ content: '{"title":"Summary"}' })

      await openAiVaultSessionLogInOrca({
        agent: 'grok',
        filePath: metadataPath,
        executionHostId: 'local'
      })
      const companion = store
        .getState()
        .openFiles.find((candidate) => candidate.filePath === logPath)
      expect(companion).toBeDefined()
      if (!companion) {
        throw new Error('View Log did not open its companion')
      }
      file = companion
      expect(file).toMatchObject({
        relativePath: logPath,
        readOnly: true,
        liveTail: true,
        runtimeEnvironmentId: null
      })
      await act(async () => root?.render(<HookProbe activeFile={file} openFiles={[file]} />))

      expect(mocks.readRuntimeFileContent.mock.calls.map(([input]) => input.filePath)).toEqual([
        metadataPath,
        logPath
      ])
      for (const [input] of mocks.readRuntimeFileContent.mock.calls) {
        expect(input).toMatchObject({
          target: { kind: 'local' },
          connectionId: undefined,
          access: { kind: 'user-file' },
          includeLocalLogMetadata: true
        })
      }
      if (companionExists) {
        expect(latestFileContents[file.id]).toMatchObject({
          content: '{"role":"user","content":"Hello"}\n'
        })
        expect(fsApi.startLocalLogTail).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ filePath: logPath })
        )
      } else {
        expect(latestFileContents[file.id]).toEqual({ content: '', isBinary: false, loadError })
        expect(fsApi.startLocalLogTail).not.toHaveBeenCalled()
        expect(fsApi.readLocalLogTail).not.toHaveBeenCalled()
        expect(mocks.toastError).not.toHaveBeenCalled()
      }
    }
  )
})
