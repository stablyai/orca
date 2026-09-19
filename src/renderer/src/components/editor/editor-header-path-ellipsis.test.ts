import { describe, expect, it } from 'vitest'
import { ellipsizePathStart } from './editor-header-path-ellipsis'

const CHARACTER_WIDTH = 10

/** Monospace stand-in so a width in pixels maps to a character count. */
function measureByCharacter(text: string): number {
  return text.length * CHARACTER_WIDTH
}

function widthForCharacters(count: number): number {
  return count * CHARACTER_WIDTH
}

const ICLOUD_PATH =
  '/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Ebrain/Projects/Onboarding Questions.md'

describe('ellipsizePathStart', () => {
  it('returns the path unchanged when it fits', () => {
    expect(
      ellipsizePathStart(ICLOUD_PATH, widthForCharacters(ICLOUD_PATH.length), measureByCharacter)
    ).toBe(ICLOUD_PATH)
  })

  it('drops leading segments until the path fits', () => {
    expect(ellipsizePathStart(ICLOUD_PATH, widthForCharacters(45), measureByCharacter)).toBe(
      '…/Ebrain/Projects/Onboarding Questions.md'
    )
  })

  it('drops more segments as the available width shrinks', () => {
    expect(ellipsizePathStart(ICLOUD_PATH, widthForCharacters(30), measureByCharacter)).toBe(
      '…/Onboarding Questions.md'
    )
  })

  it('keeps whole segments rather than cutting mid-segment', () => {
    const result = ellipsizePathStart(ICLOUD_PATH, widthForCharacters(70), measureByCharacter)
    expect(result.startsWith('…/')).toBe(true)
    expect(ICLOUD_PATH.endsWith(result.slice(2))).toBe(true)
  })

  it('never drops the file name, leaving CSS to trim it', () => {
    expect(ellipsizePathStart(ICLOUD_PATH, widthForCharacters(5), measureByCharacter)).toBe(
      'Onboarding Questions.md'
    )
  })

  it('uses the backslash separator for Windows paths', () => {
    const windowsPath = 'C:\\Users\\example\\Documents\\Ebrain\\Projects\\Onboarding Questions.md'
    expect(ellipsizePathStart(windowsPath, widthForCharacters(45), measureByCharacter)).toBe(
      '…\\Ebrain\\Projects\\Onboarding Questions.md'
    )
  })

  it('returns a bare file name unchanged when it has no separators', () => {
    expect(ellipsizePathStart('Questions.md', widthForCharacters(4), measureByCharacter)).toBe(
      'Questions.md'
    )
  })

  it('keeps a trailing display suffix attached to the file name', () => {
    expect(
      ellipsizePathStart(`${ICLOUD_PATH} (diff)`, widthForCharacters(35), measureByCharacter)
    ).toBe('…/Onboarding Questions.md (diff)')
  })

  it('returns the label unchanged when the width is not yet measurable', () => {
    expect(ellipsizePathStart(ICLOUD_PATH, 0, measureByCharacter)).toBe(ICLOUD_PATH)
  })

  it('returns an empty label unchanged', () => {
    expect(ellipsizePathStart('', widthForCharacters(10), measureByCharacter)).toBe('')
  })
})
