// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceEmojiSuggestionPopover } from './WorkspaceEmojiSuggestionPopover'
import type { WorkspaceEmojiSuggestion } from '@/lib/workspace-emoji-shortcodes'

Element.prototype.scrollIntoView ??= () => {}

const SUGGESTIONS: WorkspaceEmojiSuggestion[] = [
  { shortcode: 'smile', emoji: '😄' },
  { shortcode: 'smiley', emoji: '😃' },
  { shortcode: 'smirk', emoji: '😏' }
]

function PopoverHarness({ commandValue }: { commandValue: string }): React.JSX.Element {
  const anchorRef = useRef<HTMLInputElement>(null)

  return (
    <div>
      <input ref={anchorRef} aria-label="Workspace name" readOnly value=":smi" />
      <WorkspaceEmojiSuggestionPopover
        anchorRef={anchorRef}
        commandValue={commandValue}
        heading="Emoji"
        onCommandValueChange={() => {}}
        onOpenChange={() => {}}
        onSelect={() => {}}
        open
        suggestions={SUGGESTIONS}
      />
    </div>
  )
}

describe('WorkspaceEmojiSuggestionPopover', () => {
  let scrollIntoView: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(() => {
    scrollIntoView.mockRestore()
    cleanup()
  })

  it('scrolls the externally selected suggestion into view', async () => {
    const { rerender } = render(<PopoverHarness commandValue="emoji:smile" />)
    await screen.findByText(':smirk:')
    scrollIntoView.mockClear()

    rerender(<PopoverHarness commandValue="emoji:smirk" />)

    const scrolled = scrollIntoView.mock.instances as unknown as Element[]
    expect(scrolled.some((node) => node.getAttribute('data-value') === 'emoji:smirk')).toBe(true)
  })
})
