import { describe, expect, it } from 'vitest'
import {
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
} from './agent-title-core'
import { collectAgentTitleEvidence, titlePresentsAgent } from './agent-title-evidence'

const agentFor = (title: string) => collectAgentTitleEvidence(title).agent
const reasonFor = (title: string) => collectAgentTitleEvidence(title).reason

describe('collectAgentTitleEvidence', () => {
  describe('an anchored name outranks a name in task text', () => {
    // Minimized from real recorded titles that resolve to the wrong agent on the ordered chain:
    // the pane owner is named by Orca's `- <agent>` suffix, the competitor only by task text.
    it.each([
      'Switch Claude and Codex off the load balancer… - grok',
      'Codex structured chat revalidation… - grok',
      '⠸ - Thinking - Codex native-chat work… - grok',
      'Electron QA: check the Gemini label… - grok'
    ])('resolves %j to the suffix owner', (title) => {
      expect(agentFor(title)).toBe('grok')
    })

    it('does not read a hyphenated worktree name as an owner suffix', () => {
      // `review-14600-codex` is a directory, not an owner declaration. The suffix grammar
      // requires whitespace before the dash precisely to keep these apart.
      expect(agentFor('review-14600-codex')).toBeNull()
      expect(agentFor('codex-split-core')).toBeNull()
    })

    it.each(['pi', 'omp', 'claude-agent-teams', 'qwen-code'] as const)(
      'recognizes the reserved owner id %s',
      (agent) => {
        expect(agentFor(`Review another agent… - ${agent}`)).toBe(agent)
      }
    )
  })

  describe('order independence', () => {
    // The defect this replaces is that chain position decides between two names. Swapping the
    // two names in a title must not change the answer.
    it.each([
      ['codex', 'grok'],
      ['gemini', 'antigravity'],
      ['copilot', 'devin'],
      ['claude', 'cursor']
    ])('gives %s + %s the same answer in both orders', (a, b) => {
      const forward = collectAgentTitleEvidence(`${a} and ${b}`)
      const reverse = collectAgentTitleEvidence(`${b} and ${a}`)
      expect(forward.agent).toBe(reverse.agent)
      expect(forward.agent).toBeNull()
      expect([...forward.freeTextNames].sort()).toEqual([a, b].sort())
      expect([...reverse.freeTextNames].sort()).toEqual([a, b].sort())
    })
  })

  it.each([
    ['claude', 'claude'],
    ['openclaude', 'openclaude'],
    ['codex', 'codex'],
    ['copilot', 'copilot'],
    ['cursor', 'cursor'],
    ['gemini', 'gemini'],
    ['antigravity', 'antigravity'],
    ['opencode', 'opencode'],
    ['mimo', 'mimo-code'],
    ['openclaw', 'openclaw'],
    ['aider', 'aider'],
    ['grok', 'grok'],
    ['devin', 'devin']
  ] as const)('collects the free-text token %s without claiming identity', (token, agent) => {
    expect(collectAgentTitleEvidence(`review the ${token} integration`)).toMatchObject({
      agent: null,
      reason: 'free-text-only',
      freeTextNames: [agent]
    })
  })

  describe('a vendor marker is evidence the agent emitted, not text a human typed', () => {
    it('keeps a Claude pane Claude when its task text names another agent', () => {
      // 13 recorded titles have this shape. The sigil is emitted by Claude; the name is typed.
      expect(agentFor('✳ Fix Codex false attention notifications on Windows')).toBe('claude')
      expect(reasonFor('✳ Consolidate Codex subagent sidebar rows')).toBe('vendor-marker')
    })

    it('lets an anchored name outrank a foreign vendor marker', () => {
      expect(agentFor('✳ agy')).toBe('claude')
      expect(reasonFor('✳ agy')).toBe('vendor-marker')
      expect(agentFor('✳ codex')).toBe('claude')
      expect(reasonFor('✳ codex')).toBe('vendor-marker')
    })

    it('keeps an OpenCode envelope OpenCode when its session text names another agent', () => {
      expect(agentFor('OC | QA PR #14582 Cursor sidecar SSH arms')).toBe('opencode')
    })
  })

  describe('Antigravity model names are metadata, not identity', () => {
    it('reads an identity segment plus a model name as Antigravity', () => {
      expect(agentFor('agy · Gemini 3.7 Flash')).toBe('antigravity')
      expect(agentFor('Antigravity — Gemini 3.7 Flash')).toBe('antigravity')
    })

    it('declines a bare model name rather than guessing Gemini CLI', () => {
      // No identity segment, no vendor glyph — only a name in free text. Antigravity and Gemini
      // CLI are equally consistent with it, so the title cannot answer.
      expect(agentFor('Gemini 3.7 Flash · high')).toBeNull()
    })

    it.each([GEMINI_WORKING, GEMINI_SILENT_WORKING, GEMINI_IDLE, GEMINI_PERMISSION])(
      'still resolves the real Gemini marker %s',
      (marker) => {
        expect(agentFor(`${marker} Refactor the parser`)).toBe('gemini')
      }
    )

    it('does not promote model names in task text', () => {
      expect(agentFor('Compare Antigravity with Gemini 3.7 Flash')).toBeNull()
      expect(agentFor('Compare Antigravity with Gemini 3.7 Flash… - grok')).toBe('grok')
    })

    it('does not treat a Gemini glyph inside task text as a vendor marker', () => {
      const evidence = collectAgentTitleEvidence('Explain the ✦ marker… - grok')
      expect(evidence.agent).toBe('grok')
      expect(evidence.vendorMarkers).toEqual([])
    })
  })

  describe('a name in free text alone is never identity', () => {
    it.each([
      '◐ DaemonConnectionLostError with 70 Codex agents',
      'Fix the grok hook',
      'Debug the cursor sidecar',
      'grok',
      '⠋ grok',
      '⠋ codex'
    ])('declines %j', (title) => {
      expect(agentFor(title)).toBeNull()
      expect(reasonFor(title)).toBe('free-text-only')
    })
  })

  it.each([
    ['Claude Code', 'claude'],
    ['Gemini CLI', 'gemini'],
    ['Claude Agent Teams', 'claude-agent-teams'],
    ['MiMo Code', 'mimo-code'],
    ['Prime Agent', 'prime-agent'],
    ['Command Code', 'command-code'],
    ['GitHub Copilot', 'copilot'],
    ['Agent Teams', 'claude-agent-teams']
  ] as const)('recognizes the emitted whole-title alias %s', (title, agent) => {
    expect(agentFor(title)).toBe(agent)
    expect(reasonFor(title)).toBe('anchored')
  })

  it.each(['Continue', 'Charm', 'Goose', 'Amp'])(
    'does not treat the UI-only display label %s as identity',
    (title) => {
      expect(agentFor(title)).toBeNull()
      expect(reasonFor(title)).toBe('no-evidence')
    }
  )

  it.each([
    '~/codex',
    '/grok',
    '.\\openclaude',
    'C:\\codex',
    'C:/codex',
    '~/Codex ready',
    '.\\Cursor ready'
  ])('does not treat the cwd path %s as identity', (title) => {
    expect(agentFor(title)).toBeNull()
  })

  it('does not duplicate an anchored token as free text', () => {
    expect(collectAgentTitleEvidence('codex.exe').freeTextNames).toEqual([])
    expect(collectAgentTitleEvidence('Claude Agent Teams').freeTextNames).toEqual([])
  })

  it.each([
    ['Codex ready', 'codex'],
    ['Codex - action required', 'codex'],
    ['Cursor ready', 'cursor'],
    ['Droid - action required', 'droid'],
    ['Hermes ready', 'hermes'],
    ['Devin - action required', 'devin'],
    ['Pi ready', 'pi'],
    ['OMP - action required', 'omp']
  ] as const)('recognizes Orca-controlled synthetic title %s', (title, agent) => {
    expect(agentFor(title)).toBe(agent)
    expect(reasonFor(title)).toBe('anchored')
  })

  it.each(['Droid', 'Hermes', 'Devin'])(
    'does not treat a bare working label as synthetic identity: %s',
    (title) => {
      expect(agentFor(title)).toBeNull()
      expect(reasonFor(title)).toBe('free-text-only')
    }
  )

  it.each([
    'Claude Code ready',
    'Claude thinking',
    '. Claude Code working',
    'zsh | ⠋ Claude Code - action required'
  ])('recognizes the explicit Claude identity frame %s', (title) => {
    expect(agentFor(title)).toBe('claude')
    expect(reasonFor(title)).toBe('anchored')
  })

  it('does not promote Claude status words in task text', () => {
    expect(agentFor('Fix the Claude Code ready-state parser')).toBeNull()
    expect(agentFor('Fix Claude Code ready behavior… - grok')).toBe('grok')
  })

  it.each(['. Review the parser', '* Waiting for input'])(
    'recognizes the established Claude status prefix in %s',
    (title) => {
      expect(agentFor(title)).toBe('claude')
      expect(reasonFor(title)).toBe('vendor-marker')
    }
  )

  it.each([
    ['⠋ Cursor Agent', 'cursor'],
    ['⠋ Pi idle', 'pi'],
    ['⠋ OMP done', 'omp'],
    ['⠋ Droid', 'droid'],
    ['⠋ Hermes', 'hermes'],
    ['⠋ Devin', 'devin']
  ] as const)('recognizes the decorated identity frame %s', (title, agent) => {
    expect(agentFor(title)).toBe(agent)
    expect(reasonFor(title)).toBe('anchored')
  })

  it('does not invent synthetic titles for an opted-out profile', () => {
    expect(agentFor('OpenCode ready')).toBeNull()
    expect(agentFor('⠋ OpenCode')).toBeNull()
    expect(reasonFor('OpenCode ready')).toBe('free-text-only')
  })

  it('reads identity from the innermost wrapper segment', () => {
    expect(agentFor('zsh | ⠋ Claude Code')).toBe('claude')
    expect(agentFor('ssh | tmux | Cursor Agent')).toBe('cursor')
    expect(agentFor('ssh | tmux | OC | review the parser')).toBe('opencode')
    expect(agentFor('zsh | Fix the Codex parser')).toBeNull()
  })

  it('bounds wrapper inspection while preserving innermost identity', () => {
    const wrappers = Array.from({ length: 200 }, (_, index) => `wrapper-${index}`).join(' | ')
    expect(agentFor(`${wrappers} | ⠋ Cursor Agent`)).toBe('cursor')
    expect(agentFor(`${wrappers} | OC | review the parser`)).toBe('opencode')
    expect(agentFor(`outer-a | outer-b | OC | ${wrappers} | Cursor Agent`)).toBe('cursor')
  })

  it.each([
    ['codex.exe', 'codex'],
    ['openclaude.cmd', 'openclaude'],
    ['gemini.ps1', 'gemini'],
    ['droid.cmd', 'droid'],
    ['hermes.exe', 'hermes'],
    ['agy.bat', 'antigravity'],
    ['CODEX.EXE', 'codex'],
    ['DROID.CMD', 'droid']
  ] as const)('recognizes the bare Windows launcher %s', (title, agent) => {
    expect(agentFor(title)).toBe(agent)
    expect(reasonFor(title)).toBe('anchored')
  })

  it('produces no name evidence for an agent outside the token set', () => {
    // The token set is deliberately narrower than the agent union: short names like `omp` would
    // classify ordinary shell text. Such a title yields no evidence at all rather than a guess.
    expect(reasonFor('Review PR for OMP transcript rendering')).toBe('no-evidence')
  })

  describe('activity is not identity', () => {
    it.each(['◐ Rebase PR #14624 onto main', '⠂ Fix SSH fallback', '⠋ Thinking'])(
      'declines the spinner-only title %j',
      (title) => {
        // Braille and quarter-circle spinners are emitted by many agents, so they prove the pane
        // is busy and nothing about who it is. Callers that want busy-ness use activity parsing.
        expect(agentFor(title)).toBeNull()
        expect(reasonFor(title)).toBe('no-evidence')
      }
    )
  })

  it('does not treat an embedded Claude sigil as a vendor marker', () => {
    expect(collectAgentTitleEvidence('task text ✳ decoration')).toEqual({
      vendorMarkers: [],
      anchoredNames: [],
      freeTextNames: [],
      agent: null,
      reason: 'no-evidence'
    })
  })

  it('recognizes a bare Claude sigil as a vendor marker', () => {
    expect(collectAgentTitleEvidence('✳')).toEqual({
      vendorMarkers: ['claude'],
      anchoredNames: [],
      freeTextNames: [],
      agent: 'claude',
      reason: 'vendor-marker'
    })
  })

  describe('conflicting evidence of the same class resolves to nothing', () => {
    it('declines two anchored names', () => {
      const evidence = collectAgentTitleEvidence('OC | something… - grok')
      expect(evidence.agent).toBeNull()
      expect(evidence.reason).toBe('conflicting-anchored-names')
      expect([...evidence.anchoredNames].sort()).toEqual(['grok', 'opencode'])
    })

    it('keeps an anchored conflict ahead of a vendor marker', () => {
      const evidence = collectAgentTitleEvidence('✳ | OC | something… - grok')
      expect(evidence.agent).toBeNull()
      expect(evidence.reason).toBe('conflicting-anchored-names')
      expect([...evidence.anchoredNames].sort()).toEqual(['grok', 'opencode'])
      expect(evidence.vendorMarkers).toEqual(['claude'])
    })

    it('declines two vendor markers', () => {
      const evidence = collectAgentTitleEvidence('✳ | ✦ two sigils')
      expect(evidence.agent).toBeNull()
      expect(evidence.reason).toBe('conflicting-vendor-markers')
      expect([...evidence.vendorMarkers].sort()).toEqual(['claude', 'gemini'])
    })
  })

  it('declines a Claude management screen', () => {
    expect(collectAgentTitleEvidence('claude agents')).toEqual({
      vendorMarkers: [],
      anchoredNames: [],
      freeTextNames: [],
      agent: null,
      reason: 'no-evidence'
    })
  })

  it('requires whitespace before the owner suffix dash', () => {
    expect(agentFor('task- codex')).toBeNull()
    expect(reasonFor('task- codex')).toBe('free-text-only')
  })

  it('terminates when a wrapper title starts with a separator', () => {
    expect(agentFor(' | ')).toBeNull()
  })
})

