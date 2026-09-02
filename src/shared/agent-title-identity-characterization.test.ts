import { describe, expect, it } from 'vitest'
import { getAgentLabel } from './agent-title-identity'

/**
 * Characterization of `getAgentLabel` before the identity refactor.
 *
 * `getAgentLabel` is an ordered first-match-wins scan of title predicates. Detector precedence
 * and targeted exceptions — not a unified evidence model — decide identity. These tests pin
 * the current answers, including the wrong ones, so the resolver change shows up as a
 * reviewable diff of assertions rather than as silent behavior drift.
 *
 * Cases marked DEFECT are minimized from real recorded pane titles
 * (`terminal-history/<id>/checkpoint.json` -> `lastTitle`). At the time of writing the live
 * corpus held 2,846 checkpoints / 1,084 populated titles / 747 distinct, of which 5 real titles
 * resolved to the wrong agent. Task text is minimized here; the corpus stays local.
 */

/** Orca's own owner suffix: the agent that owns the pane is named after the final `- `. */
const ownerSuffix = (task: string, agent: string): string => `${task}… - ${agent}`

describe('getAgentLabel — characterization (pre-refactor)', () => {
  describe('the owner suffix loses to a foreign name in task text', () => {
    // DEFECT. In each case the pane owner is Grok, named by Orca's own `- grok` suffix
    // grammar, while the competing agent appears only inside free-form task text. Codex is
    // checked before Grok, so the weaker evidence wins.
    it.each([
      ['Switch Claude and Codex off the load balancer', 'Codex'],
      ['Codex structured chat revalidation', 'Codex'],
      ['Swap Codex off the load balancer', 'Codex']
    ])('reads %j as %s instead of Grok', (task, current) => {
      expect(getAgentLabel(ownerSuffix(task, 'grok'))).toBe(current)
    })

    it('reads a spinner-prefixed Grok pane as Codex', () => {
      // DEFECT. Real shape: a status spinner and phase precede the task text.
      expect(getAgentLabel(`⠸ - Thinking - ${ownerSuffix('Codex native-chat work', 'grok')}`)).toBe(
        'Codex'
      )
    })

    it('resolves a Grok pane naming two other agents, but only by a targeted exception', () => {
      // Fixed by #15535, which teaches the Gemini token branch to decline when an Antigravity
      // name is present. Correct here only because that exception happens to clear the path to
      // Grok — drop the word "Antigravity" and it reads as Gemini CLI again (next case).
      expect(
        getAgentLabel(ownerSuffix('Electron QA: Antigravity tab vs Gemini label', 'grok'))
      ).toBe('Grok')
    })

    it('still reads a Grok pane as Gemini CLI when no exception covers the pair', () => {
      // DEFECT, and the general form of the case above: one narrowing fixes one collision.
      expect(getAgentLabel(ownerSuffix('Electron QA: check the Gemini label', 'grok'))).toBe(
        'Gemini CLI'
      )
    })

    it('resolves the owner suffix correctly only when no earlier agent is named', () => {
      // Why this passes today: nothing earlier in the chain matches, so position never comes up.
      expect(getAgentLabel(ownerSuffix('Fix the sidebar row', 'grok'))).toBe('Grok')
    })
  })

  describe('a hyphenated worktree name is correctly not identity', () => {
    // Not a defect — pinned so the resolver does not start claiming these.
    it.each(['review-14600-codex', 'sta4779-review-codex', 'codex-split-core'])(
      'declines %j',
      (title) => {
        expect(getAgentLabel(title)).toBeNull()
      }
    )
  })

  describe('title order does not decide between two names', () => {
    // Both orderings of each pair agree: detector precedence and its targeted exceptions,
    // rather than name order within the title, choose the label.
    it.each([
      ['codex', 'grok', 'Codex'],
      ['grok', 'codex', 'Codex'],
      ['gemini', 'antigravity', 'Antigravity'],
      ['antigravity', 'gemini', 'Antigravity'],
      ['copilot', 'devin', 'GitHub Copilot'],
      ['devin', 'copilot', 'GitHub Copilot']
    ])('%s + %s both resolve to %s', (first, second, winner) => {
      expect(getAgentLabel(`${first} and ${second}`)).toBe(winner)
    })
  })

  describe('a vendor glyph is claimed by whichever check sits earliest', () => {
    it('claims a Claude glyph even when the task text names another agent', () => {
      // Correct today (the pane really is Claude) but for the wrong reason: the glyph is not
      // consulted as vendor evidence, the `✳ ` prefix branch simply sits first.
      expect(getAgentLabel('✳ Fix Codex false attention notifications on Windows')).toBe(
        'Claude Code'
      )
    })

    it('gives a bare agent name no way to outrank an earlier glyph check', () => {
      // DEFECT. `agy` is the entire undecorated remainder — the strongest possible name
      // evidence — and still loses to Claude's prefix glyph.
      expect(getAgentLabel('✳ agy')).toBe('Claude Code')
    })
  })

  describe('Antigravity model names', () => {
    it('reads a bare Antigravity model title as Gemini CLI', () => {
      // DEFECT. Antigravity models are named `Gemini <n.n> <Name>`, so an agy pane's own title
      // carries a whole `gemini` token, and Gemini CLI is checked first.
      expect(getAgentLabel('Gemini 3.7 Flash · high')).toBe('Gemini CLI')
    })

    it('resolves once the Antigravity name is also present', () => {
      // Fixed by #15535. The resolver reaches the same answer structurally — the agy segment is
      // the anchored identity and `Gemini <n.n> <Name>` is model metadata — rather than by
      // teaching one detector about one competitor.
      expect(getAgentLabel('agy · Gemini 3.7 Flash')).toBe('Antigravity')
    })
  })
})
