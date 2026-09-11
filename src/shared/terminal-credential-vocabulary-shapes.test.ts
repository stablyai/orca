// The generative half of the corpus. Three false-positive classes reached a PR past a hand-written
// two-sided corpus — narration position, then localized punctuation, then formatted source — and
// every one was a term the corpus already contained, sitting in a position nobody had written down.
// A curated corpus can only ever assert what someone thought of.
//
// So this crosses the detector's OWN vocabulary against the shapes a term appears in when it is
// output rather than a prompt, and it grows by itself: add a noun to CREDENTIAL_NOUN_SOURCE and it
// is immediately checked in every shape, above every agent's composer caret.
import { describe, expect, it } from 'vitest'
import { findCredentialPromptIndex } from './terminal-credential-prompt-detection'
import {
  AGENT_COMPOSER_TAILS,
  asPropertyAccess,
  AUTH_FLOW_SAMPLES,
  AUTH_VERB_SAMPLES,
  CORROBORATION_SEEKING_BOTTOM_ROWS,
  CREDENTIAL_NOUN_SAMPLES,
  NON_PROMPT_ROW_SHAPES
} from './terminal-credential-vocabulary-shapes'

function blocks(lines: string[]): boolean {
  return findCredentialPromptIndex(lines.join('\n').toLowerCase()) !== null
}

describe('credential vocabulary in non-prompt shapes', () => {
  it('expands the detector vocabulary into usable sample phrases', () => {
    // Guards the expander: if it silently produced nothing, every case below would pass vacuously.
    expect(CREDENTIAL_NOUN_SAMPLES.length).toBeGreaterThanOrEqual(12)
    expect(AUTH_FLOW_SAMPLES.length).toBeGreaterThanOrEqual(8)
    expect(CREDENTIAL_NOUN_SAMPLES).toContain('password')
    expect(CREDENTIAL_NOUN_SAMPLES).toContain('api key')
  })

  it('still refuses each noun in an actual ask, so the shapes below are not vacuous', () => {
    // If the detector stopped matching entirely, every negative case would pass. This is the
    // positive control that keeps the suite honest.
    for (const noun of CREDENTIAL_NOUN_SAMPLES) {
      expect(blocks([`Enter your ${noun}:`]), noun).toBe(true)
    }
  })

  it('does not fire on any vocabulary term in any non-prompt shape above any composer', () => {
    const refusals: string[] = []
    for (const term of [...CREDENTIAL_NOUN_SAMPLES, ...AUTH_FLOW_SAMPLES]) {
      for (const shape of NON_PROMPT_ROW_SHAPES) {
        const row = shape(term)
        for (const [agent, tail] of AGENT_COMPOSER_TAILS) {
          if (blocks([row, ...tail])) {
            refusals.push(`[${agent}] ${row}`)
          }
        }
      }
    }
    expect(refusals, `${refusals.length} refusals:\n${refusals.join('\n')}`).toEqual([])
  })

  it('never lets an identifier corroborate a bottom row that is asking for something', () => {
    // `\b` treats `.` as a word boundary, so `candidate.login` reads as the auth verb "log in" and
    // can be the ONLY thing that turns an otherwise-inert bottom row into a refusal. No composer
    // caret here, and the bottom row genuinely leads with an action phrase, so nothing else is
    // holding these clean.
    const refusals: string[] = []
    for (const term of [...AUTH_VERB_SAMPLES, ...CREDENTIAL_NOUN_SAMPLES]) {
      for (const bottomRow of CORROBORATION_SEEKING_BOTTOM_ROWS) {
        if (blocks([asPropertyAccess(term), bottomRow])) {
          refusals.push(`${asPropertyAccess(term)} / ${bottomRow}`)
        }
      }
    }
    expect(refusals, `${refusals.length} refusals:\n${refusals.join('\n')}`).toEqual([])
  })
})
