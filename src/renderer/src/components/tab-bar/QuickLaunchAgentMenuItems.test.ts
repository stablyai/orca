import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactTypes from 'react'
import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'

const {
  launchAgentInNewTabMock,
  mockDetectedIds,
  mockState,
  openSettingsPageMock,
  openSettingsTargetMock,
  refreshDetectedAgentsMock,
  useDetectedAgentsMock
} = vi.hoisted(() => ({
  launchAgentInNewTabMock: vi.fn(),
  mockDetectedIds: ['codex'] as string[],
  mockState: {
    settings: {
      defaultTuiAgent: 'codex'
    },
    repos: [{ id: 'repo-1', connectionId: null as string | null }],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
    },
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {} as Record<string, { id: string; ptyId: string | null }[]>,
    ptyIdsByTabId: {} as Record<string, string[]>,
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  },
  openSettingsPageMock: vi.fn(),
  openSettingsTargetMock: vi.fn(),
  refreshDetectedAgentsMock: vi.fn(),
  useDetectedAgentsMock: vi.fn()
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactTypes>('react')
  return {
    ...actual,
    memo: <T>(component: T) => component,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback
  }
})

vi.mock('lucide-react', () => ({
  Settings: function Settings() {
    return null
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: function DropdownMenuItem() {
    return null
  }
}))

vi.mock('@/lib/agent-catalog', () => ({
  AGENT_CATALOG: [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ],
  AgentIcon: function AgentIcon() {
    return null
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mockState) => unknown) => selector(mockState),
    {
      getState: () => mockState
    }
  )
  return { useAppStore }
})

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: useDetectedAgentsMock
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: launchAgentInNewTabMock
}))

type ReactElementLike = {
  type: unknown
  props?: Record<string, unknown>
}

function getTypeName(type: unknown): string | null {
  if (typeof type === 'string') {
    return type
  }
  if (typeof type === 'function') {
    return type.name
  }
  return null
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'boolean') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child) => visit(child, cb))
    return
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props && 'children' in element.props) {
    visit(element.props.children, cb)
  }
}

function containsText(node: unknown, text: string): boolean {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node).includes(text)
  }
  if (node == null || typeof node === 'boolean') {
    return false
  }
  if (Array.isArray(node)) {
    return node.some((child) => containsText(child, text))
  }
  const element = node as ReactElementLike
  return containsText(element.props?.children, text)
}

function findMenuItemByText(node: unknown, text: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (element) => {
    if (
      found == null &&
      getTypeName(element.type) === 'DropdownMenuItem' &&
      containsText(element.props?.children, text)
    ) {
      found = element
    }
  })
  if (!found) {
    throw new Error(`Menu item not found: ${text}`)
  }
  return found
}

function renderQuickLaunchAgentMenuItems(
  props: {
    onFocusTerminal?: (tabId: string) => void
    onBeforeLaunch?: () => void
    launchSource?: 'sidebar' | 'tab_bar_quick_launch'
  } = {}
): unknown {
  const candidate = QuickLaunchAgentMenuItems as unknown as
    | ((props: Record<string, unknown>) => unknown)
    | { type: (props: Record<string, unknown>) => unknown }
  const Component = typeof candidate === 'function' ? candidate : candidate.type
  return Component({
    worktreeId: 'wt-1',
    groupId: 'group-1',
    onFocusTerminal: props.onFocusTerminal ?? vi.fn(),
    ...(props.onBeforeLaunch ? { onBeforeLaunch: props.onBeforeLaunch } : {}),
    ...(props.launchSource ? { launchSource: props.launchSource } : {})
  })
}

beforeEach(() => {
  mockDetectedIds.splice(0, mockDetectedIds.length, 'codex')
  openSettingsPageMock.mockReset()
  openSettingsTargetMock.mockReset()
  refreshDetectedAgentsMock.mockReset()
  launchAgentInNewTabMock.mockReset()
  useDetectedAgentsMock.mockReset()
  mockState.settings = { defaultTuiAgent: 'codex' }
  mockState.repos = [{ id: 'repo-1', connectionId: null }]
  mockState.worktreesByRepo = { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
  mockState.tabsByWorktree = {}
  mockState.ptyIdsByTabId = {}
  mockState.openSettingsPage = openSettingsPageMock
  mockState.openSettingsTarget = openSettingsTargetMock
  useDetectedAgentsMock.mockImplementation(() => ({
    detectedIds: mockDetectedIds,
    isLoading: false,
    isRefreshing: false,
    refresh: refreshDetectedAgentsMock
  }))
  launchAgentInNewTabMock.mockImplementation(() => {
    mockState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] }
    mockState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
    return {
      tabId: 'tab-1',
      startupPlan: { expectedProcess: 'codex' },
      pasteDraftAfterLaunch: false
    }
  })
})

describe('QuickLaunchAgentMenuItems', () => {
  it('activates the caller hook before launch and forwards sidebar telemetry', () => {
    const order: string[] = []
    launchAgentInNewTabMock.mockImplementationOnce(() => {
      order.push('launch')
      mockState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'pty-1' }] }
      mockState.ptyIdsByTabId = { 'tab-1': ['pty-1'] }
      return {
        tabId: 'tab-1',
        startupPlan: { expectedProcess: 'codex' },
        pasteDraftAfterLaunch: false
      }
    })
    const tree = renderQuickLaunchAgentMenuItems({
      launchSource: 'sidebar',
      onBeforeLaunch: () => order.push('before'),
      onFocusTerminal: () => order.push('focus')
    })

    const codexItem = findMenuItemByText(tree, 'Codex')
    ;(codexItem.props?.onSelect as (() => void) | undefined)?.()

    expect(order).toEqual(['before', 'launch', 'focus'])
    expect(launchAgentInNewTabMock).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      launchSource: 'sidebar'
    })
    expect(mockState.ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
  })

  it('uses the worktree SSH connection when detecting available agents', () => {
    mockState.repos = [{ id: 'repo-1', connectionId: 'ssh-1' }]

    renderQuickLaunchAgentMenuItems()

    expect(useDetectedAgentsMock).toHaveBeenCalledWith('ssh-1')
  })

  it('shows the empty placeholder while keeping Agent settings available', () => {
    mockDetectedIds.splice(0, mockDetectedIds.length)
    const tree = renderQuickLaunchAgentMenuItems()

    expect(findMenuItemByText(tree, 'No agents detected').props?.disabled).toBe(true)

    const settingsItem = findMenuItemByText(tree, 'Agent settings…')
    ;(settingsItem.props?.onSelect as (() => void) | undefined)?.()

    expect(openSettingsTargetMock).toHaveBeenCalledWith({ pane: 'agents', repoId: null })
    expect(openSettingsPageMock).toHaveBeenCalled()
  })
})
