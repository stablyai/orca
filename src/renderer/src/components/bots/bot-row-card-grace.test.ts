import { expect, it } from 'vitest'
import { inRowCardGraceArea } from './bot-row-card-grace'

// A card left of a panel whose row the pointer left at its left edge.
const card = { left: 480, top: 100, right: 736, bottom: 220 }
const exit = { x: 776, y: 110 }

it('holds the path from where the pointer left the row to the card', () => {
  expect(inRowCardGraceArea({ x: 770, y: 110 }, exit, card)).toBe(true)
  expect(inRowCardGraceArea({ x: 740, y: 160 }, exit, card)).toBe(true)
  expect(inRowCardGraceArea({ x: 600, y: 150 }, exit, card)).toBe(true)
})

it('drops a pointer heading elsewhere', () => {
  // Back along the panel, to the row's right, or past the card.
  expect(inRowCardGraceArea({ x: 770, y: 300 }, exit, card)).toBe(false)
  expect(inRowCardGraceArea({ x: 790, y: 110 }, exit, card)).toBe(false)
  expect(inRowCardGraceArea({ x: 740, y: 40 }, exit, card)).toBe(false)
  expect(inRowCardGraceArea({ x: 600, y: 260 }, exit, card)).toBe(false)
})
