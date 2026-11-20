// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SELF_LOCAL_AUTHORITY } from '../../../../../shared/execution-host/host-authority'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diff-comments/create-diff-comments-slice'
import { NotesSendMenu, type NotesSendMenuScope } from './NotesSendMenu'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))

const note: DiffCommentDeliverySnapshot = {
  id: 'note-1',
  body: 'Check the send button',
  filePath: 'README.md',
  lineNumber: 4,
  source: 'markdown'
}

const scope: NotesSendMenuScope<DiffCommentDeliverySnapshot> = {
  id: 'readme',
  label: 'README.md',
  notes: [note],
  formatPrompt: () => 'Send the note'
}

describe('NotesSendMenu native title', () => {
  afterEach(() => {
    cleanup()
  })

  function renderMenu(scopes: NotesSendMenuScope<DiffCommentDeliverySnapshot>[]) {
    render(
      <TooltipProvider>
        <NotesSendMenu
          owner={{ kind: 'worktree', worktreeId: 'wt-1', authority: SELF_LOCAL_AUTHORITY }}
          worktreeId="wt-1"
          groupId="group-1"
          modeIdParts={['wt-1', 'README.md']}
          scopes={scopes}
          onDelivered={() => {}}
        />
      </TooltipProvider>
    )
    return screen.getByRole('button', { name: 'Send notes to an agent' })
  }

  it('does not put a browser title on the enabled send button', () => {
    const button = renderMenu([scope])
    expect(button.getAttribute('title')).toBeNull()
    expect(button.getAttribute('aria-description')).toBeNull()
  })

  it('describes why a disabled send button is disabled without a browser title', () => {
    const button = renderMenu([{ ...scope, notes: [] }])
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBeNull()
    expect(button.getAttribute('aria-description')).toBe('All notes sent')
  })
})
