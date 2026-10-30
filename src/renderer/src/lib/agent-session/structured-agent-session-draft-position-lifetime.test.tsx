// @vitest-environment happy-dom
import {
  main,
  rpc,
  storage,
  POSITION_TEXT,
  openPositionDraft,
  PositionField,
  positionInventory,
  startPositionMain
} from './structured-agent-session-draft-position.test-fixture'
import * as draftCache from '@/components/native-chat/native-chat-draft-cache'
import * as draftMemory from '@/components/native-chat/native-chat-composer-draft-memory'
import { seedStructuredAgentLaunchDraft } from '../structured-agent-session-launch-draft'
import { publishedLayoutsOf } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { render, within } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import type { NativeChatComposerInput } from '@/components/native-chat/native-chat-composer-input'
import { promptEditor } from '@/components/native-chat/native-chat-prompt-editor.test-support'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getStructuredLaunchStateBySessionId } from './launch/structured-agent-session-launch-registry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { setNativeChatComposerDraftStorageForTests } from '@/components/native-chat/native-chat-composer-draft-storage'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { openStructuredAgentSessionProvisionalTab } from '../structured-agent-session-launch-surface'

it
  .runIf(ORCA_LAYOUT_OWNER_IS_MAIN)
  .each(['discarded-inventory', 'refused-close', 'excluded-close'] as const)(
  'keeps fresh END on the actually drawn destination after %s, then retires on accepted removal',
  async (schedule) => {
    const handle = openPositionDraft(),
      scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await main.settle()
    await vi.waitFor(() =>
      expect(rpc.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(true)
    )
    await handle.finish()
    applyStructuredSessionTabSnapshots([positionInventory(handle.sessionId, 1)])
    const original = readNativeChatComposerDraft(scope)
    if (schedule === 'discarded-inventory') {
      applyStructuredSessionTabSnapshots([positionInventory(null, 2)])
    } else {
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'closeTabs'
          ? schedule === 'refused-close'
            ? { ok: false, code: 'tab_not_found' }
            : { ok: true, result: { closed: [], refused: [] } }
          : 'apply'
      )
      useAppStore.getState().closeUnifiedTab(handle.tab.id)
      await main.settle()
      layoutApplyTestTransport.answerWith('apply')
    }
    expect(useAppStore.getState().getTab(handle.tab.id)?.entityId).toBe(handle.sessionId)
    const input = createRef<NativeChatComposerInput>()
    const mount = () =>
      render(
        <StrictMode>
          <PositionField scope={scope} tabId={handle.tab.id} input={input} />
        </StrictMode>
      )
    const first = mount()
    expect(input.current!.selectionStart).toBe(POSITION_TEXT.length)
    first.unmount()
    useAppStore.getState().closeUnifiedTab(handle.tab.id)
    await main.settle()
    expect(useAppStore.getState().getTab(handle.tab.id)).toBeNull()
    openStructuredAgentSessionProvisionalTab({
      worktreeId: 'wt-1',
      executionHostId: 'local',
      sessionId: handle.sessionId,
      agent: 'claude'
    })
    await main.settle()
    const reopened = mount()
    expect(input.current!.selectionStart).toBe(0)
    expect(input.current!.value).toBe(POSITION_TEXT)
    expect(readNativeChatComposerDraft(scope)).toBe(original)
    reopened.unmount()
  }
)

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN).each(['fresh', 'restored', 'newer-seed'] as const)(
  'settles actual no-surface open without retiring another occurrence: %s',
  async (kind) => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    const id = `claude_${uuid.replaceAll('-', '_')}`,
      scope = structuredAgentSessionDraftScopeKey(id)
    if (kind === 'restored') {
      await storage.write(scope, {
        text: POSITION_TEXT,
        document: promptTextContent(POSITION_TEXT),
        images: [],
        savedAt: 1
      })
      clearNativeChatComposerDraftsForTests()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
    }
    layoutApplyTestTransport.answerWith('pending')
    const handle = openPositionDraft()
    await vi.waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBeGreaterThan(0))
    const original = readNativeChatComposerDraft(scope)
    if (kind === 'newer-seed') {
      updateNativeChatComposerDraft(scope, { text: '', document: undefined }, 'immediate')
      const state = getStructuredLaunchStateBySessionId(id)
      if (!state) {
        throw new Error('Expected live initializer owner')
      }
      seedStructuredAgentLaunchDraft(state, {
        requestId: 'newer-accepted-seed',
        prompt: POSITION_TEXT,
        promptDelivery: 'draft'
      })
    }
    layoutApplyTestTransport.answerPending({ ok: false, code: 'tab_not_found' })
    layoutApplyTestTransport.answerWith('apply')
    await handle.finish()
    expect(useAppStore.getState().getTab(handle.tab.id)).toBeNull()
    const input = createRef<NativeChatComposerInput>()
    const mount = () =>
      render(
        <StrictMode>
          <PositionField scope={scope} tabId={handle.tab.id} input={input} />
        </StrictMode>
      )
    const first = mount()
    expect(input.current!.value).toBe(POSITION_TEXT)
    expect(input.current!.selectionStart).toBe(kind === 'newer-seed' ? POSITION_TEXT.length : 0)
    if (kind !== 'newer-seed') {
      expect(readNativeChatComposerDraft(scope)).toBe(original)
    }
    first.unmount()
    const second = mount()
    expect(input.current!.selectionStart).toBe(0)
    second.unmount()
  }
)

