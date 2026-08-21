// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  boardProps: null as Record<string, unknown> | null
}))

vi.mock('./useDashboardSnapshot', () => ({
  useDashboardSnapshot: () => ({ generatedAt: 1, cards: [] })
}))

vi.mock('./AgentKanbanBoard', () => ({
  AgentKanbanBoard: (props: Record<string, unknown>) => {
    mocks.boardProps = props
    return null
  }
}))

import { DashboardPopoutRoot } from './DashboardPopoutRoot'

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  mocks.boardProps = null
  useAppStore.setState(initialState, true)
  ;(window as unknown as { api: { dashboard: { onViewRequested: typeof vi.fn } } }).api = {
    dashboard: { onViewRequested: vi.fn(() => vi.fn()) }
  }
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('DashboardPopoutRoot', () => {
  it('paints the status board when the worktree-view setting is unset', () => {
    render(<DashboardPopoutRoot view={null} />)
    expect(mocks.boardProps?.initialView).toBe('board')
  })

  it('paints the worktree map when the persisted default is on', () => {
    useAppStore.setState({
      settings: { experimentalAgentDashboardDefaultWorktreeView: true } as never
    })
    render(<DashboardPopoutRoot view={null} />)
    expect(mocks.boardProps?.initialView).toBe('map')
  })

  it('keeps an explicit requested view over the persisted default', () => {
    useAppStore.setState({
      settings: { experimentalAgentDashboardDefaultWorktreeView: true } as never
    })
    render(<DashboardPopoutRoot view="board" />)
    expect(mocks.boardProps?.initialView).toBe('board')
  })

  it('does not apply the setting after a later per-session view request', () => {
    const listeners: ((view: 'board' | 'map') => void)[] = []
    ;(window as unknown as { api: { dashboard: { onViewRequested: typeof vi.fn } } }).api = {
      dashboard: {
        onViewRequested: vi.fn((listener: (view: 'board' | 'map') => void) => {
          listeners.push(listener)
          return vi.fn()
        })
      }
    }
    useAppStore.setState({
      settings: { experimentalAgentDashboardDefaultWorktreeView: true } as never
    })
    render(<DashboardPopoutRoot view={null} />)
    expect(mocks.boardProps?.initialView).toBe('map')

    act(() => {
      listeners[0]?.('board')
    })
    expect(mocks.boardProps?.initialView).toBe('board')
  })
})
