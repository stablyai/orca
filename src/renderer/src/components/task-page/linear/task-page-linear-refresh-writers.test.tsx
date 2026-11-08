// @vitest-environment happy-dom
import { reads, task, store } from './task-page-linear-refresh-test-fixtures'
import { LinearIssueProjectSelector } from '../../linear-issue-project-selector'

import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { writeLinearIssue } from '@/lib/work-items/linear/linear-issue-write'

import { defaultScopeSource } from '@/lib/default-creation-host'

import LinearItemDrawer from '../../LinearItemDrawer'

import type { LinearIssue } from '../../../../../shared/linear/issue-types'

import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import { expect, it, vi } from 'vitest'
import { act, render, fireEvent, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear/linear-slice-test-harness'

it('real drawer hydration, field controller and text writer compose rollback without permanent masks', async () => {
  const s = store()
  s.setState({
    recordFeatureInteraction: vi.fn(),
    linearStatus: { connected: true, viewer: null, selectedWorkspaceId: 'B' }
  })
  const old = deferred<LinearIssue | null>(),
    fresh = deferred<LinearIssue | null>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  const priority = deferred<{ ok: boolean }>(),
    labels = deferred<{ ok: boolean }>(),
    title = deferred<{ ok: boolean }>()
  reads.update.mockImplementation((_source, _id, patch) =>
    'priority' in patch ? priority.promise : 'labelIds' in patch ? labels.promise : title.promise
  )
  render(<LinearItemDrawer issue={task()} onUse={vi.fn()} onClose={vi.fn()} />)
  expect(reads.detail).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Priority' }))
  fireEvent.click(screen.getByRole('button', { name: 'Label' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Issue title' }), {
    target: { value: 'Local title' }
  })
  fireEvent.blur(screen.getByRole('textbox', { name: 'Issue title' }))
  expect(reads.update).toHaveBeenCalledWith(
    expect.anything(),
    task().id,
    { labelIds: ['bug'] },
    'w'
  )
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:Bug')
  await act(async () => {
    old.resolve(task('Stale'))
    await old.promise
    labels.resolve({ ok: true })
    await labels.promise
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:4:Bug')
  await act(async () => {
    await writeLinearIssue(
      task(),
      { title: 'Sibling title' },
      defaultScopeSource(null),
      async () => ({ ok: true })
    )
  })
  await act(async () => {
    priority.resolve({ ok: false })
    title.resolve({ ok: false })
    await Promise.all([priority.promise, title.promise])
  })
  expect(screen.getByTestId('drawer').textContent).toBe('In Review:0:Bug')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Issue title' }).value).toBe(
    'Sibling title'
  )
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    fresh.resolve({
      ...task('External'),
      title: 'Server title',
      priority: 2,
      labels: [],
      labelIds: []
    })
    await fresh.promise
  })
  expect(screen.getByTestId('drawer').textContent).toBe('External:2:')
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Issue title' }).value).toBe(
    'Server title'
  )
})

it('confirmed project selection retires old hydration and publishes through the mounted detail consumer', async () => {
  store()
  const old = deferred<LinearIssue | null>(),
    external = deferred<LinearIssue | null>()
  const pending = deferred<{ ok: boolean }>()
  reads.detail.mockReturnValueOnce(old.promise).mockReturnValueOnce(external.promise)
  reads.projects.mockResolvedValue({ items: [{ id: 'chosen', name: 'Chosen' }] })
  reads.update.mockReturnValueOnce(pending.promise)
  function Detail() {
    const detail = useLinearIssueWorkspaceDetail({
      issue: task(),
      providerSettings: defaultScopeSource(null),
      requestKey: 'project'
    })
    return (
      <>
        <output data-testid="project">{detail.displayed.project?.name ?? 'None'}</output>
        <LinearIssueProjectSelector issue={detail.displayed} />
      </>
    )
  }
  render(<Detail />)
  fireEvent.click(screen.getByRole('button', { name: 'Add to project' }))
  fireEvent.change(screen.getByPlaceholderText('Search projects'), { target: { value: 'Chosen' } })
  fireEvent.click(await screen.findByRole('button', { name: 'Chosen' }))
  expect(screen.getByTestId('project').textContent).toBe('None')
  expect(reads.update).toHaveBeenCalledWith(
    defaultScopeSource(null),
    task().id,
    { projectId: 'chosen' },
    'w'
  )
  await act(async () => {
    pending.resolve({ ok: true })
    await pending.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('Chosen')
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    old.resolve(task())
    await old.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('Chosen')
  await act(async () => {
    external.resolve({ ...task(), project: { id: 'external', name: 'External' } })
    await external.promise
  })
  expect(screen.getByTestId('project').textContent).toBe('External')
})
