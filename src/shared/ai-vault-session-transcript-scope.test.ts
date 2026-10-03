import { describe, expect, it } from 'vitest'
import { transcriptLineMatchesSearchScope } from './ai-vault-session-transcript-scope'

const USER_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'alpha-user-prompt please review pairing' }
})

const ASSISTANT_PROSE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: 'alpha-assistant-prose I would try a smaller retry window' },
      {
        type: 'tool_use',
        id: 'toolu-1',
        name: 'Bash',
        input: { command: 'cat alpha-tool-secret-only' }
      }
    ]
  }
})

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu-1',
        content: 'alpha-tool-result-only printed from the shell'
      }
    ]
  }
})

const CODEX_FUNCTION_CALL_LINE = JSON.stringify({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'shell',
    arguments: JSON.stringify({ command: 'echo alpha-function-call-only' })
  }
})

const ERROR_LINE = JSON.stringify({
  type: 'error',
  error: { message: 'alpha-rate-limit exceeded for the current hour' }
})

const TITLE_ONLY_LINE = JSON.stringify({
  type: 'custom-title',
  customTitle: 'alpha-title-only display name'
})

describe('transcriptLineMatchesSearchScope', () => {
  it('matches full text across user, assistant, tool, and error lines', () => {
    expect(transcriptLineMatchesSearchScope(USER_LINE, 'alpha-user-prompt', 'full')).toBe(true)
    expect(
      transcriptLineMatchesSearchScope(ASSISTANT_PROSE_LINE, 'alpha-assistant-prose', 'full')
    ).toBe(true)
    expect(
      transcriptLineMatchesSearchScope(ASSISTANT_PROSE_LINE, 'alpha-tool-secret-only', 'full')
    ).toBe(true)
    expect(
      transcriptLineMatchesSearchScope(TOOL_RESULT_LINE, 'alpha-tool-result-only', 'full')
    ).toBe(true)
    expect(transcriptLineMatchesSearchScope(ERROR_LINE, 'alpha-rate-limit', 'full')).toBe(true)
  })

  it('excludes tool_use, tool_result, and function_call hits from without-tools', () => {
    expect(
      transcriptLineMatchesSearchScope(
        ASSISTANT_PROSE_LINE,
        'alpha-tool-secret-only',
        'fullWithoutTools'
      )
    ).toBe(false)
    expect(
      transcriptLineMatchesSearchScope(
        TOOL_RESULT_LINE,
        'alpha-tool-result-only',
        'fullWithoutTools'
      )
    ).toBe(false)
    expect(
      transcriptLineMatchesSearchScope(
        CODEX_FUNCTION_CALL_LINE,
        'alpha-function-call-only',
        'fullWithoutTools'
      )
    ).toBe(false)
    expect(
      transcriptLineMatchesSearchScope(
        ASSISTANT_PROSE_LINE,
        'alpha-assistant-prose',
        'fullWithoutTools'
      )
    ).toBe(true)
    expect(
      transcriptLineMatchesSearchScope(USER_LINE, 'alpha-user-prompt', 'fullWithoutTools')
    ).toBe(true)
  })

  it('keeps user-turn matches out of assistant and error scopes', () => {
    expect(transcriptLineMatchesSearchScope(USER_LINE, 'alpha-user-prompt', 'user')).toBe(true)
    expect(transcriptLineMatchesSearchScope(USER_LINE, 'alpha-user-prompt', 'assistant')).toBe(
      false
    )
    expect(transcriptLineMatchesSearchScope(USER_LINE, 'alpha-user-prompt', 'errors')).toBe(false)
    expect(
      transcriptLineMatchesSearchScope(ASSISTANT_PROSE_LINE, 'alpha-assistant-prose', 'user')
    ).toBe(false)
    expect(
      transcriptLineMatchesSearchScope(ASSISTANT_PROSE_LINE, 'alpha-assistant-prose', 'assistant')
    ).toBe(true)
    expect(
      transcriptLineMatchesSearchScope(ASSISTANT_PROSE_LINE, 'alpha-tool-secret-only', 'assistant')
    ).toBe(false)
  })

  it('matches error records and ignores the word error in a user prompt', () => {
    const userMentionedError = JSON.stringify({
      type: 'user',
      message: { content: 'I hit an error while pairing' }
    })
    expect(transcriptLineMatchesSearchScope(ERROR_LINE, 'alpha-rate-limit', 'errors')).toBe(true)
    expect(transcriptLineMatchesSearchScope(userMentionedError, 'pairing', 'errors')).toBe(false)
    expect(transcriptLineMatchesSearchScope(userMentionedError, 'pairing', 'user')).toBe(true)
  })

  it('does not treat title metadata as a user or assistant turn', () => {
    expect(transcriptLineMatchesSearchScope(TITLE_ONLY_LINE, 'alpha-title-only', 'user')).toBe(
      false
    )
    expect(transcriptLineMatchesSearchScope(TITLE_ONLY_LINE, 'alpha-title-only', 'assistant')).toBe(
      false
    )
    expect(transcriptLineMatchesSearchScope(TITLE_ONLY_LINE, 'alpha-title-only', 'full')).toBe(true)
  })
})
