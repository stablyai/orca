import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

function cssBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escapedSelector}\\s*\\{(?<body>[^}]*)\\}`))?.groups?.body ?? ''
}

describe('web viewport shell', () => {
  it('uses dynamic viewport height for document and app shell containers', () => {
    const css = readSource('src/renderer/src/assets/main.css')

    for (const selector of ['body', '#root', '.app-layout']) {
      const block = cssBlock(css, selector)
      expect(block).toContain('height: 100dvh;')
      expect(block).not.toMatch(/height:\s*100vh\b/)
    }
  })

  it('uses dynamic viewport Tailwind utilities for web shell entry points', () => {
    const source = [
      readSource('src/renderer/src/App.tsx'),
      readSource('src/renderer/src/web/main.tsx'),
      readSource('src/renderer/src/web/WebConnect.tsx')
    ].join('\n')

    expect(source).toContain('h-dvh')
    expect(source).toContain('min-h-dvh')
    expect(source).not.toMatch(/\b(?:min-)?h-screen\b/)
  })
})
