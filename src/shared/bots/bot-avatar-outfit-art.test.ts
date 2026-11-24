import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOT_MASCOT_IDS } from '../bot-avatar'
import { BOT_AVATAR_OUTFITS } from './bot-avatar-outfit'

const OUTFITS = join(__dirname, '../bot-mascots/outfits')

function art(file: string): Record<string, { art?: string; at?: number[] }> {
  return JSON.parse(readFileSync(join(OUTFITS, file), 'utf8'))
}

describe('outfit art', () => {
  it('has small and large art and a phone sheet for every mascot in every outfit', () => {
    const missing: string[] = []
    for (const outfit of BOT_AVATAR_OUTFITS) {
      const small = art(`${outfit}.json`)
      const large = art(`large/${outfit}.json`)
      for (const id of BOT_MASCOT_IDS) {
        if (!small[id]?.art || small[id]?.at?.length !== 4) {
          missing.push(`${outfit}/${id} small`)
        }
        if (!large[id]?.art) {
          missing.push(`${outfit}/${id} large`)
        }
      }
      if (!existsSync(join(OUTFITS, `${outfit}.webp`))) {
        missing.push(`${outfit} sheet`)
      }
    }
    expect(missing).toEqual([])
  })
})
