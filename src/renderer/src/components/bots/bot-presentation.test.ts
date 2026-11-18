import { describe, expect, it } from 'vitest'
import { botErrorMessage } from './bot-presentation'
import { botFolderPreview } from './BotRunsOnPicker'

describe('botErrorMessage', () => {
  it('names a taken name and hides other codes', () => {
    expect(botErrorMessage(new Error('bot_name_taken'))).toBe('Another bot already has that name.')
    expect(botErrorMessage(new Error('runtime_unavailable'))).toBe(
      'Something went wrong. Try again.'
    )
  })
})

describe('botFolderPreview', () => {
  it('shows the folder the runtime would create', () => {
    expect(botFolderPreview('Code Reviewer', [], false)).toBe('~/.orca/bots/code-reviewer')
    expect(botFolderPreview('', [], false)).toBe('~/.orca/bots/new-bot')
    expect(botFolderPreview('Scout', [], true)).toBe('%USERPROFILE%\\.orca\\bots\\scout')
  })
})
