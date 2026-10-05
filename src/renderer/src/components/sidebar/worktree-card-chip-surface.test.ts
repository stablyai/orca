import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WorktreeHostContextBadge } from './WorktreeHostContextBadge'

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

const CHIP_BACKGROUNDS = [
  ['.worktree-sidebar-chip', 'color-mix(in srgb, var(--foreground) 8%, transparent)'],
  ['.dark .worktree-sidebar-chip', 'color-mix(in srgb, var(--foreground) 12%, transparent)']
] as const
const CHIP_LABEL_FOREGROUND_PERCENT = 70
const CHIP_LABEL_COLOR = `color-mix(in srgb, var(--foreground) ${CHIP_LABEL_FOREGROUND_PERCENT}%, transparent)`
const SELECTED_CARD_SELECTOR = "[data-worktree-card-surface][data-worktree-card-active='primary']"
const CHIP_LABEL_CONTRAST_CASES = [
  [
    'default light',
    ':root',
    '.worktree-sidebar-chip',
    SELECTED_CARD_SELECTOR,
    '--worktree-sidebar'
  ],
  [
    'Match-terminal dark',
    '.dark',
    '.dark .worktree-sidebar-chip',
    `.dark ${SELECTED_CARD_SELECTOR}`,
    '#171717'
  ]
] as const

function readGrayscaleChannel(value: string): number {
  expect(value).toMatch(/^#[\da-f]{6}$/i)
  const red = Number.parseInt(value.slice(1, 3), 16)
  expect(Number.parseInt(value.slice(3, 5), 16)).toBe(red)
  expect(Number.parseInt(value.slice(5, 7), 16)).toBe(red)
  return red
}

function readMixPercentage(value: string, variable: string): number {
  const percentage = value.match(
    new RegExp(`var\\(${variable}\\)\\s+(?<percentage>\\d+(?:\\.\\d+)?)%`)
  )?.groups?.percentage
  expect(percentage).toBeTypeOf('string')
  return Number(percentage)
}

function linearizeSrgb(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function grayscaleContrast(first: number, second: number): number {
  const firstLuminance = linearizeSrgb(first)
  const secondLuminance = linearizeSrgb(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('worktree sidebar chip surface', () => {
  it.each(CHIP_BACKGROUNDS)('keeps %s theme-relative and layer-relative', (selector, expected) => {
    expect(readDeclaration(selector, 'background')).toBe(expected)
  })

  it('inherits the sleeping-card foreground instead of bypassing its dim', () => {
    expect(readRuleBody('[data-worktree-sleeping-dim]')).toMatch(/--foreground:\s*color-mix\(/)

    for (const [selector] of CHIP_BACKGROUNDS) {
      const background = readDeclaration(selector, 'background')
      expect(background).toContain('var(--foreground)')
      expect(background).not.toContain('var(--worktree-sidebar-foreground)')
    }
  })

  it('keeps the host label layer-relative to its chip surface', () => {
    expect(readDeclaration('.worktree-sidebar-chip-label', 'color')).toBe(CHIP_LABEL_COLOR)
  })

  it.each(CHIP_LABEL_CONTRAST_CASES)(
    'keeps the label contrast above AA in %s',
    (_, themeSelector, chipSelector, selectedCardSelector, sidebarSource) => {
      const foreground = readGrayscaleChannel(readDeclaration(themeSelector, '--foreground'))
      const selectedForeground = readGrayscaleChannel(
        readDeclaration(themeSelector, '--worktree-sidebar-foreground')
      )
      const sidebar = readGrayscaleChannel(
        sidebarSource.startsWith('--')
          ? readDeclaration(themeSelector, sidebarSource)
          : sidebarSource
      )
      const selectedCardFill = readDeclaration(selectedCardSelector, 'background')
      const selectedCardShare = readMixPercentage(selectedCardFill, '--worktree-sidebar-foreground')
      const selectedCard =
        selectedForeground * (selectedCardShare / 100) + sidebar * (1 - selectedCardShare / 100)
      const chipFill = readDeclaration(chipSelector, 'background')
      const chipShare = readMixPercentage(chipFill, '--foreground') / 100
      const chip = foreground * chipShare + selectedCard * (1 - chipShare)
      const labelShare = CHIP_LABEL_FOREGROUND_PERCENT / 100
      const label = foreground * labelShare + chip * (1 - labelShare)

      expect(grayscaleContrast(label, chip)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('keeps the chip border out of the way instead of tinting it', () => {
    expect(readDeclaration('.worktree-sidebar-chip', 'border-color')).toBe('transparent')
  })

  it('applies the shared surface to host and repository chips', () => {
    const hostMarkup = renderToStaticMarkup(
      createElement(WorktreeHostContextBadge, { label: 'Remote Mac' })
    )
    const metaRowSource = readFileSync(resolve(testDir, 'worktree-card-meta-row.tsx'), 'utf8')

    expect(hostMarkup).toMatch(/class="[^"]*\bworktree-sidebar-chip\b/)
    expect(hostMarkup).toMatch(/class="[^"]*\bworktree-sidebar-chip-label\b/)
    expect(hostMarkup).not.toMatch(/class="[^"]*\btext-muted-foreground\b/)
    expect(metaRowSource.match(/worktree-sidebar-chip(?=[\s"'])/g)).toHaveLength(1)
    expect(metaRowSource).not.toMatch(/\bbg-accent\b/)
    expect(metaRowSource).not.toMatch(/\bborder-border\b/)
  })
})
