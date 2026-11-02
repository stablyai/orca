// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPRCommentPresentationClasses } from '../pr-comment-presentation'
import { CommentRow } from './comment-row'

afterEach(cleanup)

describe('CommentRow location', () => {
  it('opens the full repo path at the first line of the commented range', () => {
    const onOpenLocation = vi.fn()
    render(
      <CommentRow
        comment={{
          id: 1,
          author: 'reviewer',
          authorAvatarUrl: '',
          body: 'findProjectRoot treats any folder as an app',
          createdAt: '2026-10-21T00:00:00Z',
          url: 'https://github.com/o/r/pull/1#discussion_r1',
          path: 'src/cli/doctor.ts',
          threadId: 'thread-1',
          startLine: 370,
          line: 380
        }}
        botAuthorOverrides={new Set()}
        isReply={false}
        showResolve={false}
        actionState="open"
        isQueued={false}
        presentation={getPRCommentPresentationClasses()}
        now={Date.parse('2026-10-22T00:00:00Z')}
        onOpenLocation={onOpenLocation}
      />
    )

    screen.getByRole('button', { name: 'doctor.ts:L370-L380' }).click()

    expect(onOpenLocation).toHaveBeenCalledWith('src/cli/doctor.ts', 370)
  })
})
