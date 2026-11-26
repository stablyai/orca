// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { BotItemMarkdown } from './BotItemMarkdown'

afterEach(cleanup)

const fenced =
  'Run:\n\n```powershell\nGet-Item a\nGet-Item b\n```\n\nand bare:\n\n```\nplain text\n```'

it('draws item fences with the chat code block: language, wrap and copy', () => {
  const { container } = render(<BotItemMarkdown text={fenced} />)
  expect(container.querySelectorAll('[data-native-chat-code-block]')).toHaveLength(2)
  expect(container.querySelector('[data-code-language="powershell"]')).not.toBeNull()
  expect(screen.getAllByRole('button', { name: 'Wrap lines' })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Copy code' })).toHaveLength(2)
  const bare = container.querySelectorAll('[data-native-chat-code-content]')[1]
  expect(bare.querySelector('code')?.className).toContain('[pre_&]:bg-transparent')
})

it('keeps compact fences as a bare bounded pre without a code block renderer', () => {
  const { container } = render(<CommentMarkdown content={fenced} />)
  const pres = container.querySelectorAll('pre')
  expect(pres).toHaveLength(2)
  expect(pres[0].className).toBe(
    'my-1 max-h-32 max-w-full overflow-x-auto rounded bg-accent p-1.5 text-[10px] font-mono'
  )
  expect(pres[1].querySelector('code')?.className).toBe(
    'rounded bg-accent px-1 py-px text-[10px] font-mono [overflow-wrap:anywhere]'
  )
  expect(container.querySelector('[data-native-chat-code-block]')).toBeNull()
  expect(container.querySelector('button')).toBeNull()
})
