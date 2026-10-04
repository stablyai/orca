import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { submitDiffSectionComment } from './diff-section-comment-submit'
import type { DiffSection } from './diff-section-types'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const section: DiffSection = {
  key: 'section-1',
  path: 'src/example.ts',
  status: 'modified',
  originalContent: 'before',
  modifiedContent: 'after',
  collapsed: false,
  loading: false,
  dirty: false,
  diffResult: null,
  largeDiffRenderLimit: null
}

describe('submitDiffSectionComment', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear()
  })

  it('surfaces persistence failures while keeping the draft open', async () => {
    const addDiffComment = vi.fn().mockResolvedValue(null)

    const result = await submitDiffSectionComment({
      addDiffComment,
      body: 'Needs revision',
      target: { lineNumber: 4 },
      section,
      worktreeId: 'worktree-1'
    })

    expect(result).toBe(false)
    expect(toast.error).toHaveBeenCalledWith('Failed to save comment')
  })
})
