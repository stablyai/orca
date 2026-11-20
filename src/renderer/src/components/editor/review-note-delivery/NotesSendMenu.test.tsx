// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diff-comments/create-diff-comments-slice'
import { NotesSendMenu, type NotesSendMenuProps } from './NotesSendMenu'

// The unopened menu's delivery panel is unrelated to the trigger's DOM contract.
vi.mock('./ReviewNotesSendMenuContent', () => ({ ReviewNotesSendMenuContent: () => null }))

const props: NotesSendMenuProps<DiffCommentDeliverySnapshot> = {
  owner: {
    kind: 'folder',
    worktreeId: 'worktree-1',
    executionHostId: 'local',
    runtimeEnvironmentId: null
  },
  worktreeId: 'worktree-1',
  groupId: 'worktree-1',
  modeIdParts: ['review-notes'],
  scopes: [
    {
      id: 'all',
      label: 'All notes',
      notes: [{ id: 'note-1', filePath: 'readme.md', lineNumber: 1, body: 'Review this' }],
      formatPrompt: () => 'Review this'
    }
  ],
  onDelivered: () => undefined
}

afterEach(cleanup)

it('has no native title and names both the enabled action and disabled reason', () => {
  const { rerender } = render(
    <TooltipProvider>
      <NotesSendMenu {...props} />
    </TooltipProvider>
  )
  const enabled = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Send notes to an agent'
  })
  expect(enabled.disabled).toBe(false)
  expect(enabled.hasAttribute('title')).toBe(false)

  rerender(
    <TooltipProvider>
      <NotesSendMenu {...props} scopes={[]} disabledTooltip="All notes sent" />
    </TooltipProvider>
  )
  const disabled = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Send notes to an agent — All notes sent'
  })
  expect(disabled.disabled).toBe(true)
  expect(disabled.hasAttribute('title')).toBe(false)
})
