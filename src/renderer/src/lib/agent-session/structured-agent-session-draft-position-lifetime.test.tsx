// @vitest-environment happy-dom
import {
  main,
  rpc,
  storage,
  POSITION_TEXT,
  openPositionDraft,
  PositionField,
  positionInventory
} from './structured-agent-session-draft-position.test-fixture'

import { seedStructuredAgentLaunchDraft } from './launch/structured-agent-session-launch-draft'
import { publishedLayoutsOf } from '@/runtime/workspace-layout/testing/main-loaded-layout-frames.test-fixture'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

import { render, within } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import type { NativeChatComposerInput } from '@/components/native-chat/composer/editor/native-chat-composer-input'
import { promptEditor } from '@/components/native-chat/composer/editor/native-chat-prompt-editor.test-support'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getStructuredLaunchStateBySessionId } from './launch/structured-agent-session-launch-registry'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import { hydrateNativeChatComposerDrafts } from '@/components/native-chat/drafts/native-chat-composer-draft-load'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { setNativeChatComposerDraftStorageForTests } from '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import { promptTextContent } from '@/components/native-chat/composer/editor/native-chat-prompt-document-text'
import { openStructuredAgentSessionProvisionalTab } from './launch/structured-agent-session-launch-surface'

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
