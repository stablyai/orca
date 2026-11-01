// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyPluginAppTheme } from '@/lib/document-theme'
import { contrastRatio, type Rgba } from '@/lib/plugin-theme-tokens'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog'

const css = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')
// Happy DOM only needs the token rules; Tailwind directives are compiled separately.
const tokenCss = [
  ...css.matchAll(/(?:^|\n)(:root[^{}]*|\.dark[^{}]*|\.plugin-security-chrome[^{}]*)\{([^{}]*)\}/g)
]
  .map((match) => match[0])
  .join('\n')
// Happy DOM resolves var() through ancestors but does not report inherited custom properties.
const paintedCss = `[data-slot='dialog-content'] {
  --painted-surface: var(--dialog-surface);
  --painted-text: var(--foreground);
}`

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (hex) {
    const [r = 0, g = 0, b = 0] = hex.slice(1).map((part) => Number.parseInt(part, 16))
    return [r, g, b, 1]
  }
  const rgb = /^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/.exec(value)
  if (!rgb) {
    throw new Error(`Unparsed color: ${value}`)
  }
  const [r = 0, g = 0, b = 0, a = 1] = rgb.slice(1).map((part) => Number(part ?? 1))
  return [r, g, b, a]
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

// Passes the theme's own popover contrast check, but is light grey on a dark base.
const hostileTheme = {
  id: 'plugin:hostile.theme/glare' as const,
  revision: 'r1',
  pluginKey: 'hostile.theme',
  pluginName: 'Glare',
  label: 'Glare',
  base: 'dark' as const,
  tokens: { '--popover': '#d4d4d4', '--popover-foreground': '#111111' }
}
const probe = (value: string): Rgba | null => {
  try {
    return parseColor(value)
  } catch {
    return null
  }
}
const darkBuiltIns = () => ({ '--background': '#0a0a0a', '--foreground': '#fafafa' })

afterEach(() => {
  cleanup()
  applyPluginAppTheme(null, { storage: null })
  document.head.innerHTML = ''
  document.documentElement.className = ''
})

function renderDialogUnderHostileTheme(surface: 'security' | 'default'): HTMLElement {
  document.documentElement.classList.add('dark')
  const sheet = document.createElement('style')
  sheet.textContent = `${tokenCss}\n${paintedCss}`
  document.head.append(sheet)
  applyPluginAppTheme(hostileTheme, { probe, builtIns: darkBuiltIns, storage: null })
  render(
    <Dialog open>
      <DialogContent surface={surface}>
        <DialogTitle>Install plugin?</DialogTitle>
        <DialogDescription>Only install plugins from people you trust.</DialogDescription>
      </DialogContent>
    </Dialog>
  )
  return screen.getByRole('dialog')
}

function textContrast(dialog: HTMLElement): number {
  const style = getComputedStyle(dialog)
  const appBackground = parseColor(
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
  )
  const surface = over(
    parseColor(style.getPropertyValue('--painted-surface').trim()),
    appBackground
  )
  return contrastRatio(surface, parseColor(style.getPropertyValue('--painted-text').trim()))
}

describe('security dialogs under a hostile plugin theme', () => {
  it('keeps trust text readable on a host-owned dialog surface', () => {
    expect(textContrast(renderDialogUnderHostileTheme('security'))).toBeGreaterThanOrEqual(4.5)
  })

  it('applies the hostile surface to ordinary dialogs, so the case above is exercised', () => {
    expect(textContrast(renderDialogUnderHostileTheme('default'))).toBeLessThan(2)
  })
})
