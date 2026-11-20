import { describe, expect, it } from 'vitest'
import {
  pairedWebChatSignInLine,
  pairedWebServerSignInLine,
  pairedWebSignedOutNotice
} from './paired-web-sign-in-copy'

describe('paired web Orca sign-in copy', () => {
  it('names the server and orca auth login', () => {
    expect(pairedWebServerSignInLine('build')).toBe('On build, run `orca auth login`.')
    expect(pairedWebSignedOutNotice('build')).toBe(
      'build is signed out of Orca. On build, run `orca auth login`.'
    )
    expect(pairedWebChatSignInLine('slack', 'build', 'Scout')).toBe(
      'Slack events need Orca sign-in. On build, run `orca auth login`, then tell Scout.'
    )
    expect(pairedWebChatSignInLine('webhook', 'build', 'Scout')).toBe(
      'Webhooks need Orca sign-in. On build, run `orca auth login`, then tell Scout.'
    )
  })
})
