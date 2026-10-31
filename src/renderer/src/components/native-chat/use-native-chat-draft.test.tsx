// @vitest-environment happy-dom
import { currentDraftScope } from './native-chat-launch-draft-source'

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  nativeChatLaunchPromptDraftScopeKey,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from './native-chat-composer-draft-store'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { useNativeChatDraft } from './use-native-chat-draft'

afterEach(() => clearNativeChatComposerDraftsForTests())

const scopeKey = structuredAgentSessionDraftScopeKey('session-1')
const body = structuredAgentSessionSendBody('look at this', [
  { path: '/local/a.png', previewUri: '/local/a.png' }
])

function renderDraft(): {
  composing: { current: boolean }
  result: { current: ReturnType<typeof useNativeChatDraft> }
} {
  const composing = { current: false }
  const { result } = renderHook(() => useNativeChatDraft(scopeKey, () => composing.current))
  return { composing, result }
}

it('shows a message returned during a composition once the composition updates', () => {
  const { composing, result } = renderDraft()
  act(() => result.current.setDraft('typed'))
  composing.current = true
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  expect(result.current.draft).toBe('typed')
  act(() => result.current.setDraft((shown) => `${shown}가`))
  expect(readNativeChatDraftCache(scopeKey)).toBe('typed가\n\nlook at this')
})

it('does not add a message again when its return is retried during a composition', () => {
  const { composing, result } = renderDraft()
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  act(() => result.current.setDraft((shown) => `${shown} and more`))
  composing.current = true
  act(() => {
    handBackStructuredAgentSessionMessage('session-1', 'm1', body)
  })
  act(() => result.current.setDraft((shown) => `${shown}가`))
  expect(readNativeChatDraftCache(scopeKey)).toBe('look at this and more가')
})

import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/store-test-helpers'
import { recheckNativeChatComposerDraftImagesIn } from './native-chat-composer-draft-image-check'
import { restoredImageChecks } from './native-chat-composer-draft-memory'
import {
  registerNativeChatComposerDestination,
  nativeChatComposerScopeDestination,
  nativeChatComposerDestination
} from './native-chat-composer-destination'
import { insertNativeChatComposerDraftText } from './native-chat-composer-draft-insertion'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

it('mounted IME, caret and file checks follow a rich collision; ordinary deletion fences checks', async () => {
  const original = useAppStore.getState()
  const from = nativeChatLaunchPromptDraftScopeKey('repo::/x', 'claude', 'ssh:old')
  const to = nativeChatLaunchPromptDraftScopeKey('repo::/x', 'claude', 'ssh:new')
  const control = nativeChatLaunchPromptDraftScopeKey('other::/x', 'claude', 'local')
  const check = Promise.withResolvers<boolean>()
  const deadCheck = Promise.withResolvers<boolean>()
  const pathExists = vi
    .fn()
    .mockReturnValueOnce(check.promise)
    .mockReturnValueOnce(deadCheck.promise)
  const previousApi = window.api
  Object.assign(window, { api: { fs: { pathExists } } })
  let composing = false
  let controlRenders = 0
  const source = renderHook(() => useNativeChatDraft(from, () => composing))
  const target = renderHook(() => useNativeChatDraft(to, () => false))
  const unrelated = renderHook(() => {
    controlRenders++
    return useNativeChatDraft(control, () => false)
  })
  let caret = 0
  const root = document.createElement('div')
  const handle: NativeChatComposerHandle = {
    focus: () => true,
    acceptsText: () => true,
    contains: () => true,
    appendText: () => {},
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    insertTypedText: (text) => {
      source.result.current.setDraft(
        (previous) => previous.slice(0, caret) + text + previous.slice(caret)
      )
      caret += text.length
      return true
    }
  }
  const unregister = registerNativeChatComposerDestination(root, { current: handle }, true, from)
  try {
    act(() => {
      source.result.current.setDraft('source')
      target.result.current.setDraft('target')
      updateNativeChatComposerDraft(
        from,
        { images: [{ id: 'image', path: '/uploads/image.png' }] },
        'immediate'
      )
      recheckNativeChatComposerDraftImagesIn('/uploads')
    })
    expect(pathExists).toHaveBeenCalledOnce()
    composing = true
    const renderedBefore = controlRenders
    const setter = source.result.current.setDraft
    act(() => {
      const events = [{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }]
      useAppStore.setState({
        repos: [{ ...TEST_REPO, id: 'repo', connectionId: 'new', executionHostId: 'ssh:new' }]
      })
      useAppStore.getState().recordSshRepoReadoptions(events)
    })
    expect(source.result.current.draft).toBe('source')
    expect(target.result.current.draft).toBe('target\n\nsource')
    act(() => setter((shown) => `${shown}가`))
    composing = false
    act(() => source.result.current.flushDraftAppends())
    expect(target.result.current.draft).toBe('target\n\nsource가')
    expect(nativeChatComposerScopeDestination(to)).toBe(handle)
    act(() => insertNativeChatComposerDraftText(to, 'at caret '))
    expect(target.result.current.draft).toBe('at caret target\n\nsource가')
    expect(caret).toBe(9)
    expect(controlRenders).toBe(renderedBefore)
    await act(async () => {
      check.resolve(false)
      await check.promise
    })
    expect(readNativeChatComposerDraft(to).images[0].unavailableName).toBe('image.png')
    expect(restoredImageChecks.has(currentDraftScope(to))).toBe(false)
    act(() => {
      updateNativeChatComposerDraft(
        from,
        { images: [{ id: 'next', path: '/uploads/next.png' }] },
        'immediate'
      )
      recheckNativeChatComposerDraftImagesIn('/uploads')
    })
    expect(pathExists).toHaveBeenCalledTimes(2)
    act(() => deleteNativeChatComposerDraft(to))
    expect(restoredImageChecks.has(currentDraftScope(to))).toBe(false)
    expect(nativeChatComposerScopeDestination(to)).toBe(handle)
    expect(nativeChatComposerDestination(root, null)).toBe(handle)
    const successor = nativeChatLaunchPromptDraftScopeKey('repo::/x', 'claude', 'ssh:new')
    updateNativeChatComposerDraft(
      successor,
      { text: 'fresh', images: [{ id: 'next', path: '/uploads/next.png' }] },
      'immediate'
    )
    const fresh = readNativeChatComposerDraft(successor)
    await act(async () => {
      deadCheck.resolve(false)
      await deadCheck.promise
    })
    expect(readNativeChatComposerDraft(successor)).toBe(fresh)
    expect(readNativeChatComposerDraft(to).text).toBe('fresh')
  } finally {
    unregister()
    source.unmount()
    target.unmount()
    unrelated.unmount()
    Object.assign(window, { api: previousApi })
    useAppStore.setState(original, true)
  }
})
