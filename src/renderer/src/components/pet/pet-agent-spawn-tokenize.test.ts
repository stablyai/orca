import { describe, expect, it } from 'vitest'
import { buildPetOmpAgentArgs } from './pet-agent-spawn'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'

describe('pet omp args tokenize cleanly (Orca launch path)', () => {
  it('parses into the exact flags omp receives, persona as one token', () => {
    const args = buildPetOmpAgentArgs('repo::/w')
    const res = tokenizeStartupCommand(args, 'posix')
    expect(res.ok).toBe(true)
    if (!res.ok) {
      return
    }
    const t = res.tokens
    // config + tools + the persona survive as whole tokens
    expect(t).toContain('--config')
    expect(t).toContain('--tools')
    expect(t).toContain('read,bash,edit,write,grep,glob,todo,web_search')
    const idx = t.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThan(-1)
    // The persona must be ONE token, not shattered across spaces.
    expect(t[idx + 1]?.startsWith('You are the operator')).toBe(true)
    expect(t[idx + 1]?.includes('web_search tools')).toBe(true)
  })
})
