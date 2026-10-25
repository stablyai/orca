import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../shared/tab-types'
import { focusTabGroupInDirection } from './tab-group-directional-focus'

const focusTerminalTabSurface = vi.hoisted(() => vi.fn())
const requestBrowserFocus = vi.hoisted(() => vi.fn())
const requestNativeChatComposerFocus = vi.hoisted(() => vi.fn())
const activateWebRuntimeSessionTab = vi.hoisted(() => vi.fn())
const webRuntime = vi.hoisted(() => {
  const holder: { active: boolean } = { active: false }
  return holder
})
const store = vi.hoisted(() => {
  const holder: { state: Record<string, unknown> } = { state: {} }
  return holder
})

vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', () => ({ requestBrowserFocus }))
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({
  requestNativeChatComposerFocus
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdWithLegacyFallbackUnlessTwin: () => 'env-1'
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: () => webRuntime.active
}))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({ activateWebRuntimeSessionTab }))

function tab(id: string, groupId: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: `${id}-entity`,
    groupId,
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function group(id: string, activeTabId: string): TabGroup {
  return { id, worktreeId: 'wt-1', activeTabId, tabOrder: [activeTabId] }
}

function setupStore(layout: TabGroupLayoutNode, groups: TabGroup[], tabs: Tab[], active: string) {
  const focusGroup = vi.fn()
  const activateTab = vi.fn()
  store.state = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    layoutByWorktree: { 'wt-1': layout },
    activeGroupIdByWorktree: { 'wt-1': active },
    groupsByWorktree: { 'wt-1': groups },
    unifiedTabsByWorktree: { 'wt-1': tabs },
    terminalLayoutsByTabId: { 'right-tab-entity': { activeLeafId: 'leaf-2' } },
    browserTabsByWorktree: { 'wt-1': [{ id: 'web-entity', activePageId: 'page-1' }] },
    focusGroup,
    activateTab
  }
  return { focusGroup, activateTab }
}

const sideBySide: TabGroupLayoutNode = {
  type: 'split',
  direction: 'horizontal',
  first: { type: 'leaf', groupId: 'left' },
  second: { type: 'leaf', groupId: 'right' }
}

describe('focusTabGroupInDirection', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { activeElement: null })
    vi.stubGlobal('HTMLElement', class {})
    webRuntime.active = false
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('focuses the neighbor group, its active tab, and its terminal leaf', () => {
    const { focusGroup, activateTab } = setupStore(
      sideBySide,
      [group('left', 'left-tab'), group('right', 'right-tab')],
      [tab('left-tab', 'left'), tab('right-tab', 'right')],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(true)
    expect(focusGroup).toHaveBeenCalledWith('wt-1', 'right')
    expect(activateTab).toHaveBeenCalledWith('right-tab', {
      worktreeId: 'wt-1',
      preservePreview: true
    })
    expect(focusTerminalTabSurface).toHaveBeenCalledWith('right-tab-entity', 'leaf-2')
  })

  it('activates the terminal on the web runtime like a click when a session is active', () => {
    webRuntime.active = true
    setupStore(
      sideBySide,
      [group('left', 'left-tab'), group('right', 'right-tab')],
      [tab('left-tab', 'left'), tab('right-tab', 'right')],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(true)
    expect(activateWebRuntimeSessionTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'right-tab-entity',
      environmentId: 'env-1'
    })
  })

  it('does nothing at the layout edge', () => {
    const { focusGroup, activateTab } = setupStore(
      sideBySide,
      [group('left', 'left-tab'), group('right', 'right-tab')],
      [tab('left-tab', 'left'), tab('right-tab', 'right')],
      'left'
    )

    expect(focusTabGroupInDirection('left')).toBe(false)
    expect(focusTabGroupInDirection('up')).toBe(false)
    expect(focusGroup).not.toHaveBeenCalled()
    expect(activateTab).not.toHaveBeenCalled()
  })

  it('does nothing with a single group', () => {
    const { focusGroup } = setupStore(
      { type: 'leaf', groupId: 'left' },
      [group('left', 'left-tab')],
      [tab('left-tab', 'left')],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(false)
    expect(focusGroup).not.toHaveBeenCalled()
  })

  it('prefers the most recently focused group when two neighbors share the edge equally', () => {
    const layout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'left' },
      second: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'top' },
        second: { type: 'leaf', groupId: 'bottom' }
      }
    }
    const { focusGroup } = setupStore(
      layout,
      [group('left', 'left-tab'), group('top', 'top-tab'), group('bottom', 'bottom-tab')],
      [
        tab('left-tab', 'left'),
        tab('top-tab', 'top', { lastFocusedAt: 10 }),
        tab('bottom-tab', 'bottom', { lastFocusedAt: 20 })
      ],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(true)
    expect(focusGroup).toHaveBeenCalledWith('wt-1', 'bottom')
  })

  it('hands browser groups to the browser focus request', () => {
    setupStore(
      sideBySide,
      [group('left', 'left-tab'), group('right', 'web')],
      [tab('left-tab', 'left'), tab('web', 'right', { contentType: 'browser' })],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(true)
    expect(requestBrowserFocus).toHaveBeenCalledWith({ pageId: 'page-1', target: 'webview' })
  })

  it('hands structured chat groups to the composer', () => {
    setupStore(
      sideBySide,
      [group('left', 'left-tab'), group('right', 'chat')],
      [tab('left-tab', 'left'), tab('chat', 'right', { contentType: 'agent-session' })],
      'left'
    )

    expect(focusTabGroupInDirection('right')).toBe(true)
    expect(requestNativeChatComposerFocus).toHaveBeenCalledWith('chat')
  })
})
