import { describe, expect, it } from 'vitest'
import { resolveTabAgentFromSignals as resolveFromSignalsModule } from './tab-agent-from-signals'
import { resolveTabAgentFromSignals as resolveFromHookModule } from './use-tab-agent'

/**
 * #14937: a Claude pane's WORKING title is a bare braille spinner plus task text, so any agent
 * name in that text used to resolve the title to a committed foreign identity and take the pane
 * from its Claude owner. The guard that fixed the mirror-image bug (#8940) was written for the
 * Claude label only, so every other name short-circuited above it.
 *
 * Both copies are exercised on purpose: `useTabAgent` (the tab-bar icon) calls the copy in
 * use-tab-agent.ts, while open-tab-occupant-agent.ts and the rest of these suites call the copy in
 * tab-agent-from-signals.ts. They are separate implementations of the same contract.
 */
const RESOLVERS = [
  ['tab-agent-from-signals', resolveFromSignalsModule],
  ['use-tab-agent', resolveFromHookModule]
] as const

const FOREIGN_NAME_TASK_TITLES = [
  '⠋ Fix the codex plugin launcher',
  '⠙ Investigate why codex hangs on Windows',
  '⠹ compare codex and claude output',
  '⠋ add grok support to the tab bar',
  '⠋ port the gemini status parser',
  '⠋ review copilot suggestions'
]

describe.each(RESOLVERS)('%s: a foreign name in task text is a mention', (_name, resolve) => {
  it('keeps a Claude-owned pane Claude with no live hook', () => {
    for (const title of FOREIGN_NAME_TASK_TITLES) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'claude'
        })
      ).toBe('claude')
    }
  })

  it('keeps a Claude-owned pane Claude with a completed hook, and on a remote pane', () => {
    const title = '⠋ Fix the codex plugin launcher'
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title,
        hookAgent: null,
        focusedCompletedHookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: true,
        title,
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  // Non-discriminating on its own — it passes before the fix too. Kept as the control that shows
  // why users experienced this as random: a live hook always outranked the title.
  it('was already correct while a live hook existed', () => {
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Fix the codex plugin launcher',
        hookAgent: 'claude',
        launchAgent: 'claude'
      })
    ).toBe('claude')
  })

  // The guard must stay agent-neutral in BOTH directions. This is the assertion that fails if
  // someone reintroduces a one-way guard: #8940's direction and #14937's direction are one rule.
  it('still lets a genuine identity frame reclaim a reused pane, both directions', () => {
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '✳ Claude Code',
        hookAgent: null,
        launchAgent: 'opencode'
      })
    ).toBe('claude')
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: '⠋ Codex',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('codex')
  })

  // The mirror of this PR's own bug, and the regression the first cut of it shipped: a vendor
  // marker is the agent's OWN sigil, which task text cannot forge, so it must still reclaim a
  // pane from a prior owner. Gemini's four glyphs and Cursor's native literal are markers, not
  // anchored names, so a predicate reading only anchoredNames strands a real Gemini pane on its
  // previous Claude owner.
  it('lets a vendor-marker title reclaim a pane from a prior owner', () => {
    for (const title of [
      '\u2726 Analyzing the repository',
      '\u23f2 thinking',
      '\u25c7 waiting',
      '\u270b approve this edit'
    ]) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'claude'
        })
      ).toBe('gemini')
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          focusedCompletedHookAgent: 'claude',
          launchAgent: 'claude'
        })
      ).toBe('gemini')
    }
    // #10258: the native literal is deliberately status-less but still identifies a live pane.
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title: 'cursor agent',
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe('cursor')
  })

  // Claude's decorations are the exception, and the reason the vendor class cannot be admitted
  // wholesale: OpenCode emits '. ' and '* ' too, so they prove activity, not identity.
  it('does not let a generic Claude status prefix reclaim a pane', () => {
    for (const title of [
      '. port the claude prompt',
      '. ship it with claude',
      '. Compare Opencode Vs Orca'
    ]) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'opencode'
        })
      ).toBe('opencode')
    }
  })

  // The four routes `getAgentLabel` mints identity from that a predicate built on the evidence
  // parser alone cannot see. Each is the agent naming itself, so each must still take the pane.
  it.each([
    ['pi native', '\u03c0 > session - ~/orca', 'pi'],
    ['pi native, blocked', '\u03c0 ! blocked-session', 'pi'],
    ['name plus status', 'codex working', 'codex'],
    ['name plus status, spinner', '\u2838 aider running', 'aider'],
    ['name plus status, grok', 'grok done', 'grok'],
    ['em-dash frame', '\u2849 Codex \u2014 refactoring', 'codex'],
    ['pipe-headed', 'ssh host | opencode ready', 'opencode'],
    ['windows launcher', 'aider.ps1 ready', 'aider'],
    ['windows launcher, action', 'copilot.exe - action required', 'copilot']
  ])('reclaims a foreign-owned pane for a %s title', (_label, title, expected) => {
    expect(
      resolve({
        hasObservedAgentSignal: true,
        isRemote: false,
        title,
        hookAgent: null,
        launchAgent: 'claude'
      })
    ).toBe(expected)
  })

  it('keeps an OpenCode pane OpenCode when its task text mentions Claude (#8940)', () => {
    for (const title of [
      'OC | ⠋ ask claude about this',
      '⠋ use Claude Sonnet',
      '⠋ port the claude prompt'
    ]) {
      expect(
        resolve({
          hasObservedAgentSignal: true,
          isRemote: false,
          title,
          hookAgent: null,
          launchAgent: 'opencode'
        })
      ).toBe('opencode')
    }
  })
})
