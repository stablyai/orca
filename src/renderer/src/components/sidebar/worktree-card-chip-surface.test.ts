import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const testDir = import.meta.dirname

function readCss(): string {
  // Strip comments so a `}` inside prose can't truncate a rule body match.
  return readFileSync(resolve(testDir, '../../assets/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  )
}

function readRuleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = readCss().match(new RegExp(`^${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'm'))?.groups?.body
  expect(body, `missing CSS rule for ${selector}`).toBeTypeOf('string')

  return body ?? ''
}

function readDeclaration(selector: string, property: string): string {
  const body = readRuleBody(selector)
  const value = body.match(new RegExp(`(?:^|;)\\s*${property}:\\s*(?<value>[^;]*)`))?.groups?.value

  return (value ?? '').trim()
}

const CHIP_SURFACE_SELECTORS = ['.worktree-sidebar-chip', '.dark .worktree-sidebar-chip']
const CHIP_LABEL_SELECTORS = ['.worktree-sidebar-chip-label', '.dark .worktree-sidebar-chip-label']

describe('worktree sidebar chip surface', () => {
  // Why: an opaque fill is pre-mixed against the sidebar base, so on a selected card —
  // itself a foreground-10% wash over that same base — the chip and the card resolve to
  // the same color and the chip disappears. Mixing toward `transparent` composites over
  // the chip's real parent, holding one step on every surface and appearance mode.
  it.each(CHIP_SURFACE_SELECTORS)('fills %s with an alpha overlay', (selector) => {
    const background = readDeclaration(selector, 'background')

    expect(background).toMatch(/^color-mix\(/)
    expect(background).toMatch(/transparent\s*\)$/)
  })

  it.each(CHIP_LABEL_SELECTORS)('tints %s against its own surface', (selector) => {
    const color = readDeclaration(selector, 'color')

    expect(color).toMatch(/^color-mix\(/)
    expect(color).toMatch(/transparent\s*\)$/)
  })

  it('keeps the chip border out of the way instead of tinting it', () => {
    expect(readDeclaration('.worktree-sidebar-chip', 'border-color')).toBe('transparent')
  })

  it('keeps the meta-row chips off base-mixed surface tokens', () => {
    const source = readFileSync(resolve(testDir, 'worktree-card-meta-row.tsx'), 'utf8')

    // Both chips in the row — the repo badge and the host pill — must carry the class,
    // so deleting it rather than fixing it can't satisfy the absence checks below.
    expect(source.match(/worktree-sidebar-chip(?=[\s"'])/g)).toHaveLength(2)
    expect(source).toMatch(/worktree-sidebar-chip-label(?=[\s"'])/)
    expect(source).not.toMatch(/\bbg-accent\b/)
    expect(source).not.toMatch(/\bborder-border\b/)
  })
})
