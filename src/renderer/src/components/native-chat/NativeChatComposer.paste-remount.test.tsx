// @vitest-environment happy-dom

// A screenshot pasted into a chat on a paired server is still uploading when an agent prompt card
// replaces the composer. The real composer, attachment and paste hooks keep the upload, and Send
// waits for it, whenever the composer comes back; a rich-text paste's image is owed from the start.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef, type RefObject } from 'react'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type {
  NativeChatComposerField as NativeChatComposerFieldComponent,
  NativeChatComposerFieldProps,
  NativeChatComposerImageAttachment
} from './NativeChatComposerField'

type FieldProps = {
  imageAttachments?: readonly NativeChatComposerImageAttachment[]
  sendButtonDisabled?: boolean
  onRemoveImageAttachment: (id: string) => void
}

const mocks = vi.hoisted(() => {
  const state: { fieldProps: FieldProps | null; owner: NativeChatAttachmentOwner } = {
    fieldProps: null,
    owner: {
      kind: 'runtime-session',
      environmentId: 'env-1',
      pairingRevision: 1,
      sessionId: 'session-1'
    }
  }
  return { state, prepare: vi.fn(), save: vi.fn() }
})

vi.mock('../../store', () => {
  const state = {
    tabsByWorktree: {},
    worktrees: [],
    repos: [],
    dictationState: 'idle',
    settings: { voice: { enabled: false }, nativeChatSessionOptions: {} },
    agentStatusByPaneKey: {},
    updateSettings: vi.fn(),
    clearNativeChatLaunchDraft: vi.fn(),
    markNativeChatLaunchDraftAdopted: vi.fn()
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./NativeChatComposerField', async (importOriginal) => {
  const original = await importOriginal<{
    NativeChatComposerField: typeof NativeChatComposerFieldComponent
  }>()
  return {
    NativeChatComposerField: (props: NativeChatComposerFieldProps) => {
      mocks.state.fieldProps = props
      return <original.NativeChatComposerField {...props} />
    }
  }
})
vi.mock('./NativeChatComposerActions', () => ({ NativeChatComposerActions: () => null }))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: () => mocks.state.owner
  })
}))
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareNativeChatSessionAttachmentUpload: mocks.prepare
}))

import { NativeChatComposer } from './NativeChatComposer'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

const PANE = 'tab-1::session-1'
const STORED = '/srv/agent-session-attachments/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01/orca-paste.png'

function composer(
  acceptsImages = true,
  composerRef?: RefObject<NativeChatComposerHandle | null>
): React.JSX.Element {
  return (
    <NativeChatComposer
      ref={composerRef}
      terminalTabId="tab-1"
      paneKey={PANE}
      targetPtyId={null}
      agent="claude"
      structuredTransport={{
        send: vi.fn(() => true),
        dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
        optionsSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        optionSnapshot: [],
        onError: vi.fn(),
        runtime: 'remote',
        acceptsImages,
        sessionId: 'session-1',
        runtimeEnvironmentId: 'env-1'
      }}
    />
  )
}

/** The preload bridge: what this test drives, and an inert subscription for everything else. */
function installPreloadApi(ui: Record<string, unknown>): void {
  const inert = (): (() => void) => () => {}
  const namespace = (own: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(own, {
      get: (target, key) => (typeof key === 'string' && key in target ? target[key] : inert)
    })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: new Proxy<Record<string, unknown>>(
      { ui: namespace(ui) },
      { get: (target, key) => (key === 'ui' ? target.ui : namespace({})) }
    )
  })
}

function imagePaste(text?: string): ClipboardEvent {
  const data = new DataTransfer()
  data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  if (text) {
    data.setData('text/plain', text)
  }
  return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
}

function holdUpload(): (path: string) => void {
  let finishUpload: (path: string) => void = () => {}
  mocks.save.mockReturnValue(
    new Promise<string>((resolve) => {
      finishUpload = resolve
    })
  )
  installPreloadApi({ saveClipboardImageAsTempFile: mocks.save })
  return (path) => finishUpload(path)
}

