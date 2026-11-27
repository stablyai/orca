// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type * as BrowserAttachmentFiles from '@/lib/files/drop/browser-attachment-files'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'

// The app store is a small real zustand store holding only the tab map and an unrelated field; the
// jump's activation modules and the browser token store are stand-ins. Staging, draft custody, the
// held-elsewhere record, its live account and the hook's selector run for real.
type TestState = { unifiedTabsByWorktree: Record<string, readonly Tab[]>; unrelated: number }
const reveal = vi.hoisted(() => ({ succeeds: true }))
const store = vi.hoisted(() => {
  const holder: { setState?: (patch: Partial<TestState>) => void } = {}
  return holder
})
vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const initial: TestState = { unifiedTabsByWorktree: {}, unrelated: 0 }
  const useAppStore = create(() => initial)
  store.setState = useAppStore.setState
  return { useAppStore }
})
function setState(patch: Partial<TestState>): void {
  if (!store.setState) {
    throw new Error('the store mock was not loaded')
  }
  store.setState(patch)
}
vi.mock('@/lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionTab: () => true
}))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: () => reveal.succeeds
}))
vi.mock('@/runtime/native-chat/session-ownership/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerForTab: () => 'local',
  structuredAgentSessionTargetForTab: () => ({ kind: 'local' })
}))
vi.mock('@/lib/files/drop/browser-attachment-files', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserAttachmentFiles>()),
  releaseBrowserAttachmentFiles: () => {}
}))

const { nativeChatHeldElsewhereOwnerTabSelector, useNativeChatHeldElsewhereNotice } =
  await import('./use-native-chat-held-elsewhere-notice')
const { resetNativeChatHeldElsewhereForTests } = await import('./native-chat-held-elsewhere-notice')
const { nativeChatBrowserFileRefusal } =
  await import('../../attachments/native-chat-browser-file-refusal')
const {
  adoptNativeChatStagedFile,
  reconcileNativeChatStagedDraft,
  stageNativeChatDraftFile,
  stagedNativeChatFiles
} = await import('../../drafts/native-chat-draft-attachment-staging')
const { structuredAgentSessionDraftScopeKey: scopeOf } =
  await import('../../drafts/native-chat-draft-scope')

beforeEach(() => {
  resetNativeChatHeldElsewhereForTests()
  reveal.succeeds = true
})

const tab = (id: string, worktreeId: string, entityId: string, label = id): Tab => ({
  id,
  worktreeId,
  entityId,
  contentType: 'agent-session',
  label,
  groupId: 'group',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
})

/** A tab map whose top-level key reads are counted: one count per scan of it. */
function countedTabs(tabs: Record<string, readonly Tab[]>) {
  const scans = { count: 0 }
  const map = new Proxy(tabs, {
    ownKeys(target) {
      scans.count += 1
      return Reflect.ownKeys(target)
    }
  })
  return { scans, map }
}

// D12-05. Store writes that leave the tab map as it was cost one comparison: the selector neither
// rescans nor answers with a new value (so nothing re-renders), over 100 such writes.
it('rescans nothing and answers the same tab across unrelated store writes', () => {
  const owner = tab('owner-tab', 'wt-owner', 'owner-session')
  const { scans, map } = countedTabs({
    'wt-owner': [owner],
    'wt-other': [tab('x', 'wt-other', 'x')]
  })
  const select = nativeChatHeldElsewhereOwnerTabSelector('owner-session')

  const answers = Array.from({ length: 100 }, (_, write) => {
    // A new store state each write, as the store makes one; only the unrelated field changed.
    const state: TestState = { unifiedTabsByWorktree: map, unrelated: write }
    return select(state)
  })

  expect(new Set(answers)).toEqual(new Set([owner]))
  expect(scans.count).toBe(1)
})

