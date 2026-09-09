import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveClientHostedBrowserRowStripGroupId } from './client-hosted-browser-row-strip-placement'

function itemSurfaceSource(): string {
  return readFileSync(join(__dirname, 'tab-bar-item-surface.tsx'), 'utf8')
}

describe('resolveClientHostedBrowserRowStripGroupId', () => {
  it('names exactly one owning strip when the worktree is split', () => {
    const groups = [{ id: 'group-left' }, { id: 'group-right' }, { id: 'group-bottom' }]

    const owner = resolveClientHostedBrowserRowStripGroupId(groups)

    expect(groups.filter((group) => group.id === owner)).toHaveLength(1)
  })

  // Why: picking the focused group instead would make a row hop strips as the user clicks around.
  it('keeps the same owner as focus moves', () => {
    const groups = [{ id: 'group-left' }, { id: 'group-right' }]

    expect(resolveClientHostedBrowserRowStripGroupId(groups)).toBe(
      resolveClientHostedBrowserRowStripGroupId([...groups])
    )
    expect(resolveClientHostedBrowserRowStripGroupId(groups)).toBe('group-left')
  })

  it('names no owner when the worktree has no groups', () => {
    expect(resolveClientHostedBrowserRowStripGroupId([])).toBeNull()
  })
})

/**
 * A client-hosted placeholder is retired by activating anything else in its strip. That only holds
 * while every row kind's activation goes through the one wrapper — a new kind wired straight to
 * its `onActivate*` prop would leave the placeholder covering the pane it just switched to.
 */
describe('tab-bar activation census', () => {
  it('routes every row kind activation through the placeholder-clearing wrapper', () => {
    const source = itemSurfaceSource()
    const activations = source.match(/onActivate=\{[^}]*\}/g) ?? []

    expect(activations.length).toBeGreaterThan(0)
    for (const activation of activations) {
      expect(activation, 'a row kind activates without retiring the placeholder').toContain(
        'activateRealTab('
      )
    }
  })

  it('clears the placeholder before handing off to the real activation', () => {
    expect(itemSurfaceSource()).toMatch(
      /clearClientHostedBrowserRowSelection\(\)\s*\n\s*activate\?\.\(arg\)/
    )
  })
})
