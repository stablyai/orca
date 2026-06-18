import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickLaunchAgentMenuItems, shouldShowLaunchWatchdogTimeout } from './QuickLaunchButton'

const mocks = vi.hoisted(() => ({
  detectedIds: ['codex', 'claude'],
  launchAgentInNewTab: vi.fn(),
  onFocusTerminal: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  storeState: {
    activeWorktreeId: 'wt-1',
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    repos: [{ id: 'repo-1', connectionId: null }],
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1' }]
    },
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
    },
    settings: {
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentLaunchProfiles: [
        {
          id: 'codex:work',
          agentId: 'codex',
          name: 'Work',
          args: '--profile work'
        }
      ]
    }
  }
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    memo: <T>(component: T) => component,
    useCallback: <T>(callback: T) => callback
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.storeState) => unknown): unknown =>
      selector({
        ...mocks.storeState,
        openSettingsPage: mocks.openSettingsPage,
        openSettingsTarget: mocks.openSettingsTarget
      } as typeof mocks.storeState),
    {
      getState: vi.fn(() => mocks.storeState)
    }
  )
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: mocks.detectedIds
  })
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('lucide-react', () => ({
  Settings: function Settings() {
    return null
  }
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: function DropdownMenuItem(props: Record<string, unknown>) {
    return { type: 'DropdownMenuItem', props }
  },
  DropdownMenuSub: function DropdownMenuSub(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSub', props }
  },
  DropdownMenuSubContent: function DropdownMenuSubContent(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSubContent', props }
  },
  DropdownMenuSubTrigger: function DropdownMenuSubTrigger(props: Record<string, unknown>) {
    return { type: 'DropdownMenuSubTrigger', props }
  }
}))

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace('{{value0}}', String(values?.value0 ?? ''))
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findAllByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null) {
      return
    }
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (typeof current === 'string' || typeof current === 'number') {
      return
    }
    const el = current as ReactElementLike
    if (el.type === typeName) {
      results.push(el)
    }
    visit(el.props?.children)
  }
  visit(node)
  return results
}

function collectText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const el = node as ReactElementLike
  return collectText(el.props?.children)
}

describe('shouldShowLaunchWatchdogTimeout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    mocks.launchAgentInNewTab.mockReturnValue({
      tabId: 'tab-1',
      startupPlan: {},
      pasteDraftAfterLaunch: false
    })
  })

  it('does not report slow agent readiness once a PTY exists', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: true
      })
    ).toBe(false)
  })

  it('reports launches where no PTY appeared', () => {
    expect(
      shouldShowLaunchWatchdogTimeout({
        hasPty: false
      })
    ).toBe(true)
  })

  it('groups launch profiles under the built-in agent row and launches selected profiles', () => {
    const QuickLaunch =
      typeof QuickLaunchAgentMenuItems === 'function'
        ? QuickLaunchAgentMenuItems
        : (QuickLaunchAgentMenuItems as { type: typeof QuickLaunchAgentMenuItems }).type
    const tree = expandNode(
      QuickLaunch({
        worktreeId: 'wt-1',
        groupId: 'group-1',
        onFocusTerminal: mocks.onFocusTerminal
      })
    )

    const subTriggers = findAllByType(tree, 'DropdownMenuSubTrigger')
    expect(subTriggers.map((trigger) => collectText(trigger.props.children))).toEqual(['Codex2'])
    const triggerClick = subTriggers[0]?.props.onClick
    if (typeof triggerClick !== 'function') {
      throw new Error('Codex launch-options trigger did not expose click launch')
    }
    triggerClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })
    mocks.launchAgentInNewTab.mockClear()
    mocks.onFocusTerminal.mockClear()

    const visibleMenuLabels = findAllByType(tree, 'DropdownMenuItem').map((item) =>
      collectText(item.props.children)
    )
    expect(visibleMenuLabels).toEqual(['Codex', 'Work', 'Claude', 'Agent settings…'])
    expect(visibleMenuLabels).not.toContain('Codex: Work')

    const workItem = findAllByType(tree, 'DropdownMenuItem').find(
      (item) => collectText(item.props.children) === 'Work'
    )
    if (!workItem) {
      throw new Error('Work profile menu item was not rendered')
    }

    ;(workItem.props.onSelect as () => void)()

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      profileId: 'codex:work',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })
    expect(mocks.onFocusTerminal).toHaveBeenCalledWith('tab-1')
  })
})