// The selector stays reactive: a replaced tab map (the owner renamed, or closed) is read again, and a
// different owner gets its own tab.
it('reads a replaced tab map again and follows a new owner', () => {
  const select = nativeChatHeldElsewhereOwnerTabSelector('owner-session')
  const first = tab('owner-tab', 'wt-owner', 'owner-session', 'Old name')
  expect(select({ unifiedTabsByWorktree: { 'wt-owner': [first] } })).toBe(first)
  const renamed = tab('owner-tab', 'wt-owner', 'owner-session', 'New name')
  expect(select({ unifiedTabsByWorktree: { 'wt-owner': [renamed] } })).toBe(renamed)
  expect(select({ unifiedTabsByWorktree: { 'wt-owner': [] } })).toBeNull()

  const other = tab('other-tab', 'wt-other', 'other-session')
  expect(
    nativeChatHeldElsewhereOwnerTabSelector('other-session')({
      unifiedTabsByWorktree: { 'wt-other': [other] }
    })
  ).toBe(other)
  expect(
    nativeChatHeldElsewhereOwnerTabSelector(undefined)({ unifiedTabsByWorktree: {} })
  ).toBeNull()
})

/** `path` staged in chat `sessionId`'s draft, shown as a chip. */
function inDraftOf(sessionId: string, path: string): void {
  const scope = scopeOf(sessionId)
  const images = stagedNativeChatFiles(scope)?.draft?.images ?? []
  stageNativeChatDraftFile(scope, path)
  reconcileNativeChatStagedDraft(scope, {
    text: '',
    images: [...images.filter((image) => image.path !== path), { id: path, path }]
  })
}

// The mounted notice: unrelated store writes render it no further; a renamed owner tab and a custody
// move to another chat each update what it says.
it('renders again only for its owner tab or a custody change', async () => {
  const path = 'blob:hook-owned'
  inDraftOf('hook-owner-a', path)
  nativeChatBrowserFileRefusal([path], 'hook-refusing')
  act(() => {
    setState({
      unifiedTabsByWorktree: {
        'wt-a': [tab('tab-a', 'wt-a', 'hook-owner-a', 'Fix login')],
        'wt-b': [tab('tab-b', 'wt-b', 'hook-owner-b', 'Checkout bug')]
      }
    })
  })
  let renders = 0
  const { result } = renderHook(() => {
    renders += 1
    return useNativeChatHeldElsewhereNotice('hook-refusing')
  })
  expect(result.current?.text).toBe('Not sent — 1 attachment in Fix login')
  const settled = renders
  await act(async () => {
    inDraftOf('unrelated-owner', 'blob:unrelated')
    await Promise.resolve()
  })
  expect(renders).toBe(settled)

  act(() => {
    for (let write = 1; write <= 100; write += 1) {
      setState({ unrelated: write })
    }
  })
  expect(renders).toBe(settled)

  act(() => {
    setState({
      unifiedTabsByWorktree: {
        'wt-a': [tab('tab-a', 'wt-a', 'hook-owner-a', 'Fix login redirect')],
        'wt-b': [tab('tab-b', 'wt-b', 'hook-owner-b', 'Checkout bug')]
      }
    })
  })
  expect(result.current?.text).toBe('Not sent — 1 attachment in Fix login redirect')

  await act(async () => {
    adoptNativeChatStagedFile(
      stagedNativeChatFiles(scopeOf('hook-owner-a'))!,
      path,
      scopeOf('hook-owner-b')
    )
    await Promise.resolve()
  })
  expect(result.current?.text).toBe('Not sent — 1 attachment in Checkout bug')
})

