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
    // 2 base + 4 agent statuses + 4 worktree statuses.
    expect(glowRules).toHaveLength(10)
    for (const rule of glowRules ?? []) {
      expect(rule).not.toMatch(/filter:|animation:|transition:/)
    }

    const markRule = css.match(/\.agent-map-agent-mark\s*\{[^}]+\}/s)?.[0]
    expect(markRule).not.toMatch(/filter:|animation:|transition:/)
  })

  it('keeps the waiting badge on the native SVG paint path', () => {
    const marker = source('AgentMapQuestionMarker.tsx')
    const css = source('agent-map.css')
    const markerRules = css.match(/\.agent-map-agent-question-[^{}]*\{[^}]+\}/gs) ?? []

    expect(marker).not.toContain('<foreignObject')
    expect(marker).toContain('<AgentQuestionIcon')
    expect(markerRules).toHaveLength(2)
    for (const rule of markerRules) {
      expect(rule).not.toMatch(/filter:|animation:|transition:/)
    }
  })

  it('confines status flares to nodes inside the recency window', () => {
    const component = source('AgentMapWorktreeRingNode.tsx')
    const metadata = source('agent-map-node-metadata.ts')

    // The flare is the one animated element on an agent node, so it must stay gated on
    // the globally capped recent-status map rather than on status alone.
    expect(component.match(/data-agent-map-agent-status-flare/g)).toHaveLength(1)
    expect(component).toMatch(/recentFlareStatuses\.get\(agent\.card\.paneKey\)/)
    expect(component).not.toMatch(/<filter|filter=/)

    const css = source('agent-map.css')
    const flareRule = css.match(/\.agent-map-agent-status-flare\s*\{[^}]+\}/s)?.[0] ?? ''
    expect(flareRule).toContain('pointer-events: none')
    expect(flareRule).toContain('vector-effect: non-scaling-stroke')
    // Transform and opacity only — no filter or layout-affecting paint work.
    expect(flareRule).not.toMatch(/filter:/)
    expect(css).toMatch(/@keyframes agent-map-status-flare/)

    // The mount window and the CSS duration are declared in different languages and
    // drift silently: too short a window unmounts the element mid-ripple, too long
    // leaves an invisible node animating. Pin them to the same number.
    const windowMs = Number(
      metadata.match(/AGENT_MAP_STATUS_FLARE_MS = ([\d_]+)/)?.[1].replaceAll('_', '')
    )
    const cssMs = Number(flareRule.match(/animation: agent-map-status-flare (\d+)ms/)?.[1])
    expect(windowMs).toBeGreaterThan(0)
    expect(cssMs).toBe(windowMs)
  })

  it('selects capped flares before rendering instead of flattening the scene', () => {
    const map = source('AgentMap.tsx')
    const scene = source('AgentMapScene.tsx')

    expect(map).toMatch(/selectAgentMapRecentFlareStatuses\(visibleCards\)/)
    expect(scene).not.toContain('selectAgentMapRecentFlareStatuses')
  })
})