describe('titlePresentsAgent', () => {
  // #14937/#14938: the gate a title must pass before it may take a pane from a known owner.
  it('rejects a name that only appears inside task text', () => {
    expect(titlePresentsAgent('⠋ Fix the codex plugin launcher', 'codex')).toBe(false)
    expect(titlePresentsAgent('⠙ Investigate why codex hangs on Windows', 'codex')).toBe(false)
    expect(titlePresentsAgent('⠋ add grok support to the tab bar', 'grok')).toBe(false)
    expect(titlePresentsAgent('⠋ port the gemini status parser', 'gemini')).toBe(false)
    expect(titlePresentsAgent('⠋ review copilot suggestions', 'copilot')).toBe(false)
    expect(titlePresentsAgent('⠋ refactor the aider bridge', 'aider')).toBe(false)
  })

  it('accepts a name in the identity position', () => {
    expect(titlePresentsAgent('⠋ Codex', 'codex')).toBe(true)
    expect(titlePresentsAgent('⠋ Codex: fix cursor offsets', 'codex')).toBe(true)
    expect(titlePresentsAgent('Codex ready', 'codex')).toBe(true)
    expect(titlePresentsAgent('Codex - action required', 'codex')).toBe(true)
    expect(titlePresentsAgent('⠋ Claude Code', 'claude')).toBe(true)
    expect(titlePresentsAgent('zsh | ⠋ Claude Code', 'claude')).toBe(true)
  })

  it('answers only for the agent asked about', () => {
    expect(titlePresentsAgent('⠋ Codex', 'claude')).toBe(false)
    expect(titlePresentsAgent('⠋ Claude Code', 'codex')).toBe(false)
  })

  // The one intentional divergence from collectAgentTitleEvidence, pinned so it cannot re-drift.
  // The parser files '⠋ Codex' as free text because codex sets synthesizeWorkingTitle: false in
  // synthetic-agent-title.ts — Codex emits its own working titles, so Orca never synthesizes one
  // for the parser to anchor against. This predicate is asked about ONE named agent rather than
  // inferring it, so a name in the identity position is enough. Keeping the two in agreement here
  // would break the pinned '⠋ Codex: fix cursor offsets' => codex assertion in
  // terminal-title-agent-type.test.ts, and would demote real Codex frames on hookless SSH panes.
  it('diverges from the evidence parser only for a bare frame it files as free text', () => {
    expect(collectAgentTitleEvidence('⠋ Codex').reason).toBe('free-text-only')
    expect(collectAgentTitleEvidence('⠋ Codex').agent).toBeNull()
    expect(titlePresentsAgent('⠋ Codex', 'codex')).toBe(true)
  })

  // The OTHER direction of the divergence. The parser resolves a lone vendor marker to its agent,
  // including Claude's generic status decorations; this predicate must not, or a '. '-prefixed
  // OpenCode task title would reclaim the pane #8940 exists to protect. Pinned because leaving
  // this direction unguarded is exactly how the first cut of this change shipped a regression.
  it('diverges the other way: a generic Claude status prefix is not identity', () => {
    for (const title of [
      '. port the claude prompt',
      '. ship it with claude',
      '\u2733 investigating startup'
    ]) {
      expect(collectAgentTitleEvidence(title).agent).toBe('claude')
      expect(collectAgentTitleEvidence(title).reason).toBe('vendor-marker')
      expect(titlePresentsAgent(title, 'claude')).toBe(false)
    }
  })

  // But an agent's OWN sigil is identity, and must survive: these are the titles a real Gemini or
  // Cursor pane paints, and refusing them stranded the pane on its previous owner.
  it('accepts a vendor marker that is the agent own sigil', () => {
    for (const title of [
      '\u2726 Analyzing the repository',
      '\u23f2 thinking',
      '\u25c7 waiting',
      '\u270b approve this edit'
    ]) {
      expect(titlePresentsAgent(title, 'gemini')).toBe(true)
    }
    expect(titlePresentsAgent('cursor agent', 'cursor')).toBe(true)
  })

  // Task text that merely opens with a name is still task text: the colon is the frame marker.
  it('rejects a name trailed by task text with no frame separator', () => {
    expect(titlePresentsAgent('. Claude Code compare Opencode', 'claude')).toBe(false)
    expect(titlePresentsAgent('⠋ Codex plugin launcher rewrite', 'codex')).toBe(false)
  })
})
