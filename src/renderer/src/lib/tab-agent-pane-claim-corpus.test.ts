import { describe, expect, it } from 'vitest'
import { TERMINAL_TITLE_CLASSIFICATION_CORPUS } from '../../../shared/terminal-title-classification-corpus'
import {
  isClaudeIdentityFrameTitle,
  resolveExplicitTerminalTitleAgentType
} from '../../../shared/terminal-title-agent-type'
import { resolveTabAgentFromSignals as resolveFromSignalsModule } from './tab-agent-from-signals'
import { resolveTabAgentFromSignals as resolveFromHookModule } from './use-tab-agent'
import { resolveTitleDerivedAgentType } from '../components/sidebar/worktree-title-derived-agent-rows'
import { resolveTitleActivityLabel } from './pane-agent-evidence'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The corpus swept through the CONSUMERS, not just the predicate.
 *
 * Round 2's regression shipped with a correct predicate: the gate agreed with its own evidence
 * model, and the callers' authority was a third function with a richer one. A predicate-level
 * sweep would have passed. This is the sweep that would not have.
 */

/** A different owner for every title, so the guard is always the thing being exercised. */
function foreignOwner(agent: TuiAgent): TuiAgent {
  return agent === 'claude' ? 'codex' : 'claude'
}

function claimedBefore(title: string, agent: string): boolean {
  return agent !== 'claude' || isClaudeIdentityFrameTitle(title)
}

const MINTING_CORPUS: [string, TuiAgent][] = TERMINAL_TITLE_CLASSIFICATION_CORPUS.flatMap(
  (title) => {
    const agent = resolveExplicitTerminalTitleAgentType(title)
    return agent && claimedBefore(title, agent) ? [[title, agent] as [string, TuiAgent]] : []
  }
)

describe('pane-claim corpus through the consumers', () => {
  it('covers a meaningful slice of the corpus', () => {
    expect(MINTING_CORPUS.length).toBeGreaterThan(20)
  })

  it.each([
    ['tab-agent-from-signals', resolveFromSignalsModule],
    ['use-tab-agent', resolveFromHookModule]
  ])('%s reclaims a foreign-owned pane for every minting title', (_name, resolve) => {
    const lost = MINTING_CORPUS.filter(([title, agent]) => {
      const owner = foreignOwner(agent)
      return (
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: owner
        }) !== agent
      )
    }).map(([title, agent]) => `${JSON.stringify(title)} -> ${agent}`)
    expect(lost).toEqual([])
  })

  /**
   * Isolates the OWNER GUARD, which is the only thing this change touches in the sidebar. A title
   * whose label the sidebar's own map does not carry (`MiMo Code` is absent, before and after)
   * could never produce that row regardless of ownership, so it is not a claim the guard can lose.
   * Anything the resolver answers with no owner, it must still answer against a foreign one.
   */
  it('the sidebar owner guard never drops a row the resolver would otherwise build', () => {
    const lost = MINTING_CORPUS.filter(([title, agent]) => {
      const label = resolveTitleActivityLabel(title)
      if (!label || resolveTitleDerivedAgentType(title, label, null) !== agent) {
        return false
      }
      return resolveTitleDerivedAgentType(title, label, foreignOwner(agent)) !== agent
    }).map(([title, agent]) => `${JSON.stringify(title)} -> ${agent}`)
    expect(lost).toEqual([])
  })
})
