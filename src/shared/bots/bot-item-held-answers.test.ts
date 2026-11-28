import { expect, it } from 'vitest'
import type { BotItemQuestionShape } from './bot-item-ask'
import {
  botItemHeldAnswer,
  botItemHeldAnswersAfterDelivery,
  botItemHeldAnswersComment,
  readBotItemHeldAnswers,
  writeBotItemHeldAnswers
} from './bot-item-held-answers'

const shape: BotItemQuestionShape = {
  body: '',
  decisions: ['Which hosts?', 'Go ahead?', 'Anything else?'].map((question) => ({
    question,
    replies: []
  }))
}
const review = { name: 'review', path: '/skills/review/SKILL.md' }
const lint = { name: 'lint', path: '/skills/lint/SKILL.md' }

it('stores held answers with their images and skills, and sends them as one comment numbered across lines', () => {
  const stored = writeBotItemHeldAnswers(shape, [
    botItemHeldAnswer('[Image #1] [Image #2] these', ['/a.png', '/b.png'], [review]),
    null,
    botItemHeldAnswer('', ['/c.png'], [review, lint])
  ])
  const held = readBotItemHeldAnswers(shape, stored)
  const comment = botItemHeldAnswersComment(
    shape,
    held,
    botItemHeldAnswer('also [Image #1]', ['/d.png'])
  )
  expect(comment.text).toBe(
    'Which hosts? → [Image #1] [Image #2] these\nAnything else? → [Image #3]\nalso [Image #4]'
  )
  expect(comment.paths).toEqual(['/a.png', '/b.png', '/c.png', '/d.png'])
  expect(comment.skills).toEqual([review, lint])
  expect(comment.answers).toEqual(['[Image #1] [Image #2] these', null, '[Image #3]'])
  expect(comment.rideAlongText).toBe('also [Image #1]')
})

it('reads and sends answers an older build held as "Question → words" text', () => {
  const old = 'Which hosts? → the internal ones\nGo ahead? → Yes'
  const held = readBotItemHeldAnswers(shape, old)
  expect(held).toEqual([
    { words: 'the internal ones', images: [], skills: [] },
    { words: 'Yes', images: [], skills: [] },
    null
  ])
  expect(botItemHeldAnswersComment(shape, held)).toEqual({
    text: old,
    paths: [],
    skills: [],
    answers: ['the internal ones', 'Yes', null]
  })
  // Delivered, the first leaves; what stays is stored in the current form.
  const after = botItemHeldAnswersAfterDelivery(old, {
    askId: 'e1',
    shape,
    answers: ['the internal ones', null, null]
  })
  expect(readBotItemHeldAnswers(shape, after)).toEqual([null, held[1], null])
})

it('clears on delivery only the lines still holding what was sent, and lines of questions added since stay', () => {
  const asked = { body: '', decisions: shape.decisions.slice(0, 2) }
  const stored = writeBotItemHeldAnswers(shape, [
    botItemHeldAnswer('[Image #1] here', ['/b.png']),
    botItemHeldAnswer('changed since'),
    botItemHeldAnswer('appended later')
  ])
  // The send numbered the first line's image after another's.
  const after = botItemHeldAnswersAfterDelivery(stored, {
    askId: 'e1',
    shape: asked,
    answers: ['[Image #2] here', 'as sent']
  })
  expect(readBotItemHeldAnswers(shape, after).map((answer) => answer?.words ?? null)).toEqual([
    null,
    'changed since',
    'appended later'
  ])
  expect(
    botItemHeldAnswersAfterDelivery(after, {
      askId: 'e1',
      shape: asked,
      answers: [null, 'changed since']
    })
  ).toBe(writeBotItemHeldAnswers(shape, [null, null, botItemHeldAnswer('appended later')]))
})
