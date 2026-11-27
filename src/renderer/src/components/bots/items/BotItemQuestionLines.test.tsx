// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { botItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { BotItemQuestionLines } from './BotItemQuestionLines'
import { BotItemAnswerLine } from './BotItemQuestionStep'

afterEach(cleanup)

it('draws a saved free-text answer as Markdown, its bot mention as a chip', () => {
  const shape = botItemQuestionShape({
    text: 'Merge it now?',
    ask: { questions: [{ prompt: 'Merge it now?', options: [{ label: 'Merge it' }] }] }
  })
  const answer: BotItemEvent = {
    id: 'a1',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: {
      text: 'Ask [Bot: Reviewer](bot:bot-2) to check **bold** and `code` first',
      answers: 'q1'
    },
    at: 1
  }
  const { container } = render(
    <BotItemQuestionLines shape={shape} askId="q1" waiting={false} answers={[answer]} />
  )
  expect(container.textContent).toContain('Merge it now? →')
  expect(container.querySelector('strong')?.textContent).toBe('bold')
  expect(container.querySelector('code')?.textContent).toBe('code')
  expect(container.querySelector('[data-orca-mention]')?.textContent).toContain('Reviewer')
  expect(container.textContent).not.toMatch(/\*\*|`|bot:bot-2/)
  // The line holds the answer's Markdown blocks, so it is no <p>.
  expect(container.querySelector('p p, p div')).toBeNull()
})

function owner(text: string): BotItemEvent {
  return { id: 'a1', kind: 'commented', actor: { kind: 'owner' }, data: { text }, at: 1 }
}

it('keeps a picked quick reply as its chip wrote it, Markdown-like or not', () => {
  const one = botItemQuestionShape({
    text: 'Merge it now?',
    ask: { questions: [{ prompt: 'Merge it now?', options: [{ label: '1. Merge it' }] }] }
  })
  const { container, unmount } = render(
    <BotItemQuestionLines shape={one} askId="q1" waiting={false} answers={[owner('1. Merge it')]} />
  )
  expect(container.textContent).toBe('Merge it now? → 1. Merge it')
  expect(container.querySelector('ol')).toBeNull()
  unmount()
  const spaced = botItemQuestionShape({
    text: 'Merge it now?',
    ask: { questions: [{ prompt: 'Merge it now?', options: [{ label: '1.  Two  spaces' }] }] }
  })
  const spacedLine = render(
    <BotItemQuestionLines
      shape={spaced}
      askId="q1"
      waiting={false}
      answers={[owner('1.  Two  spaces')]}
    />
  )
  expect(spacedLine.container.textContent).toBe('Merge it now? → 1.  Two  spaces')
  expect(spacedLine.container.querySelector('ol')).toBeNull()
  spacedLine.unmount()
  const several = botItemQuestionShape({
    text: 'Plan',
    ask: {
      questions: [
        {
          prompt: 'Files?',
          multi: true,
          options: [{ label: '# Ship' }, { label: 'Keep __init__.py' }]
        },
        { prompt: 'Then?', options: [{ label: '- skip' }] }
      ]
    }
  })
  const reply = owner('Files? → # Ship, Keep __init__.py\nThen? → - skip')
  render(
    <BotItemQuestionLines shape={several} askId="q1" waiting={false} answers={[reply, reply]} />
  )
  expect(document.body.textContent).toContain('Files? → # Ship, Keep __init__.py')
  expect(document.body.textContent).toContain('Then? → - skip')
  expect(document.body.querySelector('h1, ul, strong')).toBeNull()
})

it('keeps the line breaks of plain answer words, as a send on its way shows them', () => {
  const { container } = render(<BotItemAnswerLine question="Why?" words={'First\nSecond'} />)
  const words = container.querySelector('span.whitespace-pre-line')
  expect(words?.textContent).toBe('First\nSecond')
})