it('keeps both recovery directions when a held sibling is removed', async () => {
  const a = 'blob:mixed-a'
  const b = 'blob:mixed-b'
  inDraftOf('mixed-owner', a)
  inDraftOf('mixed-owner', b)
  nativeChatBrowserFileRefusal([a, b], 'mixed-refusing')
  setState({ unifiedTabsByWorktree: { wt: [tab('mixed', 'wt', 'mixed-owner', 'Owner')] } })
  const { result } = renderHook(() => useNativeChatHeldElsewhereNotice('mixed-refusing'))
  expect(result.current?.text).toBe('Not sent — 2 attachments in Owner')
  expect(result.current?.errorText).toBeUndefined()
  await act(async () => {
    reconcileNativeChatStagedDraft(scopeOf('mixed-owner'), {
      text: '',
      images: [{ id: a, path: a }]
    })
    await Promise.resolve()
  })
  expect(result.current?.text).toContain('Not sent — 1 attachment in Owner')
  expect(result.current?.text).toContain('again')
  expect(result.current?.action?.label).toBe('Open chat')
})

it('shares the tab index and skips unchanged workspace arrays on unrelated tab replacement', () => {
  let visits = 0
  const owner = tab('indexed-owner', 'indexed-wt', 'indexed-session')
  const stable = new Proxy([owner], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) {
        visits += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  const selectA = nativeChatHeldElsewhereOwnerTabSelector('indexed-session')
  const selectB = nativeChatHeldElsewhereOwnerTabSelector('indexed-session')
  const initial = { unifiedTabsByWorktree: { 'indexed-wt': stable } }
  expect(selectA(initial)).toBe(owner)
  expect(selectB(initial)).toBe(owner)
  const baseline = visits
  for (let write = 0; write < 100; write += 1) {
    const state = {
      unifiedTabsByWorktree: {
        'indexed-wt': stable,
        other: [tab(`other-${write}`, 'other', 'other')]
      }
    }
    expect(selectA(state)).toBe(owner)
    expect(selectB(state)).toBe(owner)
  }
  expect(visits).toBe(baseline)
})

it.each([10, 20])(
  'notifies only affected references among %s active accounts across tasks',
  async (count) => {
    const { subscribeToNativeChatStagedOwnership } =
      await import('../../drafts/native-chat-staged-ownership')
    const hits = Array.from({ length: count }, () => 0)
    const stops = hits.map((_hit, index) =>
      subscribeToNativeChatStagedOwnership(() => {
        hits[index] += 1
      }, [`blob:fanout-${count}-${index}`])
    )
    for (let task = 0; task < 4; task += 1) {
      inDraftOf(`fanout-unrelated-${task}`, `blob:fanout-other-${task}`)
      await Promise.resolve()
    }
    expect(hits).toEqual(Array.from({ length: count }, () => 0))
    inDraftOf('fanout-related', `blob:fanout-${count}-0`)
    await Promise.resolve()
    expect(hits).toEqual([1, ...Array.from({ length: count - 1 }, () => 0)])
    stops.forEach((stop) => stop())
  }
)

it('attributes a failed stale action to the owner actually attempted at click time', async () => {
  const { readNativeChatHeldElsewhere } = await import('./native-chat-held-elsewhere-notice')
  const path = 'blob:click-current-owner'
  inDraftOf('click-a', path)
  nativeChatBrowserFileRefusal([path], 'click-refusing')
  setState({
    unifiedTabsByWorktree: {
      a: [tab('a', 'a', 'click-a', 'A')],
      b: [tab('b', 'b', 'click-b', 'B')]
    }
  })
  const { result } = renderHook(() => useNativeChatHeldElsewhereNotice('click-refusing'))
  const staleClick = result.current?.action?.onClick
  await act(async () => {
    adoptNativeChatStagedFile(stagedNativeChatFiles(scopeOf('click-a'))!, path, scopeOf('click-b'))
    await Promise.resolve()
  })
  reveal.succeeds = false
  act(() => staleClick?.())
  expect(readNativeChatHeldElsewhere('click-refusing')?.unreachableOwner).toBe('click-b')
  await act(async () => {
    adoptNativeChatStagedFile(stagedNativeChatFiles(scopeOf('click-b'))!, path, scopeOf('click-a'))
    await Promise.resolve()
  })
  expect(result.current?.text).toBe('Not sent — 1 attachment in A')
  expect(result.current?.action?.label).toBe('Open chat')
})