beforeEach(() => {
  clearNativeChatAttachmentCacheForTests()
  clearNativeChatDraftCacheForTests()
  mocks.state.fieldProps = null
  mocks.state.owner = {
    kind: 'runtime-session',
    environmentId: 'env-1',
    pairingRevision: 1,
    sessionId: 'session-1'
  }
  mocks.prepare.mockResolvedValue({
    ok: true,
    target: {
      environmentId: 'env-1',
      sessionId: 'session-1',
      expectedEnvironmentPairingRevision: 1,
      expectedEnvironmentRuntimeId: 'runtime-a'
    }
  })
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
  )
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a paste into a chat on a paired server', () => {
  it('is still there when the composer returns from a prompt card that replaced it mid-upload', async () => {
    let finishUpload: (path: string) => void = () => {}
    mocks.save.mockReturnValue(
      new Promise<string>((resolve) => {
        finishUpload = resolve
      })
    )
    installPreloadApi({ saveClipboardImageAsTempFile: mocks.save })
    const view = render(composer())
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste()))
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ pending: true }])

    // The agent asks a question: its card takes the composer's place while the image uploads.
    view.unmount()
    await act(async () => finishUpload(STORED))

    expect(readNativeChatAttachmentCache(PANE).map((attachment) => attachment.path)).toEqual([
      STORED
    ])
    render(composer())
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ path: STORED }])
  })

  it('still holds Send when the composer returns before the upload has finished', async () => {
    const finishUpload = holdUpload()
    // Something typed, so only the pending image can hold Send.
    writeNativeChatDraftCache(PANE, 'look at this')
    const first = render(composer())
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste()))
    first.unmount()

    // Back from the prompt card while the image is still on its way to the server.
    render(composer())
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(true)
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ pending: true }])

    await act(async () => finishUpload(STORED))
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ path: STORED }])
    expect(mocks.state.fieldProps?.imageAttachments?.[0]?.pending).toBeFalsy()
  })

  it('holds Send for rich text while the server is still asked whether it takes the image', async () => {
    const prepared = Promise.withResolvers<unknown>()
    mocks.prepare.mockReturnValue(prepared.promise)
    holdUpload()
    // What the user typed, and the pasted text with it: Send is open before the paste.
    writeNativeChatDraftCache(PANE, 'look at this caption')
    render(composer())
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(false)
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste('caption')))

    // The text is in; the image is not yet anywhere, but it is owed to this message.
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(true)
  })

  it("shows a rich-text paste's image once the server answers, even in a composer that came back", async () => {
    const prepared = Promise.withResolvers<unknown>()
    mocks.prepare.mockReturnValue(prepared.promise)
    const finishUpload = holdUpload()
    writeNativeChatDraftCache(PANE, 'look at this caption')
    const first = render(composer())
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste('caption')))
    // A prompt card replaces the composer while the server is still being asked.
    first.unmount()
    render(composer())
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(true)

    await act(async () =>
      prepared.resolve({
        ok: true,
        target: {
          environmentId: 'env-1',
          sessionId: 'session-1',
          expectedEnvironmentPairingRevision: 1,
          expectedEnvironmentRuntimeId: 'runtime-a'
        }
      })
    )
    // Shown, so the user can see it and remove it while it uploads.
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ pending: true }])
    expect(mocks.state.fieldProps?.imageAttachments?.[0]).not.toHaveProperty('hidden')

    await act(async () => finishUpload(STORED))
    expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ path: STORED }])
  })
})

it('keeps a local image paste after the real composer closes and reopens', async () => {
  mocks.state.owner = { kind: 'local' }
  mocks.save.mockClear()
  const finishUpload = holdUpload()
  const first = render(composer())
  await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste()))
  await waitFor(() => expect(mocks.save).toHaveBeenCalled())
  expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([{ pending: true }])
  first.unmount()
  await act(async () => finishUpload('/local/native-chat-pastes/orca-paste-1-image.png'))
  render(composer())
  expect(mocks.state.fieldProps?.imageAttachments).toMatchObject([
    { path: '/local/native-chat-pastes/orca-paste-1-image.png' }
  ])
  await waitFor(() => expect(mocks.state.fieldProps?.imageAttachments?.[0]?.pending).toBeFalsy())
})

