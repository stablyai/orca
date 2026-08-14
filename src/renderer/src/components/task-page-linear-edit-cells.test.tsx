// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { LinearIssue } from '../../../shared/types'
import { LinearAssigneeCell } from './task-page-linear-assignee-cell'
import { LinearLabelsCell } from './task-page-linear-labels-cell'

const mocks = vi.hoisted(() => ({
  invalidateLinearIssueLists: vi.fn(),
  linearUpdateIssue: vi.fn(),
  patchLinearIssue: vi.fn(),
  recordFeatureInteraction: vi.fn(),
  useTeamLabels: vi.fn(),
  useTeamMembers: vi.fn()
}))

vi.mock('@/hooks/useIssueMetadata', () => ({
  useTeamLabels: mocks.useTeamLabels,
  useTeamMembers: mocks.useTeamMembers
}))

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearUpdateIssue: mocks.linearUpdateIssue
}))

vi.mock('@/store', () => {
  const state = {
    settings: {},
    patchLinearIssue: mocks.patchLinearIssue,
    invalidateLinearIssueLists: mocks.invalidateLinearIssueLists,
    recordFeatureInteraction: mocks.recordFeatureInteraction
  }
  return {
    useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, value),
      fallback
    )
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const issue: LinearIssue = {
  id: 'issue-1',
  workspaceId: 'workspace-1',
  identifier: 'STA-1',
  title: 'Test issue',
  url: 'https://linear.app/test/issue/STA-1',
  state: { name: 'Todo', type: 'unstarted', color: '#888888' },
  team: { id: 'team-1', name: 'Test', key: 'STA' },
  labels: ['Bug'],
  labelIds: ['label-1'],
  assignee: { id: 'member-1', displayName: 'Neil' },
  priority: 2,
  updatedAt: '2026-08-09T00:00:00.000Z'
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.linearUpdateIssue.mockResolvedValue({ ok: true })
  mocks.useTeamMembers.mockReturnValue({
    data: [
      { id: 'member-1', displayName: 'Neil' },
      { id: 'member-2', displayName: 'Brennan' }
    ],
    loading: false,
    error: null
  })
  mocks.useTeamLabels.mockReturnValue({
    data: [
      { id: 'label-1', name: 'Bug', color: '#ff0000' },
      { id: 'label-2', name: 'Regression', color: '#00ff00' }
    ],
    loading: false,
    error: null
  })
})

function renderCell(cell: React.ReactNode): ReturnType<typeof render> {
  return render(<TooltipProvider>{cell}</TooltipProvider>)
}

describe('Linear list edit cells', () => {
  it('loads members on demand and propagates optimistic assignee patches', async () => {
    const user = userEvent.setup()
    const onIssuePatch = vi.fn()
    renderCell(<LinearAssigneeCell issue={issue} onIssuePatch={onIssuePatch} variant="name" />)

    expect(mocks.useTeamMembers).toHaveBeenLastCalledWith(null, {}, 'workspace-1')
    await user.click(screen.getByRole('button', { name: 'Change assignee from Neil' }))
    expect(mocks.useTeamMembers).toHaveBeenLastCalledWith('team-1', {}, 'workspace-1')
    expect(screen.getByRole('button', { name: 'Neil' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Brennan' }))
    const nextAssignee = { id: 'member-2', displayName: 'Brennan', avatarUrl: undefined }
    expect(mocks.patchLinearIssue).toHaveBeenCalledWith(
      'issue-1',
      { assignee: nextAssignee },
      { sourceContext: undefined }
    )
    expect(onIssuePatch).toHaveBeenCalledWith('issue-1', { assignee: nextAssignee })
    await waitFor(() =>
      expect(mocks.linearUpdateIssue).toHaveBeenCalledWith(
        {},
        'issue-1',
        { assigneeId: 'member-2' },
        'workspace-1'
      )
    )
  })

  it('loads labels on demand and exposes selected toggle state', async () => {
    const user = userEvent.setup()
    const onIssuePatch = vi.fn()
    renderCell(<LinearLabelsCell issue={issue} onIssuePatch={onIssuePatch} />)

    expect(mocks.useTeamLabels).toHaveBeenLastCalledWith(null, {}, 'workspace-1')
    await user.click(screen.getByRole('button', { name: 'Labels: Bug' }))
    expect(mocks.useTeamLabels).toHaveBeenLastCalledWith('team-1', {}, 'workspace-1')
    expect(screen.getByRole('button', { name: 'Bug' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Regression' }))
    const patch = {
      labelIds: ['label-1', 'label-2'],
      labels: ['Bug', 'Regression']
    }
    expect(mocks.patchLinearIssue).toHaveBeenCalledWith('issue-1', patch, {
      sourceContext: undefined
    })
    expect(onIssuePatch).toHaveBeenCalledWith('issue-1', patch)
    await waitFor(() =>
      expect(mocks.linearUpdateIssue).toHaveBeenCalledWith(
        {},
        'issue-1',
        { labelIds: patch.labelIds },
        'workspace-1'
      )
    )
  })
})
