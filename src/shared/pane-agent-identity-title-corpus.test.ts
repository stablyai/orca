import { describe, expect, it } from 'vitest'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import type { TerminalAgent } from './terminal-agent'

describe('controlled title fixtures (always run)', () => {
  const FIXTURES: readonly { name: string; title: string; expected: TerminalAgent | null }[] = [
    {
      name: 'mandatory adversarial owner suffix beats the agent names in task text',
      title: 'STA-4011 Linux Antigravity Commit Messages - grok',
      expected: 'grok'
    },
    {
      name: 'task text mentioning other agents is not identity',
      title: 'Compare Antigravity with Gemini 3.7 Flash',
      expected: null
    },
    {
      name: 'owner suffix still answers over mentioned agents',
      title: 'Compare Antigravity with Gemini 3.7 Flash… - grok',
      expected: 'grok'
    },
    { name: 'Claude status sigil is a vendor marker', title: '✳', expected: 'claude' },
    { name: 'Claude management screen is not identity', title: 'claude agents', expected: null },
    { name: 'a shell title names no agent', title: 'zsh', expected: null },
    { name: 'a default worktree-ish title names no agent', title: 'my-claude-fix', expected: null },
    {
      name: 'conflicting vendor markers resolve to nothing',
      title: '✳ | ✦ two sigils',
      expected: null
    },
    {
      name: 'conflicting anchored names resolve to nothing',
      title: 'OC | something… - grok',
      expected: null
    },
    { name: 'a bare Pi title anchors as Pi', title: 'pi', expected: 'pi' },
    { name: 'an OMP status title anchors as OMP', title: 'omp ready', expected: 'omp' },
    {
      // Wrapper-frame π/OMP separators are handled by the synthetic-title path, not this
      // evidence parser; pinned so a parser change here is a deliberate decision.
      name: 'a π wrapper frame is declined by the evidence parser',
      title: 'π : ready',
      expected: null
    }
  ]

  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(collectAgentTitleEvidence(fixture.title).agent).toBe(fixture.expected)
      expect(resolveCanonicalPaneAgentIdentity({ title: fixture.title }).agent).toBe(
        fixture.expected
      )
    })
  }
})
