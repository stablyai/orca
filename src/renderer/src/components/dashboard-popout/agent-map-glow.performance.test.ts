import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function source(file: string): string {
  return readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/dashboard-popout', file),
    'utf8'
  )
}

describe('Agent Map glow performance boundary', () => {
  it('uses one conditional SVG halo per active entity without filter effects', () => {
    const component = source('AgentMapWorktreeRingNode.tsx')

    expect(component.match(/data-agent-map-worktree-status-glow/g)).toHaveLength(1)
    expect(component.match(/data-agent-map-agent-status-glow/g)).toHaveLength(1)
    expect(component).not.toMatch(/<filter|filter=/)
  })

  it('keeps glow styling free of animated and filtered paint work', () => {
    const css = source('agent-map.css')
    const baseGlowRules = css.match(
      /\.agent-map-(?:worktree-status|agent-status)-glow\s*\{[^}]+\}/gs
    )
    const glowRules = css.match(
      /\.agent-map-(?:worktree-status|agent-status)-glow[^{}]*\{[^}]+\}/gs
    )

    expect(baseGlowRules).toHaveLength(2)
    for (const rule of baseGlowRules ?? []) {
      expect(rule).toContain('pointer-events: none')
      expect(rule).toContain('vector-effect: non-scaling-stroke')
    }
    expect(glowRules).toHaveLength(8)
    for (const rule of glowRules ?? []) {
      expect(rule).not.toMatch(/filter:|animation:|transition:/)
    }
  })
})
