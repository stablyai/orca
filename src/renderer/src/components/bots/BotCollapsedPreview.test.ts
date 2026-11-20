import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('collapsed bot preview row', () => {
  it('keeps a short row of faces next to the Bots label (#45551)', () => {
    const source = readFileSync(new URL('./BotCollapsedPreview.tsx', import.meta.url), 'utf8')
    const row = source.match(/className="([^"]+)"\s+data-bot-preview=""/)
    expect(row?.[1]).toContain('justify-start')
    expect(row?.[1]).not.toContain('justify-center')
  })
})
