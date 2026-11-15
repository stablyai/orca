// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionContinuationDialog } from './AgentSessionContinuationDialog'

vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({
    detection: { detectedIds: [], detectionFailed: false },
    model: { state: 'settled', rows: [] },
    selectionFor: () => ({ ready: false, choice: null, cli: false })
  })
}))
vi.mock('@/components/agent/AgentLaunchPicker', () => ({
  AgentLaunchPicker: () => <button type="button">Agent field</button>
}))
afterEach(cleanup)

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
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.click(screen.getByRole('option', { name: 'Full transcript' }))
  expect(screen.getByText('Slower, and uses more of your plan or API credits.')).toBeVisible()
  await userEvent.click(screen.getByRole('combobox'))
  await userEvent.click(screen.getByRole('option', { name: 'Latest status (recommended)' }))
  expect(screen.queryByText('Slower, and uses more of your plan or API credits.')).toBeNull()
})
