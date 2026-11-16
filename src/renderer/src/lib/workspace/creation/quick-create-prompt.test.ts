import { describe, expect, it } from 'vitest'
import { resolveQuickCreatePrompt } from './quick-create-prompt'

const issue = { number: 42, url: 'https://github.com/acme/app/issues/42', title: 'Fix retry' }

describe('resolveQuickCreatePrompt', () => {
  it('keeps the linked-item draft behaviour when no prompt was typed', () => {
    expect(
      resolveQuickCreatePrompt({ typedPrompt: '   ', linkedWorkItem: issue, note: '' })
    ).toEqual({
      prompt: '',
      draftPrompt: issue.url
    })
  })

  it('auto-submits a typed prompt', () => {
    expect(
      resolveQuickCreatePrompt({
        typedPrompt: ' fix the flaky test ',
        linkedWorkItem: null,
        note: ''
      })
    ).toEqual({ prompt: 'fix the flaky test', draftPrompt: null })
  })

  it('keeps the note of a Linear typed-only item that has no draft context', () => {
    expect(
      resolveQuickCreatePrompt({
        typedPrompt: 'fix it',
        linkedWorkItem: { number: 0, url: '' },
        note: 'be careful'
      })
    ).toEqual({ prompt: 'fix it\n\nbe careful', draftPrompt: null })
  })

  it('appends linked-item context to a typed prompt', () => {
    expect(
      resolveQuickCreatePrompt({ typedPrompt: 'fix it', linkedWorkItem: issue, note: 'be careful' })
    ).toEqual({ prompt: `fix it\n\nbe careful\n\n${issue.url}`, draftPrompt: null })
  })
})
