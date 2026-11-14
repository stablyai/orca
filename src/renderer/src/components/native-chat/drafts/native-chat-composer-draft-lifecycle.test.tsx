// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatLaunchDraft } from '@/components/native-chat/drafts/native-chat-launch-prompt'
import type * as DraftHook from './use-native-chat-draft'
import type * as AttachmentsHook from '../attachments/chips/use-native-chat-composer-attachments'
import type * as SendHook from '../composer/submit/use-native-chat-structured-composer-send'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import { createMemoryNativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'
import type * as RemoteRuntimePtyIdModule from '../../../../../shared/remote-runtime/remote-runtime-pty-id'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('../../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => false
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
const mocks = vi.hoisted(() => {
  const launchDrafts: Record<string, NativeChatLaunchDraft> = {}
  return { launchDrafts }
})
vi.mock('../../../store/index', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ nativeChatLaunchDraftByTabId: mocks.launchDrafts }),
    {
      getState: () => ({
        nativeChatLaunchDraftByTabId: mocks.launchDrafts,
        markNativeChatLaunchDraftAdopted: (tabId: string) => {
          const current = mocks.launchDrafts[tabId]
          if (current) {
            mocks.launchDrafts[tabId] = { ...current, adopted: true }
          }
        },
        clearNativeChatLaunchDraft: (tabId: string) => {
          delete mocks.launchDrafts[tabId]
        }
      })
    }
  )
}))

let storage = createMemoryNativeChatComposerDraftStorage()

type ComposerApi = {
  draft: string
  setDraft: ReturnType<typeof DraftHook.useNativeChatDraft>['setDraft']
  attachments: ReturnType<typeof AttachmentsHook.useNativeChatComposerAttachments>
  send: (text: string) => void
}

type Dispatched = { handled: boolean; accepted: boolean; error: string | null }

function heldTransport(hostCommand = false): {
  transport: NativeChatStructuredComposerTransport
  settle: () => Promise<void>
} {
  let resolve: (value: Dispatched) => void = () => {}
  const dispatched = new Promise<Dispatched>((settle) => {
    resolve = settle
  })
  return {
    transport: {
      capturePresentation: () => () => true,
      send: vi.fn(() => true),
      dispatchCommand: vi.fn(() => dispatched),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local',
      sessionId: 'session-test',
      runtimeEnvironmentId: null
    },
    settle: async () => {
      await act(async () => {
        resolve(
          hostCommand
            ? { handled: true, accepted: true, error: null }
            : { handled: false, accepted: false, error: null }
        )
        await dispatched
      })
    }
  }
}

let root: Root | null = null
let host: HTMLElement | null = null

async function mount(element: React.ReactElement): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root?.render(element))
}

async function unmount(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
}

function storedDraft(scopeKey: string): unknown {
  return storage.drafts.get(scopeKey) ?? null
}

const loadedStores: { clearNativeChatComposerDraftsForTests: () => void }[] = []

/** A fresh renderer: module memory is gone, the drafts' storage is not. */
async function loadHooks(): Promise<{
  draftHook: typeof DraftHook
  attachmentsHook: typeof AttachmentsHook
  sendHook: typeof SendHook
}> {
  vi.resetModules()
  const storageModule = await import('./native-chat-composer-draft-storage')
  storageModule.setNativeChatComposerDraftStorageForTests(storage)
  const load = await import('./native-chat-composer-draft-load')
  const reset = await import('./native-chat-draft-reset')
  loadedStores.push(reset)
  await load.hydrateNativeChatComposerDrafts()
  return {
    draftHook: await import('./use-native-chat-draft'),
    attachmentsHook: await import('../attachments/chips/use-native-chat-composer-attachments'),
    sendHook: await import('../composer/submit/use-native-chat-structured-composer-send')
  }
}

function composer(
  hooks: Awaited<ReturnType<typeof loadHooks>>,
  onRender: (api: ComposerApi) => void,
  transport?: NativeChatStructuredComposerTransport
): (props: { scopeKey: string }) => null {
  return function Composer({ scopeKey }) {
    const { draft, setDraft } = hooks.draftHook.useNativeChatDraft(scopeKey, () => false)
    const [, setCaret] = useState(0)
    const attachments = hooks.attachmentsHook.useNativeChatComposerAttachments({
      attachmentScopeKey: scopeKey,
      allowWithoutTarget: true,
      imageReferences: true,
      caret: 0,
      disabled: false,
      isComposing: () => false,
      resolveTarget: () => null,
      textareaRef: { current: null },
      setCaret,
      setDraft: () => {},
      setNotice: () => {}
    })
    const send = hooks.sendHook.useNativeChatStructuredComposerSend({
      agent: 'claude',
      draftScopeKey: scopeKey,
      imageAttachments: attachments.imageAttachments,
      structuredTransport: transport,
      isComposing: () => false,
      clearSkillOrigin: () => {},
      setDraft,
      setCaret
    })
    onRender({ draft, setDraft, attachments, send: (text) => void send(text) })
    return null
  }
}

beforeEach(() => {
  localStorage.clear()
  storage = createMemoryNativeChatComposerDraftStorage()
  mocks.launchDrafts = {}
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  for (const store of loadedStores.splice(0)) {
    store.clearNativeChatComposerDraftsForTests()
  }
})

describe('native-chat composer draft lifecycle', () => {
  it('keeps what was typed in a replacement composer when the old composer’s send settles', async () => {
    const hooks = await loadHooks()
    const held = heldTransport()
    const first: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (first.api = next), held.transport),
        {
          scopeKey: 'tab-1:pane'
        }
      )
    )
    await act(async () => first.api?.setDraft('sent text'))
    await act(async () => first.api?.send('sent text'))
    await unmount()
    const second: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (second.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => second.api?.setDraft('new text'))

    await held.settle()

    expect(second.api?.draft).toBe('new text')
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: 'new text' })
  })
})
