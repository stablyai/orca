// @vitest-environment happy-dom
import { useRef, useContext, useMemo } from 'react'
import { useQueuedEditFixture, withText, writeSpy } from './structured-queued-edit.test-fixture'
import { NativeChatQueuedMessageComposer } from './NativeChatQueuedMessageComposer'
import { NativeChatComposer } from './NativeChatComposer'
import { fileReferenceContent } from './native-chat-prompt-document'
import {
  NativeChatMarkdownImageOwnerProvider,
  NativeChatMarkdownImageOwnerContext
} from './native-chat-markdown-image-owner'
import { useAppStore } from '@/store'
import {
  nativeChatFanoutFixture,
  agentSessionTabFixture,
  repoFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'
import type { NativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { getDefaultSettings } from '../../../../shared/constants'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import { useNativeChatPastedTextFile } from './use-native-chat-pasted-text-file'
import {
  insertNativeChatPastedText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { promptEditor, promptValue } from './native-chat-prompt-editor.test-support'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { resolveNativeChatPastedText } from './native-chat-composer-pasted-text-references'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'

const mocks = vi.hoisted(() => ({ save: vi.fn(), rpc: vi.fn(), write: vi.fn(), resolved: false }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('./native-chat-visual-markdown-extension', () => ({
  useNativeChatVisualMarkdownExtension: () => undefined
}))
vi.mock('./use-native-chat-file-link-existence', () => ({
  useNativeChatFileLinkExists: () => undefined
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionMenu: () => null,
  NativeChatPickerMenu: () => null
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
const scope = 'agent-session:consumer35636'
const path =
  '/host/agent-session-attachments/12345678-1234-1234-1234-123456789abc/orca-paste-123-abc.txt'
let paste: (text: string) => boolean
function Composer({ initialValue = '' }: { initialValue?: string }) {
  const ref = useRef<NativeChatComposerInput>(null)
  paste = useNativeChatPastedTextFile({
    scopeKey: scope,
    scopeEditor: () => ref.current,
    resolveAttachmentOwner: () => ({ kind: 'local' }),
    insertTypedText: (text) => insertNativeChatPastedText(ref.current, text),
    setNotice: () => {}
  })
  const resolved = mocks.resolved
  const owner = useMemo(
    () => ({
      runtimeContext: resolved
        ? { target: { kind: 'local' as const }, worktreeId: 'w', worktreePath: '/repo' }
        : null,
      isVisible: true,
      fileLinkContext: null
    }),
    [resolved]
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
      <NativeChatTextAttachmentScope enabled>
        <NativeChatPromptEditor
          scopeKey={scope}
          inputRef={ref}
          initialValue={initialValue}
          disabled={false}
          placeholder="Message"
          onChange={() => {}}
          onSelect={() => {}}
        />
      </NativeChatTextAttachmentScope>
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}
async function openSource() {
  fireEvent.click(await screen.findByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Copy contents' }).hasAttribute('disabled')).toBe(
      false
    )
  )
}
afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
  nativeChatPastedTextOperations.clear()
  vi.clearAllMocks()
})

it('opens pending and settled draft pills, retains remove/undo and restores the token map', async () => {
  const text = `\ufeff${'🙂paste\r\n'.repeat(5000)}`
  mocks.resolved = false
  const upload = Promise.withResolvers<string>()
  mocks.save.mockReturnValue(upload.promise)
  mocks.rpc.mockImplementation(async (_target, method, request) => {
    if (method === 'status.get') {
      return { capabilities: ['native-chat.text-attachment-read.v1'] }
    }
    const bytes = Buffer.from(text)
    const chunk = bytes.subarray(request.offset, request.offset + request.length)
    return {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      bytesRead: chunk.length,
      contentBase64: chunk.toString('base64'),
      eof: request.offset + chunk.length === bytes.length
    }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { savePastedTextAsFile: mocks.save, writeClipboardText: mocks.write } }
  })
  let view = render(<Composer />)
  await act(async () => {
    expect(paste(text)).toBe(true)
  })
  expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
  await openSource()
  fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
  await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(text))
  expect(mocks.rpc).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  mocks.resolved = true
  await act(async () => upload.resolve(path))
  view.rerender(<Composer />)
  expect(nativeChatPastedTextOperations.size).toBe(0)
  fireEvent.click(screen.getByRole('button', { name: 'Pasted text' }))
  await waitFor(() =>
    expect(mocks.rpc).toHaveBeenCalledWith(
      expect.anything(),
      'agentSessionAttachment.readTextChunk',
      expect.objectContaining({ path }),
      expect.anything()
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  const editor = promptEditor(screen.getByRole('textbox'))
  const token = promptValue(screen.getByRole('textbox')).trim()
  act(() => {
    editor.commands.selectAll()
    editor.commands.deleteSelection()
  })
  expect(screen.queryByRole('button', { name: 'Pasted text' })).toBeNull()
  await act(async () => {
    editor.commands.undo()
  })
  expect(screen.getByRole('button', { name: 'Pasted text' })).toBeTruthy()
  const saved = structuredClone(readNativeChatComposerDraft(scope))
  expect(saved.text).toContain(token)
  const sent = resolveNativeChatPastedText(scope, token)
  expect(sent).toBe(`@${path}`)
  view.unmount()
  clearNativeChatComposerDraftsForTests()
  updateNativeChatComposerDraft(
    scope,
    { text: saved.text, document: saved.document, pastedTextFiles: saved.pastedTextFiles },
    'immediate'
  )
  expect(readNativeChatComposerDraft(scope).text).toBe(saved.text)
  view = render(<Composer initialValue={saved.text} />)
  await openSource()
  view.unmount()
})

it.each(['save', 'cancel', 'escape', 'unmount'] as const)(
  'retires the actual queued composer source on %s while the normal composer keeps its editor',
  async (exit) => {
    const initial = useAppStore.getInitialState()
    const fixture = nativeChatFanoutFixture(1, 1, 0)
    useAppStore.setState(
      {
        ...initial,
        ...fixture,
        settings: getDefaultSettings('/test35636'),
        runtimeEnvironmentCatalogHydrated: true
      },
      true
    )
    const text = 'queued source bytes'
    const bytes = Buffer.from(text)
    const reply = {
      snapshot: 'a'.repeat(64),
      size: bytes.length,
      bytesRead: bytes.length,
      contentBase64: bytes.toString('base64'),
      eof: true
    }
    mocks.rpc.mockImplementation(async (_target, method) =>
      method === 'status.get' ? { capabilities: ['native-chat.text-attachment-read.v1'] } : reply
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: { writeClipboardText: mocks.write },
        git: { discoverCommitMessageModels: vi.fn(async () => ({ success: false })) }
      }
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => true,
      send: () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local',
      sessionId: 'session-0',
      runtimeEnvironmentId: null
    }
    const observed: { owner: NativeChatImageRuntimeContext } = { owner: null }
    function OwnerProbe() {
      observed.owner = useContext(NativeChatMarkdownImageOwnerContext)!.runtimeContext
      return null
    }
    function Chat({ visible = true }: { visible?: boolean }) {
      const queue = useQueuedEditFixture({ messages: [withText(`@${path}`)] })
      return (
        <TooltipProvider>
          <NativeChatMarkdownImageOwnerProvider
            tabId="chat-0"
            sessionId="session-0"
            isVisible={visible}
          >
            <OwnerProbe />
            <NativeChatComposer
              terminalTabId="chat-0"
              paneKey="normal35636"
              targetPtyId={null}
              agent="codex"
              structuredTransport={transport}
            />
            <button onClick={() => void queue.begin('card')}>Edit queued source</button>
            {queue.editor ? (
              <NativeChatQueuedMessageComposer
                editor={queue.editor}
                attachTo={{ terminalTabId: 'chat-0', transport }}
              />
            ) : null}
          </NativeChatMarkdownImageOwnerProvider>
        </TooltipProvider>
      )
    }
    const view = render(<Chat />)
    try {
      const normal = screen.getByRole('textbox')
      const normalEditor = promptEditor(normal)
      await act(async () => normalEditor.commands.insertContent('unsent normal draft'))
      fireEvent.click(screen.getByRole('button', { name: 'Edit queued source' }))
      await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
      const editor = screen.getAllByRole('textbox')[1]!
      const queuedEditor = promptEditor(editor)
      await act(async () =>
        queuedEditor.commands.insertContent([
          { type: 'text', text: 'edited ' },
          fileReferenceContent(path),
          { type: 'text', text: ' ' }
        ])
      )
      // Owner replacement retires only the preview and preserves both real editor instances/drafts.
      await openSource()
      await act(async () =>
        useAppStore.setState({
          sshStateByEnvironment: new Map([
            [
              'unrelated',
              {
                targets: [],
                targetGenerations: new Map(),
                targetLabels: new Map(),
                removedTargetLabels: new Map(),
                targetsHydrated: true,
                connectionStates: new Map()
              }
            ]
          ])
        })
      )
      expect(screen.getByRole('button', { name: 'Copy contents' })).toBeTruthy()
      await act(async () =>
        useAppStore.setState({
          folderWorkspaces: useAppStore
            .getState()
            .folderWorkspaces.map((row) =>
              row.id === 'workspace-0' ? { ...row, folderPath: '/renamed35636' } : row
            )
        })
      )
      expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
      expect(promptEditor(editor)).toBe(queuedEditor)
      expect(promptEditor(normal)).toBe(normalEditor)
      expect(promptValue(normal)).toBe('unsent normal draft')
      if (exit === 'save') {
        const folders = useAppStore.getState().folderWorkspaces
        await openSource()
        await act(async () => useAppStore.setState({ folderWorkspaces: [] }))
        expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
        await act(async () => useAppStore.setState({ folderWorkspaces: folders }))
        const ssh = (generation: number) =>
          new Map([
            [
              'owner-a',
              {
                targets: [],
                targetGenerations: new Map(),
                targetLabels: new Map(),
                removedTargetLabels: new Map(),
                targetsHydrated: true,
                connectionStates: new Map([
                  [
                    'ssh35636',
                    {
                      targetId: 'ssh35636',
                      status: 'connected' as const,
                      error: null,
                      reconnectAttempt: 0,
                      connectionGeneration: generation
                    }
                  ]
                ])
              }
            ]
          ])
        await act(async () =>
          useAppStore.setState({
            unifiedTabsByWorktree: {
              'wt-ssh': [agentSessionTabFixture('chat-0', 'wt-ssh', { entityId: 'session-0' })]
            },
            activeWorktreeId: 'wt-ssh',
            activeWorkspaceExecutionHostId: 'ssh:ssh35636',
            repos: [repoFixture({ executionHostId: 'runtime:owner-a' })],
            worktreesByRepo: {
              repo: [
                worktreeFixture('wt-ssh', '/ssh35636', {
                  hostId: 'ssh:ssh35636',
                  runtimeOwnerEnvironmentId: 'owner-a'
                })
              ]
            },
            runtimeEnvironments: [
              {
                id: 'owner-a',
                name: 'owner-a',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: null,
                runtimeId: null,
                preferredEndpointId: 'endpoint',
                endpoints: []
              }
            ],
            sshStateByEnvironment: ssh(1)
          })
        )
        expect(observed.owner).toMatchObject({
          expectedSshConnectionGeneration: 1,
          target: { kind: 'environment', environmentId: 'owner-a' }
        })
        await openSource()
        await act(async () => useAppStore.setState({ sshStateByEnvironment: ssh(2) }))
        expect(observed.owner).toMatchObject({ expectedSshConnectionGeneration: 2 })
        expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
        expect(promptEditor(editor)).toBe(queuedEditor)
        expect(promptEditor(normal)).toBe(normalEditor)
      }
      await openSource()
      view.rerender(<Chat visible={false} />)
      expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
      view.rerender(<Chat />)
      await openSource()
      const pending = Promise.withResolvers<typeof reply>()
      mocks.rpc.mockImplementationOnce(() => pending.promise)
      fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
      await act(async () => {})
      if (exit === 'save') {
        fireEvent.keyDown(editor, { key: 'Enter' })
        await waitFor(() => expect(writeSpy).toHaveBeenCalled())
      } else if (exit === 'cancel') {
        fireEvent.click(
          within(view.container).getByRole('button', { name: 'Cancel', hidden: true })
        )
      } else if (exit === 'escape') {
        // The Sheet retires Copy first; editor Escape then exits the real queued editor.
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
        )
        await act(async () => editor.focus())
        fireEvent.keyDown(editor, { key: 'Escape' })
      } else {
        view.unmount()
      }
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Copy contents' })).toBeNull()
      )
      await act(async () => pending.resolve(reply))
      expect(mocks.write).not.toHaveBeenCalled()
      if (exit !== 'unmount') {
        await waitFor(() => expect(screen.getAllByRole('textbox')).toEqual([normal]))
        expect(promptValue(normal)).toBe('unsent normal draft')
        fireEvent.click(screen.getByRole('button', { name: 'Edit queued source' }))
        await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2))
        await act(async () =>
          promptEditor(screen.getAllByRole('textbox')[1]!).commands.insertContent(
            fileReferenceContent(path)
          )
        )
        await openSource()
        fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
        await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(text))
      }
    } finally {
      view.unmount()
      useAppStore.setState(initial, true)
      vi.unstubAllGlobals()
    }
  }
)
