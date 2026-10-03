// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type * as DraftHook from './use-native-chat-draft'
import type * as AttachmentsHook from './use-native-chat-composer-attachments'
import type * as SendHook from './use-native-chat-structured-composer-send'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({ isRemoteRuntimePtyId: () => false }))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))
const mocks = vi.hoisted(() => {
  const launchDrafts: Record<string, NativeChatLaunchDraft> = {}
  return { launchDrafts }
})
vi.mock('../../store', () => ({
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

const DRAFT_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'

type ComposerApi = {
  draft: string
  setDraft: ReturnType<typeof DraftHook.useNativeChatDraft>['setDraft']
  attachments: ReturnType<typeof AttachmentsHook.useNativeChatComposerAttachments>
  send: (text: string) => void
}

type Dispatched = { handled: boolean; accepted: boolean; error: string | null }

/** A transport whose next send settles only when the test says so. */
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
  const raw = localStorage.getItem(`${DRAFT_KEY_PREFIX}${encodeURIComponent(scopeKey)}`)
  return raw === null ? null : JSON.parse(raw)
}

/** A fresh renderer: module memory is gone, localStorage is not. */
async function loadHooks(): Promise<{
  draftHook: typeof DraftHook
  attachmentsHook: typeof AttachmentsHook
  sendHook: typeof SendHook
}> {
  vi.resetModules()
  return {
    draftHook: await import('./use-native-chat-draft'),
    attachmentsHook: await import('./use-native-chat-composer-attachments'),
    sendHook: await import('./use-native-chat-structured-composer-send')
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
      clearImageAttachments: attachments.clearImageAttachments,
      clearSkillOrigin: () => {},
      setHistory: () => {},
      setDraft,
      setCaret
    })
    onRender({ draft, setDraft, attachments, send })
    return null
  }
}

beforeEach(() => {
  localStorage.clear()
  mocks.launchDrafts = {}
})

afterEach(async () => {
  await unmount()
  vi.useRealTimers()
  // Writes still deferred land now, not in the next test's storage.
  window.dispatchEvent(new Event('pagehide'))
  localStorage.clear()
})

