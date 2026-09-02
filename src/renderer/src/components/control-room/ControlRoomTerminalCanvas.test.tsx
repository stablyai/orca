// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { CanvasTerminalItem } from '../tab-group/CanvasTerminalCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  snapshot: null as DashboardSnapshot | null,
  storeState: null as Record<string, unknown> | null,
  canvasProps: null as Record<string, unknown> | null,
  workspaceStateInput: null as Record<string, unknown> | null,
  activateCanvasTerminal: vi.fn()
}))

vi.mock('../dashboard/useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: () => mocks.snapshot
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Record<string, unknown>) => unknown): unknown =>
    selector(mocks.storeState ?? {})
  useAppStore.getState = (): Record<string, unknown> => mocks.storeState ?? {}
  return { useAppStore }
})

vi.mock('../tab-group/activate-canvas-terminal', () => ({
  activateCanvasTerminal: mocks.activateCanvasTerminal
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('../tab-group/use-pane-canvas-workspace-state', () => ({
  usePaneCanvasWorkspaceState: (input: Record<string, unknown>) => {
    mocks.workspaceStateInput = input
    return {
      canvasState: {
        mode: 'canvas',
        boundsByTerminalTabId: {}
      },
      updateCanvasState: vi.fn()
    }
  }
}))

vi.mock('../tab-group/TabGroupCanvasLayout', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.canvasProps = props
    const items = props.terminalItems as CanvasTerminalItem[]
    const onVisible = props.onVisibleTerminalTabIdsChange as (
      terminalTabIds: ReadonlySet<string>
    ) => void
    const onTogglePinned = props.onTogglePinned as (item: CanvasTerminalItem) => void
    const onActivateItem = props.onActivateItem as (item: CanvasTerminalItem) => void
    return (
      <div>
        {props.toolbarContent as React.ReactNode}
        <span data-testid="terminal-labels">{items.map((item) => item.label).join('|')}</span>
        <button
          type="button"
          aria-label="Publish visible terminals"
          onClick={() => onVisible(new Set(items.map((item) => item.terminalTabId)))}
        />
        <button
          type="button"
          aria-label="Pin last terminal"
          onClick={() => items.at(-1) && onTogglePinned(items.at(-1)!)}
        />
        <button
          type="button"
          aria-label="Activate first terminal"
          onClick={() => items[0] && onActivateItem(items[0])}
        />
      </div>
    )
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

import ControlRoomTerminalCanvas, {
  type ControlRoomTerminalVisibility
} from './ControlRoomTerminalCanvas'

function unifiedTab(worktreeId: string, terminalTabId: string, label: string, order: number): Tab {
  return {
    id: `unified-${terminalTabId}`,
    entityId: terminalTabId,
    groupId: `group-${worktreeId}`,
    worktreeId,
    contentType: 'terminal',
    label,
    customLabel: null,
    color: null,
    sortOrder: order,
    createdAt: order
  }
}

function terminalTab(worktreeId: string, id: string, title: string, order: number): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: order,
    createdAt: order
  }
}

describe('ControlRoomTerminalCanvas', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    mocks.activateCanvasTerminal.mockClear()
    mocks.canvasProps = null
    mocks.workspaceStateInput = null
    mocks.snapshot = {
      generatedAt: 1,
      cards: [
        {
          paneKey: 'agent-a:leaf',
          ptyId: 'pty-agent-a',
          agentType: 'codex',
          bucket: 'working',
          dotState: 'working',
          task: 'Agent A',
          repoId: 'repo-a',
          worktreeId: 'worktree-a',
          tabId: 'agent-a',
          leafId: 'leaf',
          repoName: 'Alpha',
          worktreeName: 'Alpha',
          startedAt: 1,
          finishedAt: null,
          stateChangedAt: 1,
          unseen: false
        },
        {
          paneKey: 'agent-b:leaf',
          ptyId: 'pty-agent-b',
          agentType: 'claude',
          bucket: 'attention',
          dotState: 'waiting',
          task: 'Agent B',
          repoId: 'repo-b',
          worktreeId: 'worktree-b',
          tabId: 'agent-b',
          leafId: 'leaf',
          repoName: 'Beta',
          worktreeName: 'Beta',
          startedAt: 2,
          finishedAt: null,
          stateChangedAt: 2,
          unseen: true
        }
      ],
      workspaces: [
        {
          repoId: 'repo-a',
          worktreeId: 'worktree-a',
          repoName: 'Alpha',
          worktreeName: 'Alpha',
          hostKind: 'local',
          executionHostId: 'local',
          workspaceKind: 'worktree'
        },
        {
          repoId: 'repo-b',
          worktreeId: 'worktree-b',
          repoName: 'Beta',
          worktreeName: 'Beta',
          hostKind: 'local',
          executionHostId: 'local',
          workspaceKind: 'worktree'
        }
      ]
    }
    const setActiveWorktree = vi.fn()
    mocks.storeState = {
      unifiedTabsByWorktree: {
        'worktree-a': [unifiedTab('worktree-a', 'agent-a', 'Agent A', 1)],
        'worktree-b': [
          unifiedTab('worktree-b', 'agent-b', 'Agent B', 1),
          unifiedTab('worktree-b', 'shell-b', 'Shell B', 2)
        ]
      },
      tabsByWorktree: {
        'worktree-a': [terminalTab('worktree-a', 'agent-a', 'Agent A', 1)],
        'worktree-b': [
          terminalTab('worktree-b', 'agent-b', 'Agent B', 1),
          terminalTab('worktree-b', 'shell-b', 'Shell B', 2)
        ]
      },
      ptyIdsByTabId: {
        'agent-a': ['pty-agent-a'],
        'agent-b': ['pty-agent-b'],
        'shell-b': ['pty-shell-b']
      },
      settings: { tabAutoGenerateTitle: false },
      activeWorktreeId: null,
      activeTabId: null,
      terminalLayoutsByTabId: {},
      setActiveWorktree
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    localStorage.clear()
  })

  it('coordinates live sessions across worktrees without discarding dormant geometry', async () => {
    const visibilityChanges: ControlRoomTerminalVisibility[] = []
    await act(async () => {
      root.render(
        <ControlRoomTerminalCanvas
          onTerminalVisibilityChange={(visibility) => visibilityChanges.push(visibility)}
        />
      )
    })

    expect(mocks.workspaceStateInput).toMatchObject({
      ownerKey: 'control-room:active',
      terminalTabIds: ['agent-b', 'agent-a'],
      preserveMissingBounds: true
    })
    expect(container.querySelector('[data-testid="terminal-labels"]')?.textContent).toBe(
      'Agent B|Agent A'
    )
    expect(visibilityChanges.at(-1)?.terminalTabIdsByWorktree).toEqual({
      'worktree-b': new Set(['agent-b']),
      'worktree-a': new Set(['agent-a'])
    })

    const publishVisible = container.querySelector(
      '[aria-label="Publish visible terminals"]'
    ) as HTMLButtonElement
    await act(async () => publishVisible.click())
    expect(visibilityChanges.at(-1)?.visibleTerminalTabIdsByWorktree).toEqual({
      'worktree-b': new Set(['agent-b']),
      'worktree-a': new Set(['agent-a'])
    })

    const allSessions = container.querySelector(
      '[aria-label="All live sessions"]'
    ) as HTMLButtonElement
    await act(async () => allSessions.click())
    expect(mocks.workspaceStateInput).toMatchObject({
      ownerKey: 'control-room:all',
      preserveMissingBounds: true
    })
    expect(container.querySelector('[data-testid="terminal-labels"]')?.textContent).toContain(
      'Shell B'
    )

    const pinLast = container.querySelector('[aria-label="Pin last terminal"]') as HTMLButtonElement
    await act(async () => pinLast.click())
    const pinned = container.querySelector('[aria-label="Pinned"]') as HTMLButtonElement
    await act(async () => pinned.click())
    expect(mocks.workspaceStateInput).toMatchObject({
      ownerKey: 'control-room:pinned',
      terminalTabIds: ['shell-b'],
      preserveMissingBounds: true
    })

    const activate = container.querySelector(
      '[aria-label="Activate first terminal"]'
    ) as HTMLButtonElement
    await act(async () => activate.click())
    expect(mocks.storeState?.setActiveWorktree as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'worktree-b',
      'local'
    )
    expect(mocks.activateCanvasTerminal).toHaveBeenCalledWith({
      worktreeId: 'worktree-b',
      groupId: 'group-worktree-b',
      unifiedTabId: 'unified-shell-b',
      terminalTabId: 'shell-b'
    })
  })

  it('restores pinned agents after the Control Room remounts', async () => {
    const renderControlRoom = (): void => {
      root.render(<ControlRoomTerminalCanvas onTerminalVisibilityChange={() => undefined} />)
    }

    await act(async () => renderControlRoom())
    const pinLast = container.querySelector('[aria-label="Pin last terminal"]') as HTMLButtonElement
    await act(async () => pinLast.click())

    await act(async () => root.render(null))
    await act(async () => renderControlRoom())
    const pinned = container.querySelector('[aria-label="Pinned"]') as HTMLButtonElement
    await act(async () => pinned.click())

    expect(container.querySelector('[data-testid="terminal-labels"]')?.textContent).toBe('Agent A')
    expect(mocks.canvasProps?.terminalItems).toEqual([
      expect.objectContaining({ terminalTabId: 'agent-a', pinned: true })
    ])
  })
})
