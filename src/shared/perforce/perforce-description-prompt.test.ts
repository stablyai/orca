import { describe, expect, it } from 'vitest'
import { buildPerforceDescriptionPrompt } from './perforce-description-prompt'

const context = {
  branch: null,
  stagedSummary: 'Perforce changelist 5 (opened files):\nsrc/a.ts',
  stagedPatch: '--- a\n+++ b\n+x'
}

describe('buildPerforceDescriptionPrompt', () => {
  it('asks for a title followed by bullet entries, without git wording', () => {
    const prompt = buildPerforceDescriptionPrompt(context, '')
    expect(prompt).toContain('<changelist title>')
    expect(prompt).toContain('- <description entry 1>')
    expect(prompt).toContain('src/a.ts')
    expect(prompt).not.toMatch(/git commit/i)
    expect(prompt).not.toContain('Additional instructions')
  })

  it('appends the user instructions', () => {
    expect(buildPerforceDescriptionPrompt(context, ' Mention the ticket. ')).toContain(
      'Additional instructions:\nMention the ticket.'
    )
  })
})
