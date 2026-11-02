// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileWorkspaceGroup } from '../mobile-remote-model'
import { MobileTaskHome } from './MobileTaskHome'

const workspaces: MobileWorkspaceGroup[] = [
  {
    workspaceId: 'wt-1',
    name: 'Orca Core',
    path: '/code/orca',
    branch: 'feat/web-remote-control',
    isActive: true,
    unread: false,
    status: 'working',
    lastActivityAt: 2_000,
    sessions: [
      {
        sessionId: 'session-1',
        agent: 'codex',
        status: 'attention',
        title: 'Refactor Tunnel',
        preview: 'Waiting for approval to run the migration',
        updatedAt: 2_000,
        toolName: null
      }
    ]
  },
  {
    workspaceId: 'wt-2',
    name: 'Docs Site',
    path: '/code/docs',
    branch: 'main',
    isActive: false,
    unread: false,
    status: 'inactive',
    lastActivityAt: 1_000,
    sessions: []
  }
]

afterEach(cleanup)

describe('MobileTaskHome', () => {
  it('renders workspaces and opens a task card', () => {
    const onSelectSession = vi.fn()
    render(
      <MobileTaskHome
        hostName="Workstation"
        connectionState="connected"
        workspaces={workspaces}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onSelectSession={onSelectSession}
      />
    )

    expect(screen.getByText('Orca Core')).toBeDefined()
    expect(screen.getByText('Refactor Tunnel')).toBeDefined()
    expect(screen.getByText('Needs you')).toBeDefined()
    expect(screen.getByText('No active tasks')).toBeDefined()

    fireEvent.click(screen.getByText('Refactor Tunnel'))
    expect(onSelectSession).toHaveBeenCalledWith('session-1')
  })

  it('filters tasks by title', () => {
    render(
      <MobileTaskHome
        hostName="Workstation"
        connectionState="connected"
        workspaces={workspaces}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
        onSelectSession={vi.fn()}
      />
    )

    fireEvent.change(screen.getByPlaceholderText('Filter projects or tasks'), {
      target: { value: 'migration' }
    })
    expect(screen.getByText('Refactor Tunnel')).toBeDefined()
    expect(screen.queryByText('Docs Site')).toBeNull()
  })

  it('shows the offline state and refresh control', () => {
    const onRefresh = vi.fn()
    render(
      <MobileTaskHome
        hostName="Workstation"
        connectionState="offline"
        workspaces={[]}
        loading={false}
        error="Connection lost"
        onRefresh={onRefresh}
        onSelectSession={vi.fn()}
      />
    )

    expect(screen.getByText('Desktop unreachable')).toBeDefined()
    expect(screen.getByText('Connection lost')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }))
    expect(onRefresh).toHaveBeenCalled()
  })
})
