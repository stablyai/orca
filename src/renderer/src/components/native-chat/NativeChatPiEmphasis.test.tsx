// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MessageRow, type MessageRowProps } from './messages/rows/NativeChatMessageRow'

afterEach(cleanup)

function renderRow(
  agent: MessageRowProps['agent'],
  text: string,
  options: { role?: MessageRowProps['message']['role']; live?: boolean } = {}
) {
  return render(
    <TooltipProvider>
      <MessageRow
        agent={agent}
        message={{
          id: 'reply',
          role: options.role ?? 'assistant',
          timestamp: 0,
          source: 'transcript',
          blocks: [{ type: 'text', text }]
        }}
        expandSignal={false}
        activeTurnIsWorking={options.live}
        trailingRun={options.live}
        onScrollMessageToTop={vi.fn()}
      />
    </TooltipProvider>
  ).container
}

function badges(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-pi-emphasis-tone]'), (badge) => ({
    text: badge.textContent,
    tone: badge.getAttribute('data-pi-emphasis-tone')
  }))
}

it('renders known Pi labels in prose without changing code, links, or unknown labels', () => {
  const container = renderRow(
    'pi',
    '**Result:** [[Done]] [[Needs you]] [[Failed: 3 tests]] [[Some note]] `[[Done]]` ' +
      '[Show [[Done]]](#heading)\n\n```md\n[[Done]]\n```'
  )

  expect(badges(container)).toEqual([
    { text: 'Done', tone: 'success' },
    { text: 'Needs you', tone: 'warning' },
    { text: 'Failed: 3 tests', tone: 'danger' }
  ])
  expect(container.textContent).toContain('[[Some note]]')
  expect(container.querySelector('code')?.textContent).toBe('[[Done]]')
  expect(container.querySelector('pre')?.textContent).toContain('[[Done]]')
  expect(container.querySelector('a')?.textContent).toBe('Show [[Done]]')
})

it('renders complete tokens in a live Pi reply without styling an unfinished token', () => {
  const container = renderRow('pi', '[[In progress]] Wait for [[Pas', { live: true })
  expect(badges(container)).toEqual([{ text: 'In progress', tone: 'warning' }])
})

it('limits styling to Pi assistant replies', () => {
  expect(badges(renderRow('pi', '[[Done]]'))).toEqual([{ text: 'Done', tone: 'success' }])
  const plainRows = [
    ['claude', 'assistant'],
    ['pi', 'user'],
    ['pi', 'system']
  ] as const
  for (const [agent, role] of plainRows) {
    const container = renderRow(agent, '[[Done]]', { role })
    expect(badges(container)).toEqual([])
    expect(container.textContent).toContain('[[Done]]')
  }
})
