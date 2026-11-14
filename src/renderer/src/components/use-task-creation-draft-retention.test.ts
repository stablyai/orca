// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useTaskCreationDraftRetention } from './use-task-creation-draft-retention'

import { store } from './task-page/linear/issue-refresh/task-page-linear-refresh-test-fixtures'

import {
  writeNewLinearProjectDraft,
  writeNewJiraIssueDraft
} from './task-page/task-page-draft-storage'

it('project and Jira immediate discard keep their actual plain session slots cleared through close', () => {
  const s = store()
  const view = renderHook(
    ({ open }) => ({
      project: useTaskCreationDraftRetention({
        open,
        draft: { name: 'Project', description: 'Summary', content: 'Brief' },
        writeDraft: writeNewLinearProjectDraft
      }),
      jira: useTaskCreationDraftRetention({
        open,
        draft: { title: 'Jira', body: 'Details' },
        writeDraft: writeNewJiraIssueDraft
      })
    }),
    { initialProps: { open: true } }
  )
  view.rerender({ open: false })
  expect(s.getState().newLinearProjectDraft).toEqual({
    name: 'Project',
    description: 'Summary',
    content: 'Brief'
  })
  expect(s.getState().newJiraIssueDraft).toEqual({ title: 'Jira', body: 'Details' })
  view.rerender({ open: true })
  act(() => {
    view.result.current.project()
    view.result.current.jira()
  })
  view.rerender({ open: true })
  view.rerender({ open: false })
  view.unmount()
  expect(s.getState().newLinearProjectDraft).toBeNull()
  expect(s.getState().newJiraIssueDraft).toBeNull()
})
