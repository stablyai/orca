// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../shared/tab-types'

type MockAppState = {
  unifiedTabsByWorktree: Record<string, readonly Tab[]>
  groupsByWorktree: Record<string, readonly TabGroup[]>
  runtimeEnvironmentId: string | null
  executionHostId: string
  focusGroup: (worktreeId: string, groupId: string) => void
}

const mocks = vi.hoisted(() => ({
  store: null as null | { setState: (state: Partial<MockAppState>) => void },
  focusGroup: vi.fn(),
  mountsByTabId: new Map<string, number>(),
  unmountsByTabId: new Map<string, number>()
}))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create<MockAppState>(() => ({
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    runtimeEnvironmentId: null,
    executionHostId: 'local',
    focusGroup: mocks.focusGroup
  }))
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: MockAppState) => state.runtimeEnvironmentId,
  getExecutionHostIdForWorktree: (state: MockAppState) => state.executionHostId
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: ({
    activeRuntimeEnvironmentId
  }: {
    activeRuntimeEnvironmentId: string | null
  }) =>
    activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))

vi.mock('./NativeChatView', async () => {
  const { useEffect } = await import('react')
  return {
    default: function MockNativeChatView({
      tabId,
      isVisible
    }: {
      tabId: string
      isVisible: boolean
    }) {
      useEffect(() => {
        mocks.mountsByTabId.set(tabId, (mocks.mountsByTabId.get(tabId) ?? 0) + 1)
        return () => {
          mocks.unmountsByTabId.set(tabId, (mocks.unmountsByTabId.get(tabId) ?? 0) + 1)
        }
      }, [tabId])
      return (
        <span
          data-chat-tab-id={tabId}
          data-chat-visible={String(isVisible)}
          data-native-chat-working="true"
        />
      )
    }
  }
})

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'

const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'
const FIRST_TAB_ID = 'structured-agent-session-session-1'
const SECOND_TAB_ID = 'structured-agent-session-session-2'

describe('StructuredAgentSessionPaneOverlayLayer', () => {
  beforeEach(() => {
    mocks.focusGroup.mockClear()
    mocks.mountsByTabId.clear()
    mocks.unmountsByTabId.clear()
    mocks.store?.setState(createState(FIRST_TAB_ID))
  })

  afterEach(cleanup)

  it('keeps materialized chat surfaces mounted while activation only swaps visibility', () => {
    const view = render(
      <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKTREE_ID} isWorktreeActive />
    )
    const firstBefore = chatSurface(view.container, FIRST_TAB_ID)
    const secondBefore = chatSurface(view.container, SECOND_TAB_ID)

    expect(firstBefore.dataset.chatVisible).toBe('true')
    expect(secondBefore.dataset.chatVisible).toBe('false')
    expect(mocks.mountsByTabId).toEqual(
      new Map([
        [FIRST_TAB_ID, 1],
        [SECOND_TAB_ID, 1]
      ])
    )

    act(() => {
      mocks.store?.setState({
        groupsByWorktree: {
          [WORKTREE_ID]: [createGroup(SECOND_TAB_ID)]
        }
      })
    })

    const firstAfter = chatSurface(view.container, FIRST_TAB_ID)
    const secondAfter = chatSurface(view.container, SECOND_TAB_ID)
    expect(firstAfter).toBe(firstBefore)
    expect(secondAfter).toBe(secondBefore)
    expect(firstAfter.dataset.chatVisible).toBe('false')
    expect(secondAfter.dataset.chatVisible).toBe('true')
    expect(mocks.mountsByTabId.get(FIRST_TAB_ID)).toBe(1)
    expect(mocks.mountsByTabId.get(SECOND_TAB_ID)).toBe(1)
    expect(mocks.unmountsByTabId.size).toBe(0)
  })

  it('routes overlay interaction back to the owning split group', () => {
    const view = render(
      <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKTREE_ID} isWorktreeActive />
    )
    const slot = view.container.querySelector<HTMLElement>(
      `[data-structured-agent-session-overlay-tab-id="${FIRST_TAB_ID}"]`
    )

    expect(slot).not.toBeNull()
    fireEvent.pointerDown(slot!)
    expect(mocks.focusGroup).toHaveBeenCalledWith(WORKTREE_ID, GROUP_ID)
  })

  it('keeps the base z-layer overridable by the working-chat stylesheet rule', () => {
    const view = render(
      <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKTREE_ID} isWorktreeActive />
    )
    const slot = view.container.querySelector<HTMLElement>(
      `[data-structured-agent-session-overlay-tab-id="${FIRST_TAB_ID}"]`
    )

    expect(slot).not.toBeNull()
    expect(slot?.classList.contains('native-chat-pane-shell')).toBe(true)
    expect(slot?.classList.contains('z-10')).toBe(true)
    expect(slot?.style.zIndex).toBe('')
    expect(slot?.querySelector('[data-native-chat-working="true"]')).not.toBeNull()
  })
})

function createState(activeTabId: string): MockAppState {
  return {
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        structuredTab(FIRST_TAB_ID, 'session-1', 0),
        structuredTab(SECOND_TAB_ID, 'session-2', 1)
      ]
    },
    groupsByWorktree: { [WORKTREE_ID]: [createGroup(activeTabId)] },
    runtimeEnvironmentId: null,
    executionHostId: 'local',
    focusGroup: mocks.focusGroup
  }
}

function createGroup(activeTabId: string): TabGroup {
  return {
    id: GROUP_ID,
    worktreeId: WORKTREE_ID,
    activeTabId,
    tabOrder: [FIRST_TAB_ID, SECOND_TAB_ID]
  }
}

function structuredTab(id: string, sessionId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: sessionId,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function chatSurface(container: HTMLElement, tabId: string): HTMLElement {
  const surface = container.querySelector<HTMLElement>(`[data-chat-tab-id="${tabId}"]`)
  if (!surface) {
    throw new Error(`missing structured chat surface ${tabId}`)
  }
  return surface
}
