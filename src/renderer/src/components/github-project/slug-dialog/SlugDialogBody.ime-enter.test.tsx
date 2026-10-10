// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireImeConfirmEnter, firePlainEnter } from '@/lib/ime-enter-confirm-test-fixture'

const patchProjectIssueOrPr = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
const storeState = vi.hoisted(() => ({
  patchProjectIssueOrPr,
  projectViewCache: {
    'cache-1': {
      data: {
        rows: [
          {
            id: 'row-1',
            content: {
              number: 7,
              repository: 'acme/app',
              title: 'Old title',
              url: null,
              labels: [],
              assignees: []
            }
          }
        ]
      }
    }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState)
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({ default: () => null }))
vi.mock('./LabelsEditor', () => ({ LabelsEditor: () => null }))
vi.mock('./AssigneesEditor', () => ({ AssigneesEditor: () => null }))
vi.mock('./Comments', () => ({ CommentsList: () => null, NewCommentForm: () => null }))

import { SlugDialogBody } from './SlugDialogBody'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  patchProjectIssueOrPr.mockClear()
})

describe('SlugDialogBody title Enter', () => {
  it('ignores the Enter that confirms an IME composition and commits on a plain Enter', () => {
    vi.stubGlobal('api', { gh: { projectWorkItemDetailsBySlug: () => new Promise(() => {}) } })
    render(
      <SlugDialogBody
        projectOrigin={{
          owner: 'acme',
          repo: 'app',
          number: 7,
          type: 'issue',
          projectId: 'project-1',
          projectItemId: 'item-1',
          cacheKey: 'cache-1'
        }}
        sourceSettings={null}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Old title' }))
    const input = screen.getByDisplayValue('Old title')
    fireEvent.change(input, { target: { value: 'New title' } })

    fireImeConfirmEnter(input)
    expect(patchProjectIssueOrPr).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('New title')).toBe(input)

    firePlainEnter(input)
    expect(patchProjectIssueOrPr).toHaveBeenCalledWith('cache-1', 'row-1', { title: 'New title' })
  })
})
