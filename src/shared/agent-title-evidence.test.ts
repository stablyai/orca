import { describe, expect, it } from 'vitest'
import {
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
} from './agent-title-core'
import { collectAgentTitleEvidence } from './agent-title-evidence'

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
