// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ details: vi.fn(), patch: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      patchProjectIssueOrPr: mocks.patch,
      projectViewCache: {
        key: {
          data: {
            rows: [
              {
                id: 'row',
                content: {
                  number: 2,
                  repository: 'acme/widgets',
                  title: 'Image',
                  labels: [],
                  assignees: []
                }
              }
            ]
          }
        }
      }
    })
}))
vi.mock('@/hooks/useGitHubTaskItems', () => ({
  useGitHubTaskProjectTable: (table: unknown) => table
}))
vi.mock('@/runtime/repository-github/github-slug-owner-api', () => ({
  gitHubSlugApiForTarget: () => ({ projectWorkItemDetailsBySlug: mocks.details })
}))
vi.mock('./LabelsEditor', () => ({ LabelsEditor: () => null }))
vi.mock('./AssigneesEditor', () => ({ AssigneesEditor: () => null }))
vi.mock('./Comments', () => ({ CommentsList: () => null, NewCommentForm: () => null }))
import { SlugDialogBody } from './SlugDialogBody'
afterEach(cleanup)

it.each([true, false])(
  'uses the authoritative save map, including absent old-host maps (%s)',
  async (hasMap) => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    const edited =
      '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc489)'
    mocks.details.mockResolvedValue({
      ok: true,
      details: {
        item: { title: 'Image' },
        body,
        bodyImageUrls: {
          'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
            'https://private-user-images.githubusercontent.com/1/old.png?jwt=OLD'
        },
        comments: []
      }
    })
    mocks.patch.mockReset().mockResolvedValue(
      hasMap
        ? {
            ok: true,
            bodyImageUrls: {
              'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc489':
                'https://private-user-images.githubusercontent.com/1/new.png?jwt=NEW'
            }
          }
        : { ok: true }
    )
    render(
      <SlugDialogBody
        projectOrigin={{
          owner: 'acme',
          repo: 'widgets',
          number: 2,
          type: 'issue',
          projectId: 'project',
          projectItemId: 'row',
          cacheKey: 'key'
        }}
        sourceTarget={{ kind: 'local' }}
        onClose={() => {}}
      />
    )
    const image = await screen.findByRole('img')
    expect(image.getAttribute('src')).toBe(
      'https://private-user-images.githubusercontent.com/1/old.png?jwt=OLD'
    )
    fireEvent.click(image.closest('button')!)
    const editor = screen.getByRole('textbox')
    expect(editor).toHaveProperty('value', body)
    fireEvent.change(editor, { target: { value: edited } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(screen.getByRole('img').getAttribute('src')).toBe(
        hasMap
          ? 'https://private-user-images.githubusercontent.com/1/new.png?jwt=NEW'
          : 'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc489'
      )
    )
    expect(mocks.patch).toHaveBeenCalledWith('key', 'row', {
      body: '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc489)'
    })
  }
)
