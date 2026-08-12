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
  it('keeps dynamic viewport height as the web default', () => {
    const css = readSource('src/renderer/src/assets/main.css')

    for (const selector of ['body', '#root', '.app-layout']) {
      const block = cssBlock(css, selector)
      expect(block).toContain('height: 100dvh;')
      expect(block).not.toMatch(/height:\s*100vh\b/)
    }
  })

  it('uses a percentage height chain only for native Electron shells', () => {
    const css = readSource('src/renderer/src/assets/main.css')
    const nativeIndex = readSource('src/renderer/index.html')
    const popoutIndex = readSource('src/renderer/popout.html')
    const webIndex = readSource('src/renderer/web-index.html')
    const appSource = readSource('src/renderer/src/App.tsx')

    expect(css).toMatch(
      /html\.native-shell,\s*html\.native-shell body,\s*html\.native-shell #root,\s*html\.native-shell \.app-layout\s*\{\s*height: 100%;\s*\}/
    )
    expect(nativeIndex).toContain('<html class="native-shell">')
    expect(popoutIndex).toContain('<html class="native-shell">')
    expect(webIndex).not.toContain('native-shell')
    expect(appSource).toContain('className="app-layout"')
    expect(appSource).not.toContain('h-dvh')
  })

  it('uses dynamic viewport Tailwind utilities for web shell entry points', () => {
    const source = [
      readSource('src/renderer/src/web/main.tsx'),
      readSource('src/renderer/src/web/WebConnect.tsx')
    ].join('\n')

    expect(source).toContain('min-h-dvh')
    expect(source).not.toMatch(/\b(?:min-)?h-screen\b/)
  })
})
