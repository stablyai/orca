// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FollowUpView } from '../../../../shared/pr-follow-ups/contracts'
import { PrFollowUpRow } from './PrFollowUpRow'

const current = vi.hoisted(() => ({
  view: {
    state: 'unconfirmed',
    used: 1,
    limit: 3,
    stopped: false,
    workingAgent: 'codex'
  } as FollowUpView
}))
vi.mock('./follow-up-resource', () => ({
  usePrFollowUpWorkspace: () => ({ prKey: 'pr', view: current.view, fixing: false }),
  usePrFollowUpFixing: () => false
}))
vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('../../lib/agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: vi.fn()
}))
vi.mock('../../lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('../../lib/activate-tab-and-focus-pane', () => ({ activateTabAndFocusPane: vi.fn() }))
afterEach(cleanup)

it.each(['unconfirmed', 'failed'] as const)(
  'keeps manual Fix usable while the automatic action is %s',
  (state) => {
    current.view = { ...current.view, state }
    const fix = vi.fn()
    render(<PrFollowUpRow worktreeId="w1" repo={null} onFixChecks={fix} />)
    const button = screen.getByRole('button', { name: 'Fix with AI' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(fix).toHaveBeenCalledOnce()
  }
)
