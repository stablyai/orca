// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  botItemQuestionShape,
  normalizeBotItemAsk,
  type BotItemQuestionShape
} from '../../../../../shared/bots/bot-item-ask'
import { BotItemQuestionStep } from './BotItemQuestionStep'
import type { BotItemQuestionSteps } from './use-bot-item-question-steps'

afterEach(cleanup)

const shape: BotItemQuestionShape = {
  body: '',
  decisions: [
    {
      question: 'Is the token rotated?',
      replies: [
        { label: 'I rotated it; purge the transcript', recommended: true },
        { label: 'Not yet', detail: 'Remind me tomorrow', recommended: false }
      ]
    },
    {
      question: 'Close the item?',
      replies: [{ label: 'Close it', recommended: false }]
    }
  ]
}

function renderLine(held: string | null): void {
  const steps: BotItemQuestionSteps = {
    askId: 'q1',
    shape,
    held: [held, null],
    current: 0,
    lines: [0, 1],
    go: vi.fn(),
    answer: vi.fn()
  }
  const actions = {
    send: vi.fn(),
    edit: vi.fn(),
    recover: vi.fn(),
    type: vi.fn()
  }
  render(
    <BotItemQuestionStep shape={shape} answered={[null, null]} steps={steps} actions={actions} />
  )
}

// The test DOM pads inline boundaries with a space; a browser reads "…transcript, Recommended".
const RECOMMENDED_NAME = /^I rotated it; purge the transcript ?, Recommended$/

// Open, and reopened after picking either reply: the recommended reply keeps its mark.
it.each([null, 'I rotated it; purge the transcript', 'Not yet'])(
  'marks the recommended reply with a star, its name and tooltip (held: %s)',
  (held) => {
    renderLine(held)
    const chip = screen.getByRole('button', { name: RECOMMENDED_NAME })
    expect(chip.querySelector('span[aria-hidden="true"]')?.textContent).toBe('★')
    expect(chip.title).toBe('Recommended')
    expect(chip.getAttribute('aria-pressed')).toBe(
      String(held === 'I rotated it; purge the transcript')
    )
    expect(screen.queryByText('Recommended')).toBeNull()
    const other = screen.getByRole('button', { name: /^Not yet/ })
    expect(other.title).toBe('Remind me tomorrow')
    expect(other.getAttribute('aria-pressed')).toBe(String(held === 'Not yet'))
    expect(other.textContent).not.toContain('★')
  }
)

it('shows one mark for an option the agent also labeled "(Recommended)"', () => {
  const written = botItemQuestionShape({
    ask: normalizeBotItemAsk({
      questions: [
        {
          prompt: 'Ship it?',
          options: [{ label: 'Waive; ship it disclosed (Recommended)' }, { label: 'Fix it first' }]
        }
      ]
    })
  })
  const steps: BotItemQuestionSteps = {
    askId: 'q2',
    shape: written,
    held: [null],
    current: 0,
    lines: [0],
    go: vi.fn(),
    answer: vi.fn()
  }
  const actions = { send: vi.fn(), edit: vi.fn(), recover: vi.fn(), type: vi.fn() }
  render(<BotItemQuestionStep shape={written} answered={[null]} steps={steps} actions={actions} />)
  const chip = screen.getByRole('button', { name: /^Waive; ship it disclosed ?, Recommended$/ })
  expect(chip.textContent).toBe('★Waive; ship it disclosed, Recommended')
  chip.click()
  expect(steps.answer).toHaveBeenCalledWith(0, 'Waive; ship it disclosed')
})
