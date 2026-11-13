import { describe, expect, it } from 'vitest'
import { splitGeneratedCommitMessage } from './commit-message-generation'

describe('splitGeneratedCommitMessage', () => {
  it('keeps a subject longer than 72 characters intact instead of chopping mid-word', () => {
    const subject =
      'feat(find, contribute): offer type-specific add actions on empty local results (#62)'

    expect(splitGeneratedCommitMessage(`${subject}\n\n- Why`)).toEqual({
      subject,
      body: '- Why',
      message: `${subject}\n\n- Why`
    })
  })
})
