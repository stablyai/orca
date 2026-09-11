// The guard exists because any readiness detector can be wrong, so this suite is a
// two-sided corpus rather than a handful of examples: every LIVE_CREDENTIAL_SURFACE must
// block, and every LEGITIMATE_AGENT_SCREEN must not. A false negative types the user's task
// prompt into a credential field; a false positive only defers until the dialog is answered.
import { describe, expect, it } from 'vitest'
import {
  findCredentialPromptIndex,
  TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE
} from './terminal-credential-prompt-detection'
import { LEGITIMATE_AGENT_SCREENS } from './terminal-legitimate-agent-screens-corpus'
import { LIVE_CREDENTIAL_SURFACES } from './terminal-live-credential-surfaces-corpus'
import { TERMINAL_TITLE_CLASSIFICATION_CORPUS } from './terminal-title-classification-corpus'

function screen(lines: string[]): string {
  return lines.join('\n')
}

describe('findCredentialPromptIndex', () => {
  it.each(LIVE_CREDENTIAL_SURFACES)('blocks %s', (_name, lines) => {
    expect(findCredentialPromptIndex(screen(lines).toLowerCase())).not.toBeNull()
  })

  it.each(LEGITIMATE_AGENT_SCREENS)('does not fire on %s', (_name, lines) => {
    expect(findCredentialPromptIndex(screen(lines).toLowerCase())).toBeNull()
  })

  it('ignores an answered credential prompt that scrolled out of the live window', () => {
    const tail = screen([
      'Enter your API key:',
      '',
      'Signed in as neil@example.com.',
      '',
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '',
      '› Ask Codex to do anything'
    ])
    expect(findCredentialPromptIndex(tail.toLowerCase())).toBeNull()
  })

  it('keeps the sentinel a superset of everything the detector matches', () => {
    // The retained-tail index skips any tail the sentinel rejects, so a detector match the
    // sentinel misses would never be parsed at all.
    for (const [name, lines] of LIVE_CREDENTIAL_SURFACES) {
      const matched = lines.some((line) => TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line))
      expect(matched, name).toBe(true)
    }
  })

  it('does not fire on any realistic terminal title', () => {
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      expect(findCredentialPromptIndex(title.toLowerCase()), title).toBeNull()
    }
  })
})
