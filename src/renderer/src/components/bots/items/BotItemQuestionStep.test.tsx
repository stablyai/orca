// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItemQuestionShape } from '../../../../../shared/bots/bot-item-ask'
import { BotItemQuestionStep } from './BotItemQuestionStep'
import type { BotItemQuestionSteps, BotItemQuickReplyActions } from './use-bot-item-question-steps'

afterEach(cleanup)

const shape: BotItemQuestionShape = {
  body: '',
  decisions: [
    { question: 'First?', replies: [{ label: 'A', recommended: true }] },
    { question: 'Second?', replies: [{ label: 'B', recommended: false }] },
    { question: 'Third?', replies: [{ label: 'C', recommended: false }] }
  ]
}

const actions: BotItemQuickReplyActions = {
  send: vi.fn(),
  edit: vi.fn(),
  recover: vi.fn(),
  type: vi.fn()
}

function renderStep(heldCount: number, sendHeld = vi.fn()): ReturnType<typeof vi.fn> {
  const held = ['A', 'B', null].map((words, index) => (index < heldCount ? words : null))
  const steps: BotItemQuestionSteps = {
    askId: 'q1',
    shape,
    held,
    current: 2,
    lines: [0, 1, 2],
    go: vi.fn(),
    answer: vi.fn(),
    heldCount,
    sendHeld
  }
  render(
    <BotItemQuestionStep
      shape={shape}
      answered={[null, null, null]}
      steps={steps}
      actions={actions}
    />
  )
  return sendHeld
}

it.each([
  [1, '1 answer not sent yet, send anyway'],
  [2, '2 answers not sent yet, send anyway']
])('reads %i held answers as one sentence ending in the send link', (count, sentence) => {
  const sendHeld = renderStep(count)
  const link = screen.getByRole('button', { name: 'send anyway' })
  expect(link.parentElement?.textContent).toBe(sentence)
  fireEvent.click(link)
  expect(sendHeld).toHaveBeenCalledTimes(1)
})

it('shows no send link while nothing is held', () => {
  renderStep(0)
  expect(screen.queryByRole('button', { name: 'send anyway' })).toBeNull()
  expect(screen.queryByText(/not sent yet,/)).toBeNull()
})
