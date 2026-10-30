import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'

type MockState = {
  wslMovedProjects: WslMovedProject[]
  worktreesByRepo: Record<string, { id: string }[]>
  folderWorkspaces: { id: string }[]
  unifiedTabsByWorktree: Record<string, Partial<Tab>[]>
  activeWorktreeId: string | null
  activeGroupIdByWorktree: Record<string, string>
  groupsByWorktree: Record<string, { id: string; activeTabId: string | null }[]>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))
vi.mock('@/lib/wsl-moved-chat-activation', () => ({ activateWslMovedWorkspace: vi.fn() }))
vi.mock('@/lib/wsl-moved-project-use-here', () => ({ bringWslMovedProjectBack: vi.fn() }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

const { default: WslMovedProjectsSection } = await import('./WslMovedProjectsSection')
const { TooltipProvider } = await import('@/components/ui/tooltip')

// The app shell provides the tooltip context the sidebar renders in.
const render = (): string =>
  renderToStaticMarkup(
    <TooltipProvider>
      <WslMovedProjectsSection />
    </TooltipProvider>
  )

const MOVED = 'repo1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo1'
const chat = (id: string, label: string): Partial<Tab> => ({
  id,
  entityId: id,
  worktreeId: MOVED,
  contentType: 'agent-session',
  label,
  customLabel: null
})

describe('WslMovedProjectsSection', () => {
  beforeEach(() => {
    mockState = {
      wslMovedProjects: [
        { kind: 'repo', id: 'repo1', displayName: 'Repo 1', path: MOVED, distro: 'Ubuntu' }
      ],
      worktreesByRepo: {},
      folderWorkspaces: [],
      unifiedTabsByWorktree: {
        [MOVED]: [chat('agent-session:a', 'Fix the parser'), chat('agent-session:b', 'Plan')]
      },
      activeWorktreeId: MOVED,
      activeGroupIdByWorktree: { [MOVED]: 'group-1' },
      groupsByWorktree: { [MOVED]: [{ id: 'group-1', activeTabId: 'agent-session:b' }] }
    }
  })

  it('lists the moved project read-only, labeled with its host, with only its chats', () => {
    const markup = render()
    expect(markup).toContain('Repo 1')
    expect(markup).toContain('Moved to Ubuntu host')
    expect(markup).toContain('Fix the parser')
    // One button per chat plus "use here again": no new terminal, new chat, rename or menu.
    expect(markup.match(/<button/g)).toHaveLength(3)
    expect(markup.match(/data-testid="wsl-moved-chat"/g)).toHaveLength(2)
    expect(markup.match(/data-testid="wsl-moved-use-here"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Use on this computer again"')
    expect(markup).toContain('data-current="true"')
  })

  it('still lists a moved project without chats here, so it can be used here again', () => {
    mockState.unifiedTabsByWorktree = {
      [MOVED]: [{ ...chat('t', 'Shell'), contentType: 'terminal' }]
    }
    const markup = render()
    expect(markup).toContain('Moved to Ubuntu host')
    expect(markup.match(/data-testid="wsl-moved-chat"/g)).toBeNull()
    expect(markup.match(/data-testid="wsl-moved-use-here"/g)).toHaveLength(1)
  })

  it('renders nothing when no project is moved', () => {
    mockState.wslMovedProjects = []
    expect(render()).toBe('')
  })
})
