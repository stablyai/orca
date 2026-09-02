import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/dashboard-popout/agent-map.css'),
  'utf8'
)

const PROJECT_SCALE =
  /:where\(\s*\.agent-map-project-node:hover,\s*\.agent-map-project-node:focus-within,\s*\.agent-map-project-node\.is-held\s*\)\s*\.agent-map-project-ring\s*\{([^}]*)\}/
const WORKTREE_SCALE =
  /:where\(\s*\.agent-map-worktree-group:hover,\s*\.agent-map-worktree-group:focus-within,\s*\.agent-map-worktree-group\.is-held\s*\)\s*\.agent-map-worktree-ring\s*\{([^}]*)\}/

/** A ring that only reacts to :hover on itself pulses shut whenever the pointer
 *  crosses onto something drawn inside it, and again when a pan drag takes
 *  pointer capture. Both triggers have to live on the containing group. */
describe('Agent Map hover containment', () => {
  it('scales each ring from its containing group, never from the ring element', () => {
    expect(css).not.toMatch(/\.agent-map-(?:project|worktree)-ring:hover/)
    expect(css.match(PROJECT_SCALE)?.[1]).toContain('transform: scale')
    expect(css.match(WORKTREE_SCALE)?.[1]).toContain('transform: scale')
  })

  it('keeps the group-scoped hover at ring specificity so state rules still win', () => {
    // `:where()` contributes no specificity, so the workspace state rules keep
    // overriding hover fill and stroke — but only while they stay below it.
    const hoverAt = css.search(WORKTREE_SCALE)

    expect(hoverAt).toBeGreaterThan(css.indexOf('.agent-map-worktree-ring {'))
    for (const state of ['.is-open', '.is-selected', '.is-working', '.is-blocked']) {
      expect(css.indexOf(`.agent-map-worktree-ring${state}`)).toBeGreaterThan(hoverAt)
    }
  })

  it('expands containing rings for keyboard focus as well as pointer hover', () => {
    expect(css.match(PROJECT_SCALE)?.[0]).toContain('.agent-map-project-node:focus-within')
    expect(css.match(WORKTREE_SCALE)?.[0]).toContain('.agent-map-worktree-group:focus-within')
  })

  it('drops both hover triggers under reduced motion', () => {
    const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))

    expect(reducedMotion).toContain('.agent-map-project-node.is-held')
    expect(reducedMotion).toContain('.agent-map-worktree-group.is-held')
    expect(reducedMotion).toMatch(/\.agent-map-project-node:hover/)
    expect(reducedMotion).toMatch(/\.agent-map-worktree-group:hover/)
  })
})
