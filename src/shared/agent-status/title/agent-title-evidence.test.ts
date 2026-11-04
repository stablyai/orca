import { describe, expect, it } from 'vitest'
import './agent-title-core'
import {
  collectAgentTitleEvidence,
  collectExplicitAgentTitleEvidence
} from './agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from '../identity/pane-agent-identity-adapter'
import { resolvePublishedPaneAgentIdentity } from '../../published-pane-agent-identity'

const agentFor = (title: string) => collectAgentTitleEvidence(title).agent

describe('collectAgentTitleEvidence', () => {
  it.each([
    ['✦ Review Codex - DeepSeek Build', 'gemini'],
    ['⏲ Review Codex - DeepSeek Build', 'gemini'],
    ['◇ Review Codex - DeepSeek Build', 'gemini'],
    ['✋ Review Codex - DeepSeek Build', 'gemini'],
    ['✳ Review Codex - DeepSeek Build', 'claude'],
    ['. Review Codex - DeepSeek Build', 'claude'],
    ['* Review Codex - DeepSeek Build', 'claude'],
    ['Wrapper | ✦ Review Codex - DeepSeek Build', 'gemini'],
    ['Wrapper | ✳ Review Codex - DeepSeek Build', 'claude'],
    ['OC | Review Codex - DeepSeek Build', 'opencode'],
    ['Wrapper | OC | Review Codex - DeepSeek Build', 'opencode'],
    ['⠋ - Review Codex - DeepSeek Build', 'dsb'],
    ['DeepSeek Build', 'dsb']
  ] as const)(
    'preserves the native owner of %j through canonical and published identity',
    (title, agent) => {
      expect(collectAgentTitleEvidence(title).agent).toBe(agent)
      expect(resolveCanonicalPaneAgentIdentity({ title }).agent).toBe(agent)
      expect(resolvePublishedPaneAgentIdentity({ title })).toBe(agent)
    }
  )

  describe('an anchored name outranks a name in task text', () => {
    // Recorded failures name the owner in Orca's suffix and a competitor only in task text.
    it.each([
      'Switch Claude and Codex off the load balancer… - grok',
      'Codex structured chat revalidation… - grok',
      '⠸ - Thinking - Codex native-chat work… - grok',
      'Electron QA: check the Gemini label… - grok'
    ])('resolves %j to the suffix owner', (title) => {
      expect(agentFor(title)).toBe('grok')
    })
  })

  describe('order independence', () => {
    // Swapping name order must not let detector-list position choose the owner.
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

  describe('Antigravity model names are metadata, not identity', () => {
    it('reads an identity segment plus a model name as Antigravity', () => {
      expect(agentFor('agy · Gemini 3.7 Flash')).toBe('antigravity')
      expect(agentFor('Antigravity — Gemini 3.7 Flash')).toBe('antigravity')
    })

    it('does not promote model names in task text', () => {
      expect(agentFor('Compare Antigravity with Gemini 3.7 Flash')).toBeNull()
      expect(agentFor('Compare Antigravity with Gemini 3.7 Flash… - grok')).toBe('grok')
    })
  })

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

  it('does not promote Claude status words in task text', () => {
    expect(agentFor('Fix the Claude Code ready-state parser')).toBeNull()
    expect(agentFor('Fix Claude Code ready behavior… - grok')).toBe('grok')
  })

  it('reads identity from the innermost wrapper segment', () => {
    expect(agentFor('zsh | ⠋ Claude Code')).toBe('claude')
    expect(agentFor('ssh | tmux | Cursor Agent')).toBe('cursor')
    expect(agentFor('ssh | tmux | OC | review the parser')).toBe('opencode')
    expect(agentFor('zsh | Fix the Codex parser')).toBeNull()
  })

  it('keeps canonical diagnostics separate from consuming observer frames', () => {
    const title = `outer-a | outer-b | OC | ${'x | '.repeat(200)}Cursor Agent`
    expect(collectAgentTitleEvidence(title).agent).toBe('cursor')
    expect(collectExplicitAgentTitleEvidence(title).agent).toBe('opencode')
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

  it('terminates when a wrapper title starts with a separator', () => {
    expect(agentFor(' | ')).toBeNull()
  })
})