it.each([
  { kind: 'local', acceptsImages: false },
  { kind: 'ssh', acceptsImages: false },
  { kind: 'local', acceptsImages: true },
  { kind: 'ssh', acceptsImages: true }
] as const)(
  'can remove a stalled $kind paste after reopen with acceptsImages=$acceptsImages',
  async ({ kind, acceptsImages }) => {
    mocks.state.owner =
      kind === 'local'
        ? { kind: 'local' }
        : {
            kind: 'ssh',
            connectionId: 'ssh-1',
            worktreePath: '/remote/folder',
            expectedExecutionHostId: 'ssh:ssh-1',
            expectedSshTargetId: 'ssh-1',
            expectedSshConnectionGeneration: 1
          }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const finishUpload = holdUpload()
    writeNativeChatDraftCache(PANE, 'look at this')
    const first = render(composer(acceptsImages))
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(false)
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste()))
    first.unmount()
    render(composer(acceptsImages))
    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000))
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Saving pasted image…' })).toBeTruthy()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    )
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(false)
    await act(async () =>
      finishUpload(
        kind === 'local'
          ? '/local/native-chat-pastes/orca-paste-1-image.png'
          : '/tmp/orca-paste-1-image.png'
      )
    )
    expect(readNativeChatAttachmentCache(PANE)).toEqual([])
    expect(readNativeChatDraftCache(PANE)).toBe('look at this')
    expect(mocks.state.fieldProps?.imageAttachments).toEqual([])
  }
)

it.each([true, false])(
  'pastes ordinary menu text without image feedback or holding Send, acceptsImages=%s',
  async (acceptsImages) => {
    mocks.state.owner = { kind: 'local' }
    mocks.save.mockClear()
    mocks.save.mockReturnValue(new Promise(() => {}))
    installPreloadApi({
      saveClipboardImageAsTempFile: mocks.save,
      readClipboardText: async () => 'ordinary text',
      readClipboardFilePaths: async () => [],
      readClipboardImageThumbnail: async () => null,
      clipboardHasImage: async () => false
    })
    const handle = createRef<NativeChatComposerHandle>()
    writeNativeChatDraftCache(PANE, 'look at this')
    render(composer(acceptsImages, handle))
    await act(async () => handle.current?.pasteFromClipboard())
    expect(screen.getByRole('textbox').textContent).toContain('ordinary text')
    expect(screen.queryByRole('button', { name: 'Saving pasted image…' })).toBeNull()
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(false)
    expect(mocks.save).not.toHaveBeenCalled()
  }
)

it.each([true, false])(
  'releases all previews when a paired paste is removed before acceptance, acceptsImages=%s',
  async (acceptsImages) => {
    const prepare = Promise.withResolvers<{
      ok: true
      target: {
        environmentId: string
        sessionId: string
        expectedEnvironmentPairingRevision: number
      }
    }>()
    mocks.prepare.mockReturnValue(prepare.promise)
    const finishUpload = holdUpload()
    const allocated = new Set<string>()
    const released = new Set<string>()
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = 'blob:late-acceptance'
      allocated.add(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      released.add(url)
    })
    const view = render(composer(acceptsImages))
    await act(async () => fireEvent(screen.getByRole('textbox'), imagePaste('caption')))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Remove attachment' }))
    )
    await act(async () =>
      prepare.resolve({
        ok: true,
        target: {
          environmentId: 'env-1',
          sessionId: 'session-1',
          expectedEnvironmentPairingRevision: 1
        }
      })
    )
    await act(async () => finishUpload(STORED))
    expect(readNativeChatAttachmentCache(PANE)).toEqual([])
    view.unmount()
    expect([...allocated].filter((url) => !released.has(url))).toEqual([])
  }
)

it('starts no upload when the composer closes before image presence is known', async () => {
  mocks.state.owner = { kind: 'local' }
  mocks.save.mockClear()
  const presence = Promise.withResolvers<boolean>()
  installPreloadApi({
    saveClipboardImageAsTempFile: mocks.save,
    readClipboardText: async () => '',
    readClipboardFilePaths: async () => [],
    clipboardHasImage: () => presence.promise
  })
  const handle = createRef<NativeChatComposerHandle>()
  const view = render(composer(true, handle))
  await act(async () => handle.current?.pasteFromClipboard())
  view.unmount()
  await act(async () => presence.resolve(true))
  expect(mocks.save).not.toHaveBeenCalled()
  expect(readNativeChatAttachmentCache(PANE)).toEqual([])
})
