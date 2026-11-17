// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

const observationState = vi.hoisted(() => ({ detecting: false }))

vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('@/components/agent/launch-menu/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({
    detection: { detectedIds: observationState.detecting ? null : [], detectionFailed: false },
    model: { state: observationState.detecting ? 'pending' : 'settled', rows: [] },
    selectionFor: () => ({ ready: false, choice: null, cli: false })
  })
}))
vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: ({ disabled }: { disabled: boolean }) => (
    <button type="button" disabled={disabled}>
      Agent field
    </button>
  )
}))
beforeEach(() => {
  observationState.detecting = false
})
afterEach(cleanup)

it('moves initial focus to the Agent trigger when detection finishes', async () => {
  observationState.detecting = true
  const dialog = <AgentSessionContinuationDialog open request={null} onOpenChange={() => {}} />
  const { rerender } = render(dialog)
  await waitFor(() => expect(screen.getByRole('group', { name: 'Agent' })).toHaveFocus())
  observationState.detecting = false
  const ready = (
    <AgentSessionContinuationDialog
      open
      request={{
        worktreeId: 'wt-1',
        workspacePath: '/tmp/fix-login',
        launchSource: 'sidebar',
        source: { sourceAgent: 'claude', capturedText: 'Current task' }
      }}
      onOpenChange={() => {}}
    />
  )
  rerender(ready)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Agent field' })).toHaveFocus())
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
})

it('focuses the Agent field and shows the cost helper only for the full transcript', async () => {
  render(
    <AgentSessionContinuationDialog
      open
      onOpenChange={() => {}}
      request={{
        worktreeId: 'wt-1',
        workspacePath: '/tmp/fix-login',
        launchSource: 'sidebar',
        source: {
          sourceAgent: 'claude',
          capturedText: 'Current task',
          transcriptPath: '/tmp/session.jsonl'
        }
      }}
    />
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Agent field' })).toHaveFocus())
  expect(screen.queryByText('Slower, and uses more of your plan or API credits.')).toBeNull()
  await userEvent.click(screen.getByRole('combobox', { name: 'Context' }))
  await userEvent.click(screen.getByRole('option', { name: 'Full transcript' }))
  expect(screen.getByText('Slower, and uses more of your plan or API credits.')).toBeVisible()
  await userEvent.click(screen.getByRole('combobox', { name: 'Context' }))
  await userEvent.click(screen.getByRole('option', { name: 'Latest status (recommended)' }))
  expect(screen.queryByText('Slower, and uses more of your plan or API credits.')).toBeNull()
})
