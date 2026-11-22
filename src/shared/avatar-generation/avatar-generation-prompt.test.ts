import { describe, expect, it } from 'vitest'
import { avatarGenerationPrompt, describesRealPerson } from './avatar-generation-prompt'

describe('describesRealPerson', () => {
  it.each([
    'draw me as a superhero',
    'me as a superhero',
    'my coworker as a wizard',
    'a portrait of me',
    'draw me',
    'my\nwife riding a dragon',
    'my face as a cartoon',
    'a celebrity in a spacesuit'
  ])('turns away %s', (description) => {
    expect(describesRealPerson(description)).toBe(true)
  })

  it.each([
    'a friendly orange fox astronaut',
    'a fox that reminds me of autumn',
    'a photo of a cat',
    'draw me a fox',
    'lion, king of the jungle',
    'portrait of Sherlock Holmes as a cat',
    'the queen of hearts card'
  ])('allows %s', (description) => {
    expect(describesRealPerson(description)).toBe(false)
  })
})

describe('avatarGenerationPrompt', () => {
  it('keeps the subject on one line inside the wrapper', () => {
    const prompt = avatarGenerationPrompt('  a fox\nastronaut  ')
    expect(prompt).toContain('Subject: a fox astronaut ')
    expect(prompt).not.toContain('\n')
  })
})