describe('native-chat composer draft lifecycle', () => {
  it('clears the saved draft when a send settles after the composer unmounted', async () => {
    const hooks = await loadHooks()
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          seen.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => {
      seen.api?.setDraft('/goal ship it')
      hooks.attachmentsHook.appendNativeChatAttachmentCache('tab-1:pane', [
        { id: 'i1', path: '/tmp/orca-paste-1.png' }
      ])
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '/goal ship it' })
    const held = seen.api

    // A question prompt replaces the composer while the host accepts the command.
    await unmount()
    held?.setDraft('')
    held?.attachments.clearImageAttachments()

    expect(storedDraft('tab-1:pane')).toBeNull()
    const reloaded = await loadHooks()
    const restored: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(reloaded, (next) => {
          restored.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(restored.api).toMatchObject({ draft: '', attachments: { imageAttachments: [] } })
  })

  it('clears a saved sent draft when its send settles after the composer unmounted', async () => {
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
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toMatchObject({ text: 'sent text' })
    await act(async () => first.api?.send('sent text'))
    await unmount()

    await held.settle()

    expect(storedDraft('tab-1:pane')).toBeNull()
  })

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

  it('keeps an image pasted while a host command was on its way', async () => {
    const hooks = await loadHooks()
    const held = heldTransport(true)
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (seen.api = next), held.transport),
        {
          scopeKey: 'tab-1:pane'
        }
      )
    )
    await act(async () => seen.api?.setDraft('/compact'))
    await act(async () => seen.api?.send('/compact'))
    const pending: { id?: string | null } = {}
    await act(async () => {
      pending.id = seen.api?.attachments.beginPendingImageAttachment('data:image/png;base64,AA')
    })
    expect(pending.id).toBeTruthy()

    await held.settle()
    await act(async () =>
      seen.api?.attachments.resolvePendingImageAttachment(pending.id ?? '', '/repo/shot.png')
    )

    expect(seen.api?.draft).toBe('')
    expect(seen.api?.attachments.imageAttachments.map(({ path }) => path)).toEqual([
      '/repo/shot.png'
    ])
  })

  it('keeps a shown composer’s pasted image when many other drafts are written', async () => {
    const hooks = await loadHooks()
    const drafts = await import('./native-chat-draft-cache')
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (seen.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () =>
      hooks.attachmentsHook.appendNativeChatAttachmentCache('tab-1:pane', [
        { id: 'p1', path: '/tmp/orca-paste-1-abc.png' }
      ])
    )
    for (let index = 0; index < 128; index += 1) {
      drafts.writeNativeChatDraftCache(`tab-${index + 2}:pane`, `draft ${index}`)
    }

    await act(async () => seen.api?.setDraft('typing'))

    expect(seen.api?.attachments.imageAttachments.map(({ path }) => path)).toEqual([
      '/tmp/orca-paste-1-abc.png'
    ])
  })

  it('leaves nothing saved when a send clears a draft whose typing was still deferred', async () => {
    vi.useFakeTimers()
    const hooks = await loadHooks()
    const seen: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          seen.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => {
      seen.api?.attachments.attachResolvedPaths(['/repo/a.png'])
    })
    await act(async () => {
      seen.api?.setDraft('hello')
    })
    await act(async () => {
      seen.api?.setDraft('')
      seen.api?.attachments.clearImageAttachments()
    })
    expect(storedDraft('tab-1:pane')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(storedDraft('tab-1:pane')).toBeNull()
  })

  it('does not bring back a sent image when a paste from a replaced composer is dropped late', async () => {
    const hooks = await loadHooks()
    const first: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          first.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => first.api?.attachments.attachResolvedPaths(['/repo/x.png']))
    const pending: { id?: string | null } = {}
    await act(async () => {
      pending.id = first.api?.attachments.beginPendingImageAttachment('data:image/png;base64,AA')
    })
    expect(pending.id).toBeTruthy()
    const stale = first.api
    // The composer is replaced while the paste is still being saved.
    await unmount()
    const second: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          second.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(second.api?.attachments.imageAttachments.map(({ path }) => path)).toEqual([
      '/repo/x.png'
    ])
    await act(async () => second.api?.attachments.clearImageAttachments())
    await unmount()

    // The paste's save fails late in the replaced composer, which drops its placeholder.
    stale?.attachments.dropPendingImageAttachment(pending.id ?? '')

    expect(storedDraft('tab-1:pane')).toBeNull()
    const third: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => {
          third.api = next
        }),
        { scopeKey: 'tab-1:pane' }
      )
    )
    expect(third.api?.attachments.imageAttachments).toEqual([])
  })

  it('adds a late image from a replaced composer to the current draft, not to its old one', async () => {
    const hooks = await loadHooks()
    const first: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (first.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => first.api?.attachments.attachResolvedPaths(['/repo/x.png']))
    const stale = first.api
    await unmount()
    const second: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (second.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => second.api?.attachments.clearImageAttachments())
    await unmount()

    // An SSH upload started in the first composer finishes now.
    stale?.attachments.attachResolvedPaths(['/repo/late.png'])

    expect(storedDraft('tab-1:pane')).toMatchObject({ images: [{ path: '/repo/late.png' }] })
  })

  it('inserts a late file reference from a replaced composer into the current text', async () => {
    const hooks = await loadHooks()
    const first: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (first.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => first.api?.setDraft('already sent text'))
    const stale = first.api
    await unmount()
    const second: { api?: ComposerApi } = {}
    await mount(
      createElement(
        composer(hooks, (next) => (second.api = next)),
        { scopeKey: 'tab-1:pane' }
      )
    )
    await act(async () => second.api?.setDraft(''))
    await unmount()

    stale?.setDraft((previous) => `${previous}@late.txt `)
    window.dispatchEvent(new Event('pagehide'))

    expect(storedDraft('tab-1:pane')).toMatchObject({ text: '@late.txt ' })
  })

  it('does not bring back an untouched launch link after a reload, when no seed is left to replace it', async () => {
    const link = 'https://github.com/o/r/issues/12'
    const seed: NativeChatLaunchDraft = {
      tabId: 'tab-1',
      agent: 'claude',
      text: link,
      createdAt: 1
    }
    mocks.launchDrafts['tab-1'] = seed
    const hooks = await loadHooks()
    const { useNativeChatLaunchDraftAdoption } =
      await import('./use-native-chat-launch-draft-adoption')
    let shown = ''
    function Composer({ launchDraft }: { launchDraft: NativeChatLaunchDraft }): null {
      const { draft, setDraft } = hooks.draftHook.useNativeChatDraft('tab-1:leaf', () => false)
      useNativeChatLaunchDraftAdoption({
        terminalTabId: 'tab-1',
        agent: 'claude',
        launchDraft,
        launchDraftResolved: false,
        draft,
        setDraft,
        setCaret: () => {},
        ownsTabWideLaunchDraft: true
      })
      shown = draft
      return null
    }
    await mount(createElement(Composer, { launchDraft: seed }))
    expect(shown).toBe(link)
    window.dispatchEvent(new Event('pagehide'))
    await unmount()

    mocks.launchDrafts = {}
    const reloaded = await loadHooks()
    const restored: { draft?: string } = {}
    function Reloaded(): null {
      restored.draft = reloaded.draftHook.useNativeChatDraft('tab-1:leaf', () => false).draft
      return null
    }
    await mount(createElement(Reloaded))
    expect(restored.draft).toBe('')
  })
})
