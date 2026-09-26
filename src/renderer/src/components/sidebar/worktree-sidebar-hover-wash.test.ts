import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function readMainCss(): string {
  return readFileSync(resolve(import.meta.dirname, '../../assets/main.css'), 'utf8')
}

function backgroundOf(css: string, selectorSource: string): string {
  const block =
    new RegExp(`${selectorSource}\\s*\\{(?<body>[^}]*)\\}`).exec(css)?.groups?.body ?? ''
  return block.match(/background:\s*(?<value>[^;]+);/)?.groups?.value?.trim() ?? ''
}

const CARD_HOVER = String.raw`\.worktree-sidebar-card-hover:hover:not\(:has\(\.worktree-agent-row-hover:hover\)\)`
const DARK_CARD_HOVER = String.raw`\.dark ${CARD_HOVER}`
const ROW_HOVER = String.raw`\[data-worktree-card-surface\]\s*\.worktree-agent-row-hover:hover:not\([^)]*\)`
const DARK_ROW_HOVER = String.raw`\.dark\s*\[data-worktree-card-surface\]\s*\.worktree-agent-row-hover:hover:not\([^)]*\)`

const COMPACT_LINEAGE_HOVER = String.raw`\[data-compact-agent-list='true'\]\s*\.compact-agent-row\.worktree-agent-lineage-parent-row\.worktree-agent-row-hover:hover:not\([^)]*\),[^{]*`
const DARK_COMPACT_LINEAGE_HOVER = String.raw`\.dark\s*${COMPACT_LINEAGE_HOVER}`

describe('worktree sidebar hover wash', () => {
  it('gives a hovered agent row the same wash as its card', () => {
    const css = readMainCss()

    expect(backgroundOf(css, ROW_HOVER)).toBe(backgroundOf(css, CARD_HOVER))
    expect(backgroundOf(css, DARK_ROW_HOVER)).toBe(backgroundOf(css, DARK_CARD_HOVER))
    expect(backgroundOf(css, CARD_HOVER)).not.toBe('')
    expect(backgroundOf(css, DARK_CARD_HOVER)).not.toBe('')
  })

  it('washes compact lineage rows like plain rows, since the list drops their fill', () => {
    const css = readMainCss()

    expect(backgroundOf(css, COMPACT_LINEAGE_HOVER)).toBe(backgroundOf(css, CARD_HOVER))
    expect(backgroundOf(css, DARK_COMPACT_LINEAGE_HOVER)).toBe(backgroundOf(css, DARK_CARD_HOVER))
  })

  it('keeps every hover wash off the selected row', () => {
    const css = readMainCss()
    const selectors = [ROW_HOVER, DARK_ROW_HOVER, COMPACT_LINEAGE_HOVER, DARK_COMPACT_LINEAGE_HOVER]

    for (const selector of selectors) {
      expect(new RegExp(selector).exec(css)?.[0] ?? '').toContain(
        "[data-focused-agent-pane='true']"
      )
    }
  })

  it('keeps the card-wide row wash out of lineage rows, which have their own rules', () => {
    const css = readMainCss()
    const scoped = new RegExp(`${ROW_HOVER}`).exec(css)?.[0] ?? ''

    expect(scoped).toContain("[data-focused-agent-pane='true']")
    expect(scoped).toContain('.worktree-agent-lineage-parent-row')
    expect(scoped).toContain('.worktree-agent-lineage-child-row')
  })
})
