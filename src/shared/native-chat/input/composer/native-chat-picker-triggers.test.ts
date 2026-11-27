import { describe, expect, it } from 'vitest'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import { applyPickerSuggestion } from './native-chat-picker-triggers'

function skill(token: string): NativeChatPickerItem {
  return { kind: 'skill', id: token, name: token.slice(1), token, description: null, sources: [] }
}

function pick(text: string, token = '/batch-orchestrate') {
  const caret = text.indexOf('|')
  return applyPickerSuggestion(text.replace('|', ''), caret, skill(token))
}

describe('applyPickerSuggestion', () => {
  it('replaces the whole name when the caret sits inside it', () => {
    expect(pick('/batch-or|chestrate the rest of the prompt')).toEqual({
      draft: '/batch-orchestrate the rest of the prompt',
      caret: 19,
      insertedToken: '/batch-orchestrate',
      replacedEnd: 19
    })
    expect(pick('ask $ba|tch now', '$batch')).toMatchObject({ draft: 'ask $batch now', caret: 11 })
  })

  it('replaces the whole word when the picked name or an alias contains it', () => {
    expect(pick('/orch|estrate the rest')).toMatchObject({
      draft: '/batch-orchestrate the rest'
    })
    expect(pick('/skill:rev|iew the PR', '/skill:review')).toMatchObject({
      draft: '/skill:review the PR'
    })
    expect(pick('/fol|der the PR', '/my-plugin:folder')).toMatchObject({
      draft: '/my-plugin:folder the PR'
    })
    const resume: NativeChatPickerItem = {
      kind: 'command',
      id: 'resume',
      name: 'resume',
      token: '/resume',
      aliases: ['sessions'],
      skillCollision: false
    }
    expect(applyPickerSuggestion('/sess now', 3, resume)).toMatchObject({
      draft: '/resume now',
      replacedEnd: 6
    })
  })

  it('keeps text past the name, including a pill token right after it', () => {
    expect(pick('/batch-or| hello')).toMatchObject({ draft: '/batch-orchestrate hello' })
    expect(pick('run /ba|tch@src/a.ts')).toMatchObject({
      draft: 'run /batch-orchestrate @src/a.ts',
      replacedEnd: 10
    })
  })

  it('keeps a word after the caret that is not the rest of the picked name', () => {
    expect(pick('/|fix the login bug', '/fix-issue')).toMatchObject({
      draft: '/fix-issue fix the login bug',
      replacedEnd: 1
    })
    expect(pick('/rev|fix the login bug', '/review')).toMatchObject({
      draft: '/review fix the login bug'
    })
    expect(pick('ask $|fix_bug_42 now', '$debug')).toMatchObject({
      draft: 'ask $debug fix_bug_42 now'
    })
  })
})
