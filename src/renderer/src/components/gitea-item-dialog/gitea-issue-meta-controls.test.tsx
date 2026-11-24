// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GiteaIssueMetaControls } from './gitea-issue-meta-controls'

const mocks = vi.hoisted(() => ({ update: vi.fn(), error: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ updateGiteaIssue: mocks.update }) }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
const props = {
  scope: { repoPath: '/repo', repoId: 'repo' },
  issueNumber: 7,
  title: 'Issue',
  labelNames: ['visible', 'organization'],
  labelIds: [1, 900],
  assigneeLogins: [],
  repoLabels: [
    { id: 1, name: 'visible' },
    { id: 2, name: 'new label' }
  ],
  repoAssignees: [],
  onChanged: vi.fn().mockResolvedValue(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockResolvedValue({ ok: true })
})
afterEach(cleanup)

describe('Gitea issue metadata', () => {
  it('preserves applied label IDs absent from the repository label page', async () => {
    render(<GiteaIssueMetaControls {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /Labels/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'new label' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(props.scope, 7, { labelIds: [1, 900, 2] })
    )
  })

  it('reports a refresh failure after the metadata was saved', async () => {
    render(
      <GiteaIssueMetaControls
        {...props}
        onChanged={vi.fn().mockRejectedValue(new Error('Refresh failed'))}
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Updated' }
    })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), { key: 'Enter' })
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Refresh failed'))
  })
})
