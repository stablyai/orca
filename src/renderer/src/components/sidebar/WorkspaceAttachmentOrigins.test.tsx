// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type {
  WorkspaceAttachment,
  WorkspaceAttachmentOrigin
} from '../../../../shared/worktree/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { singlePaneLayoutSnapshot } from '../../store/slices/terminal-helpers'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorktreeLinkedItemRow } from './WorktreeLinkedItemRow'
import { makeWorktree, makeTerminalTab } from '../../store/slices/worktrees-slice-test-fixtures'
import { WorkspaceAttachmentOrigins } from './WorkspaceAttachmentOrigins'

const mocks = vi.hoisted(() => ({
  state: {
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    setActiveWorktree: vi.fn(() => true),
    activateTab: vi.fn()
  },
  activateTabAndFocusPane: vi.fn()
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('@/attention/notification-subject-owner', () => ({
  resolveNotificationTabOwner: (_state: unknown, tab: Tab) => ({
    executionHostId: tab.executionHostId ?? 'local',
    runtimeEnvironmentId: null
  })
}))
const workspace = makeWorktree({ id: 'repo::/feature', repoId: 'repo', hostId: 'local' })
const reference: WorkspaceAttachment = { provider: 'github', type: 'pr', number: 23 }
const tab = (id: string): Tab => ({
  id,
  entityId: id,
  groupId: 'group',
  worktreeId: workspace.id,
  executionHostId: 'local',
  contentType: 'agent-session',
  label: id,
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  agentSessionAgent: 'codex'
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function setup() {
  mocks.state.unifiedTabsByWorktree = {
    [workspace.id]: [
      tab('Session A'),
      tab('Session B'),
      { ...tab('Foreign session'), executionHostId: 'ssh:other' }
    ]
  }
}
describe('reference session associations', () => {
  it('reveals automatic observations without checks selection or manual assignment controls', () => {
    setup()
    const onRemove = vi.fn()
    const parentKeyDown = vi.fn()
    render(
      <TooltipProvider>
        <div onKeyDown={parentKeyDown}>
          <WorktreeLinkedItemRow
            item={{
              ...reference,
              title: 'Observed review',
              origins: [{ kind: 'observed', tabId: 'Session B', hostId: 'local' }]
            }}
            workspace={workspace}
            disabled={false}
            onRemove={onRemove}
          />
        </div>
      </TooltipProvider>
    )
    expect(screen.getByText('PR #23')).toBeTruthy()
    expect(screen.getByText('Observed review')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('Used for checks')).toBeNull()
    expect(screen.queryByRole('button', { name: /Use .* for checks/ })).toBeNull()
    const disclosure = screen.getByRole('button', { name: 'Sessions & terminals for PR #23 · 1' })
    fireEvent.keyDown(disclosure, { key: 'Enter' })
    expect(parentKeyDown).not.toHaveBeenCalled()
    fireEvent.click(disclosure)
    expect(screen.getByRole('button', { name: 'Seen in Session B' })).toBeTruthy()
    expect(screen.queryByText('Linked to Session A')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Seen in Session B' }))
    expect(mocks.state.activateTab).toHaveBeenCalledWith('Session B', { worktreeId: workspace.id })
    fireEvent.click(screen.getByRole('button', { name: 'Unlink PR #23' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
  it('shows no session disclosure for a reference without automatic observations', () => {
    setup()
    render(
      <TooltipProvider>
        <WorktreeLinkedItemRow
          item={reference}
          workspace={workspace}
          disabled={false}
          onRemove={vi.fn()}
        />
      </TooltipProvider>
    )
    expect(screen.queryByRole('button', { name: /Sessions & terminals/ })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('opens a related live tab and describes evidence without implying authorship', () => {
    setup()
    render(
      <WorkspaceAttachmentOrigins
        item={{
          ...reference,
          origins: [
            {
              kind: 'observed',
              tabId: 'Session A',
              label: 'Session A',
              hostId: 'local',
              sessionId: 'session-provider-id'
            }
          ]
        }}
        workspace={workspace}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Seen in Session A' }))
    expect(mocks.state.setActiveWorktree).toHaveBeenCalledWith(workspace.id, 'local')
    expect(mocks.state.activateTab).toHaveBeenCalledWith('Session A', { worktreeId: workspace.id })
  })

  it.each([true, false])(
    'focuses a recorded pane only while it remains in the layout (present=%s)',
    (present) => {
      setup()
      const leafId = '11111111-1111-4111-8111-111111111111'
      const otherLeaf = '22222222-2222-4222-8222-222222222222'
      mocks.state.unifiedTabsByWorktree = {
        [workspace.id]: [{ ...tab('Terminal'), contentType: 'terminal' }]
      }
      mocks.state.tabsByWorktree = {
        [workspace.id]: [makeTerminalTab({ id: 'Terminal', worktreeId: workspace.id })]
      }
      mocks.state.terminalLayoutsByTabId = {
        Terminal: {
          ...singlePaneLayoutSnapshot(otherLeaf),
          root: present
            ? {
                type: 'split',
                direction: 'horizontal',
                ratio: 0.5,
                first: { type: 'leaf', leafId },
                second: { type: 'leaf', leafId: otherLeaf }
              }
            : { type: 'leaf', leafId: otherLeaf }
        }
      }
      render(
        <WorkspaceAttachmentOrigins
          workspace={workspace}
          item={{
            ...reference,
            origins: [
              {
                kind: 'observed',
                tabId: 'Terminal',
                hostId: 'local',
                paneKey: makePaneKey('Terminal', leafId)
              }
            ]
          }}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Seen in Terminal' }))
      expect(mocks.state.activateTab).toHaveBeenCalledWith('Terminal', { worktreeId: workspace.id })
      if (present) {
        expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith('Terminal', leafId)
      } else {
        expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
      }
    }
  )
})

const localTab: Tab = { ...tab('same-tab'), contentType: 'terminal', label: 'Current terminal' }
const foreignOrigin: WorkspaceAttachmentOrigin = {
  kind: 'observed',
  tabId: localTab.id,
  hostId: 'ssh:other',
  label: 'Other host terminal'
}
describe('session association host and keyboard regressions', () => {
  beforeEach(() => {
    mocks.state.unifiedTabsByWorktree = { [workspace.id]: [localTab] }
  })
  it('keeps another host observation unavailable even when a live tab has the same id', () => {
    render(
      <WorkspaceAttachmentOrigins
        workspace={workspace}
        item={{ provider: 'github', type: 'pr', number: 23, origins: [foreignOrigin] }}
      />
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText(/Other host terminal/).textContent).toContain('Tab unavailable')
  })
  it.each([
    ['Escape', false, false, 1],
    ['Enter', true, false, 1],
    ['Enter', false, true, 1],
    ['Enter', false, false, 0]
  ])('handles parent dialog shortcut %s meta=%s ctrl=%s', (key, metaKey, ctrlKey, calls) => {
    const parent = vi.fn()
    render(
      <div onKeyDown={parent}>
        <WorkspaceAttachmentOrigins
          workspace={workspace}
          item={{
            ...reference,
            origins: [{ kind: 'observed', tabId: localTab.id, hostId: 'local' }]
          }}
        />
      </div>
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Seen in Current terminal' }), {
      key,
      metaKey,
      ctrlKey
    })
    expect(parent).toHaveBeenCalledTimes(calls)
  })
  it('uses the live tab name while preserving evidence semantics', () => {
    render(
      <WorkspaceAttachmentOrigins
        workspace={workspace}
        item={{
          provider: 'github',
          type: 'pr',
          number: 23,
          origins: [{ kind: 'observed', tabId: localTab.id, hostId: 'local', label: 'Old name' }]
        }}
      />
    )
    expect(screen.getByRole('button', { name: 'Seen in Current terminal' })).toBeTruthy()
    expect(screen.queryByText('Seen in Old name')).toBeNull()
  })
})