it.each(['remove', 'replace', 'final-retained'] as const)(
  'retires at actual final accepted topology, preserving ordinary bytes: %s',
  async (kind) => {
    const handle = openPositionDraft(),
      scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await handle.finish()
    applyStructuredSessionTabSnapshots([positionInventory(handle.sessionId, 1)])
    const original = readNativeChatComposerDraft(scope)
    const observedInput = createRef<NativeChatComposerInput>()
    let observed: ReturnType<typeof render> | undefined
    const unsubscribe = useAppStore.subscribe((state) => {
      if (
        kind !== 'final-retained' &&
        state.getTab(handle.tab.id)?.entityId !== handle.sessionId &&
        !observed
      ) {
        observed = render(
          <PositionField scope={scope} tabId={handle.tab.id} input={observedInput} />
        )
        expect(observedInput.current!.selectionStart).toBe(0)
      }
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const model = layoutApplyTestTransport.mainModel
      if (!model) {
        throw new Error('Expected main model')
      }
      const layout = publishedLayoutsOf(model)['wt-1']!
      if (kind === 'replace') {
        const changed = structuredClone(layout)
        changed.tabs.find((tab) => tab.id === handle.tab.id)!.entityId = 'replacement-session'
        layoutApplyTestTransport.emitFrame({ type: 'workspace', key: 'wt-1', layout: changed })
      } else if (kind === 'remove') {
        const changed = {
          ...layout,
          tabs: layout.tabs.filter((tab) => tab.id !== handle.tab.id),
          groups: layout.groups.map((group) => ({
            ...group,
            tabIds: group.tabIds.filter((id) => id !== handle.tab.id)
          }))
        }
        layoutApplyTestTransport.emitFrame({ type: 'workspace', key: 'wt-1', layout: changed })
      } else {
        // Proposed removal and restoration are one accepted final batch.
        layoutApplyTestTransport.emitFrame({
          type: 'workspace',
          key: 'wt-1',
          layout: { ...layout, tabs: [], groups: [] }
        })
        layoutApplyTestTransport.emitFrame({ type: 'workspace', key: 'wt-1', layout })
      }
      await main.settle()
    } else {
      if (kind === 'replace') {
        const inventory = positionInventory(handle.sessionId, 2)
        inventory.tabs = inventory.tabs.map((tab) =>
          tab.type === 'agent-session' ? { ...tab, sessionId: 'replacement-session' } : tab
        )
        applyStructuredSessionTabSnapshots([inventory])
      } else {
        applyStructuredSessionTabSnapshots(
          kind === 'remove'
            ? [positionInventory(null, 2)]
            : [positionInventory(null, 2), positionInventory(handle.sessionId, 3)]
        )
      }
    }
    unsubscribe()
    if (kind !== 'final-retained') {
      expect(observedInput.current!.selectionStart).toBe(0)
    }
    observed?.unmount()
    expect(readNativeChatComposerDraft(scope)).toBe(original)
    if (kind !== 'final-retained') {
      // Reopen the retained ordinary conversation through the existing API.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        layoutApplyTestTransport.emitFrame({
          type: 'workspace',
          key: 'wt-1',
          layout: publishedLayoutsOf(layoutApplyTestTransport.mainModel!)['wt-1']!
        })
        await main.settle()
      } else {
        openStructuredAgentSessionProvisionalTab({
          worktreeId: 'wt-1',
          executionHostId: 'local',
          sessionId: handle.sessionId,
          agent: 'claude'
        })
      }
      await main.settle()
    }
    const input = createRef<NativeChatComposerInput>()
    const view = render(
      <StrictMode>
        <PositionField scope={scope} tabId={handle.tab.id} input={input} />
      </StrictMode>
    )
    expect(input.current!.value).toBe(POSITION_TEXT)
    expect(input.current!.selectionStart).toBe(kind === 'final-retained' ? POSITION_TEXT.length : 0)
    expect(promptEditor(within(view.container).getByRole('textbox')).getJSON()).toEqual(
      original.document
    )
    view.unmount()
  }
)

