import { expect, it } from 'vitest'
import { withOrcaClaudeChatEntrypoint } from './claude-chat-entrypoint'

it('gives the SDK one exact chat identity after differently cased configured values', () => {
  expect(
    withOrcaClaudeChatEntrypoint(
      {
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        claude_code_entrypoint: 'configured',
        PATH: 'C:\\bin',
        CLAUDE_CODE_SESSION_ID: 'deliberate'
      },
      'win32'
    )
  ).toEqual({
    CLAUDE_CODE_ENTRYPOINT: 'orca',
    PATH: 'C:\\bin',
    CLAUDE_CODE_SESSION_ID: 'deliberate'
  })
})
