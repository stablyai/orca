// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatMentionNamesContext } from '../native-chat-markdown-mentions'
import { NativeChatBotItemNoteRow } from './NativeChatBotItemNoteRow'

afterEach(cleanup)

const ROOM = ['Maya']

it("draws the owner's item comment as chat draws their message: mention chips and Markdown", () => {
  const { container } = render(
    <TooltipProvider>
      <NativeChatMentionNamesContext.Provider value={ROOM}>
        <NativeChatBotItemNoteRow
          note={{
            noteId: 'n1',
            by: 'owner',
            entries: [
              {
                uid: 'item-1',
                number: 1,
                title: 'Share links',
                status: 'working',
                event: 'commented',
                text: 'ask [Bot: Layout owner](bot:b-1) and @Maya about **the default**'
              }
            ]
          }}
        />
      </NativeChatMentionNamesContext.Provider>
    </TooltipProvider>
  )
  const chips = [...container.querySelectorAll('[data-orca-mention]')].map(
    (chip) => chip.textContent
  )
  expect(chips).toEqual(['@Layout owner', '@Maya'])
  expect(container.querySelector('strong')?.textContent).toBe('the default')
  expect(container.textContent).not.toContain('](bot:')
  expect(container.textContent).not.toContain('**')
})