it.each([10, 100])(
  'bounds actual affected-workspace retirement at %i tabs without scanning unrelated drafts',
  async (n) => {
    const handle = openPositionDraft()
    await handle.finish()
    const row = useAppStore.getState().getTab(handle.tab.id)
    if (!row) {
      throw new Error('Expected drawn source')
    }
    main.close()
    const rows = Array.from({ length: n }, (_, i) => ({
      ...row,
      id: `scale-${i}`,
      entityId: `scale-session-${i}`
    }))
    useAppStore.setState({
      unifiedTabsByWorktree: {
        'wt-1': rows,
        unrelated: [{ ...row, id: 'do-not-visit', worktreeId: 'unrelated' }]
      },
      groupsByWorktree: {
        'wt-1': [
          {
            id: row.groupId,
            worktreeId: 'wt-1',
            tabOrder: rows.map((tab) => tab.id),
            activeTabId: rows[0]!.id,
            recentTabIds: []
          }
        ],
        unrelated: []
      }
    })
    await startPositionMain()
    const visits = { before: 0, after: 0, entries: 0, maps: 0, retire: 0, calls: 0 }
    const realRetire = draftCache.retireRemovedNativeChatDraftPositions,
      RealMap = Map,
      mapped = new WeakSet<object>()
    const retire = vi.spyOn(draftMemory, 'retireNativeChatDraftPosition')
    const compare = vi
      .spyOn(draftCache, 'retireRemovedNativeChatDraftPositions')
      .mockImplementation((before, after) => {
        visits.calls++
        if (before === after) {
          realRetire(before, after)
          return
        }
        expect(before.every((tab) => tab.worktreeId === 'wt-1')).toBe(true)
        realRetire(
          new Proxy(before, {
            get(target, key, receiver) {
              if (key === Symbol.iterator) {
                return function* () {
                  for (const tab of target) {
                    visits.before++
                    yield tab
                  }
                }
              }
              // oxlint-disable-next-line anti-slop/no-reflect-get -- Test-only Proxy forwards unmeasured string/symbol keys with the original receiver.
              return Reflect.get(target, key, receiver)
            }
          }),
          new Proxy(after, {
            get(target, key, receiver) {
              if (key === 'map') {
                return (callback: (tab: typeof row, index: number) => unknown) => {
                  const entries = target.map((tab, index) => {
                    visits.after++
                    visits.entries++
                    return callback(tab, index)
                  })
                  mapped.add(entries)
                  return entries
                }
              }
              // oxlint-disable-next-line anti-slop/no-reflect-get -- Test-only Proxy forwards unmeasured string/symbol keys with the original receiver.
              return Reflect.get(target, key, receiver)
            }
          })
        )
      })
    class MeasuredMap<K, V> extends RealMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries)
        if (entries && mapped.has(entries)) {
          visits.maps++
        }
      }
    }
    const measure = async (action: () => void) => {
      Object.assign(visits, { before: 0, after: 0, entries: 0, maps: 0, retire: 0, calls: 0 })
      retire.mockClear()
      globalThis.Map = MeasuredMap
      try {
        action()
        await main.settle()
      } finally {
        globalThis.Map = RealMap
      }
      visits.retire = retire.mock.calls.length
      expect(visits.before).toBeLessThanOrEqual(n)
      expect(visits.after).toBeLessThanOrEqual(n)
      expect(visits.entries).toBe(visits.after)
      expect(visits.maps).toBeLessThanOrEqual(1)
      expect(visits.calls).toBeLessThanOrEqual(1)
      return { ...visits }
    }
    const inventories = (title = 'Chat', omit = false): RuntimeMobileSessionTabsResult => ({
      ...positionInventory(null, 1),
      tabs: omit
        ? []
        : rows.map((tab) => ({
            type: 'agent-session',
            id: tab.id,
            sessionId: tab.entityId,
            agent: 'claude',
            title,
            isActive: false
          }))
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      const layout = publishedLayoutsOf(layoutApplyTestTransport.mainModel!)['wt-1']!
      const emit = (next: typeof layout) =>
        layoutApplyTestTransport.emitFrame({ type: 'workspace', key: 'wt-1', layout: next })
      const identical = await measure(() => emit(layout))
      expect(identical.retire).toBe(0)
      const titled = {
        ...layout,
        tabs: layout.tabs.map((tab) => ({ ...tab, customTitle: 'title' }))
      }
      const titles = await measure(() => emit(titled))
      expect(titles.retire).toBe(0)
      const removed = { ...titled, tabs: [], groups: [] }
      const removal = await measure(() => emit(removed))
      expect(removal).toMatchObject({ before: n, after: 0, maps: 1, retire: n })
      const duplicate = await measure(() => emit(removed))
      expect(duplicate.retire).toBe(0)
    } else {
      let version = 1
      const publish = (snapshot: RuntimeMobileSessionTabsResult) =>
        applyStructuredSessionTabSnapshots([{ ...snapshot, snapshotVersion: version++ }])
      const first = await measure(() => publish(inventories()))
      expect(first.retire).toBe(0)
      const identical = await measure(() => publish(inventories()))
      expect(identical.retire).toBe(0)
      const titles = await measure(() => publish(inventories('title')))
      expect(titles.retire).toBe(0)
      const removal = await measure(() => publish(inventories('title', true)))
      expect(removal).toMatchObject({ before: n, after: 0, maps: 1, retire: n })
      const duplicate = await measure(() => publish(inventories('title', true)))
      expect(duplicate.retire).toBe(0)
    }
    compare.mockRestore()
    retire.mockRestore()
  }
)

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'parks a live fresh destination across group/title changes and cache unpublish until actual attachment',
  async () => {
    const handle = openPositionDraft(),
      scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await handle.finish()
    const original = readNativeChatComposerDraft(scope)
    const layout = publishedLayoutsOf(layoutApplyTestTransport.mainModel!)['wt-1']!
    const moved = {
      ...layout,
      groupLayout: undefined,
      groups: [{ id: 'moved-group', tabIds: layout.tabs.map((tab) => tab.id) }],
      tabs: layout.tabs.map((tab) => ({ ...tab, customTitle: 'renamed' }))
    }
    layoutApplyTestTransport.emitFrame({ type: 'workspace', key: 'wt-1', layout: moved })
    await main.settle()
    expect(useAppStore.getState().getTab(handle.tab.id)?.groupId).toBe('moved-group')
    layoutApplyTestTransport.emitFrame({ type: 'removed', key: 'wt-1' })
    await main.settle()
    expect(useAppStore.getState().getTab(handle.tab.id)?.entityId).toBe(handle.sessionId)
    // ast-grep-ignore: test-no-real-time-wait-tsx -- Attach the still-live destination after the former 1s expiry.
    await new Promise((resolve) => setTimeout(resolve, 1050))
    const input = createRef<NativeChatComposerInput>()
    const view = render(
      <StrictMode>
        <PositionField scope={scope} tabId={handle.tab.id} input={input} />
      </StrictMode>
    )
    expect(input.current!.selectionStart).toBe(POSITION_TEXT.length)
    expect(input.current!.value).toBe(POSITION_TEXT)
    expect(readNativeChatComposerDraft(scope)).toBe(original)
    view.unmount()
  }
)

it.runIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
  'uses one addressed retirement for actual local close and makes a duplicate close inert',
  async () => {
    const handle = openPositionDraft()
    await handle.finish()
    const compare = vi.spyOn(draftCache, 'retireRemovedNativeChatDraftPositions')
    useAppStore.getState().closeUnifiedTab(handle.tab.id)
    expect(compare.mock.calls.map(([before, after]) => [before.length, after.length])).toEqual([
      [1, 0]
    ])
    compare.mockClear()
    expect(useAppStore.getState().closeUnifiedTab(handle.tab.id)).toBeNull()
    expect(compare).not.toHaveBeenCalled()
  }
)
