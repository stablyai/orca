// @vitest-environment happy-dom

// A screenshot pasted into a chat on a paired server is still uploading when an agent prompt card
// replaces the composer. The real composer, attachment and paste hooks keep the upload, and Send
// waits for it, whenever the composer comes back; a rich-text paste's image is owed from the start.

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClipboardEventLike } from './native-chat-clipboard-payload'

type FieldProps = {
  onPaste?: (event: ClipboardEventLike) => void
  imageAttachments?: { path: string; pending?: boolean }[]
  sendButtonDisabled?: boolean
}

const mocks = vi.hoisted(() => {
  const state: { fieldProps: FieldProps | null } = { fieldProps: null }
  return { state, prepare: vi.fn(), save: vi.fn() }
})

vi.mock('../../store', () => {
  const state = {
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
vi.mock('@/lib/agent-paste-draft', () => ({ getSettingsForAgentTabRuntimeOwner: () => ({}) }))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatPickerOpened: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))
vi.mock('./NativeChatComposerField', () => ({
  NativeChatComposerField: (props: FieldProps) => {
    mocks.state.fieldProps = props
    return <div data-testid="native-chat-composer-field" />
  }
}))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))
vi.mock('./use-native-chat-external-attachments', () => ({
  useNativeChatExternalAttachments: () => ({
    attachExternalPaths: vi.fn(),
    resolveAttachmentOwner: () => ({
      kind: 'runtime-session',
      environmentId: 'env-1',
      pairingRevision: 1,
      sessionId: 'session-1'
    })
  })
}))
vi.mock('./native-chat-attachment-upload', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  prepareNativeChatSessionAttachmentUpload: mocks.prepare
}))

import { NativeChatComposer } from './NativeChatComposer'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

const PANE = 'tab-1::session-1'
const STORED = '/srv/agent-session-attachments/0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01/orca-paste.png'

function composer(): React.JSX.Element {
  return (
    <NativeChatComposer
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

function imagePaste(text?: string): ClipboardEventLike {
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
  cleanup()
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
    await act(async () => mocks.state.fieldProps?.onPaste?.(imagePaste()))
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
    await act(async () => mocks.state.fieldProps?.onPaste?.(imagePaste()))
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
    await act(async () => mocks.state.fieldProps?.onPaste?.(imagePaste('caption')))

    // The text is in; the image is not yet anywhere, but it is owed to this message.
    expect(mocks.state.fieldProps?.sendButtonDisabled).toBe(true)
  })

  it("shows a rich-text paste's image once the server answers, even in a composer that came back", async () => {
    const prepared = Promise.withResolvers<unknown>()
    mocks.prepare.mockReturnValue(prepared.promise)
    const finishUpload = holdUpload()
    writeNativeChatDraftCache(PANE, 'look at this caption')
    const first = render(composer())
    await act(async () => mocks.state.fieldProps?.onPaste?.(imagePaste('caption')))
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
