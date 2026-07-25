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
    // Native omp allowlist only — MCP names in --tools crash omp 17
    // ("Unknown tools in --tools"). Cloak/SearXNG stay in persona + mcp.json.
    const toolsIdx = t.indexOf('--tools')
    expect(toolsIdx).toBeGreaterThan(-1)
    expect(t[toolsIdx + 1]).toBe('read,bash,edit,write,grep,glob,todo,web_search')
    expect(t[toolsIdx + 1]).not.toMatch(/cloakbrowser|searxng/)
    const idx = t.indexOf('--append-system-prompt')
    expect(idx).toBeGreaterThan(-1)
    // The persona must be ONE token, not shattered across spaces, and it must
    // name both first-class mesh web tools (HERMES web priority).
    expect(t[idx + 1]?.startsWith('You are the operator')).toBe(true)
    expect(t[idx + 1]?.includes('cloakbrowser_browse and searxng_search tools')).toBe(true)
  })
})
