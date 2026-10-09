import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createRepoUpdateSchema } from './repo-update-params'

const schema = createRepoUpdateSchema({ repo: z.string() })

describe('repo.update terminalTheme params', () => {
  it('keeps a normalized override', () => {
    const parsed = schema.parse({
      repo: 'r1',
      updates: { terminalTheme: { dark: ' Dracula ', light: 'custom:ghostty:abc' } }
    })
    expect(parsed.updates.terminalTheme).toEqual({ dark: 'Dracula', light: 'custom:ghostty:abc' })
  })

  it('passes null through as the clear sentinel', () => {
    const parsed = schema.parse({ repo: 'r1', updates: { terminalTheme: null } })
    expect(parsed.updates.terminalTheme).toBeNull()
  })

  it('maps garbage to undefined', () => {
    for (const terminalTheme of ['Dracula', 5, [], { dark: 5 }, { dark: '  ' }]) {
      const parsed = schema.parse({ repo: 'r1', updates: { terminalTheme } })
      expect(parsed.updates.terminalTheme).toBeUndefined()
    }
  })

  it('strips unknown inner keys', () => {
    const parsed = schema.parse({
      repo: 'r1',
      updates: { terminalTheme: { dark: 'Dracula', extra: 'nope' } }
    })
    expect(parsed.updates.terminalTheme).toEqual({ dark: 'Dracula' })
  })

  it('leaves the field absent when omitted', () => {
    const parsed = schema.parse({ repo: 'r1', updates: { displayName: 'x' } })
    expect(parsed.updates.terminalTheme).toBeUndefined()
  })
})
