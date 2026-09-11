// The guard exists because any readiness detector can be wrong, so this suite is a
// two-sided corpus rather than a handful of examples: every LIVE_CREDENTIAL_SURFACE must
// block, and every LEGITIMATE_AGENT_SCREEN must not. A false negative types the user's task
// prompt into a credential field; a false positive only defers until the dialog is answered.
import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_NOUN_RE_FOR_BUDGET,
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

  it('keeps the sentinel a superset over every screen, not just the ones we expect to block', () => {
    // Why both corpora: asserting the superset only over screens we already believe block makes
    // the test as biased as the corpus. The invariant is about the detector's OWN verdict — any
    // screen it matches must survive the prefilter — and that is what caught the main lane
    // silently passing the Antigravity sign-in menu the renderer lane refused.
    for (const [name, lines] of [...LIVE_CREDENTIAL_SURFACES, ...LEGITIMATE_AGENT_SCREENS]) {
      if (findCredentialPromptIndex(screen(lines).toLowerCase()) === null) {
        continue
      }
      const matched = lines.some((line) => TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line))
      expect(matched, name).toBe(true)
    }
  })

  it('keeps the lookbehind-bearing rules linear, not just the sentinel', () => {
    // The sentinel is built from the RAW noun source and carries no lookbehind, so a budget that
    // only exercises it is structurally blind to the rule that has one. Nor can this be measured
    // through `findCredentialPromptIndex`: MAX_CREDENTIAL_LINE_LENGTH caps every row at 512, where
    // a quadratic lookbehind is still only ~1.7x a linear one. Drive the regex directly and assert
    // the complexity CLASS, so the cap stays a safety margin rather than the only thing holding.
    const cost = (length: number): number => {
      const line = `const owner = candidate.${'a'.repeat(length)}`
      const started = performance.now()
      for (let run = 0; run < 200; run += 1) {
        CREDENTIAL_NOUN_RE_FOR_BUDGET.test(line)
      }
      return (performance.now() - started) / 200
    }
    cost(512)
    const base = cost(1024)
    const quadrupled = cost(4096)
    // Linear: 4x the input, ~4x the cost. Quadratic is ~16x; unbounded measured 12.6x here.
    expect(quadrupled).toBeLessThan(base * 8)
  })

  it('keeps the sentinel linear on adversarial lines', () => {
    // The sentinel runs per retained tail line at streaming rate, so a variable-length prefix
    // inside its noun alternation is not a style question: the obvious way to spell the env-var
    // vendor slot (`(?:[a-z0-9]+_)?api[ _-]?key`) costs 30ms on one 5.5k-char line, ~1000x this
    // budget, and stalls the whole tail index.
    const lines = [
      `${'a'.repeat(5000)}${'_'.repeat(500)}`,
      `${'a_'.repeat(2500)}api key${'x'.repeat(200)}`,
      'passwordx'.repeat(500)
    ]
    const started = performance.now()
    for (let run = 0; run < 100; run += 1) {
      for (const line of lines) {
        TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(line)
      }
    }
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not fire on any realistic terminal title', () => {
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      expect(findCredentialPromptIndex(title.toLowerCase()), title).toBeNull()
    }
  })
})
