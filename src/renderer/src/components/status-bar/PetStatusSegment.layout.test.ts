import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('PetStatusSegment layout', () => {
  it('does not reserve fixed right padding on the pet menu trigger', () => {
    const source = readFileSync(join(__dirname, 'PetStatusSegment.tsx'), 'utf8')

    // Why: the old pr-[6.5rem] reserved ~104px of empty space after the label and
    // shoved neighboring status-bar segments left; unit-guard so CI catches a
    // reintroduction without needing Electron Playwright.
    expect(source).not.toMatch(/pr-\[\d+(?:\.\d+)?rem\]/)
    expect(source).toMatch(/className="group inline-flex items-center cursor-pointer pl-1 py-0\.5"/)
  })
})
