import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('BrowserPagePane render IPC boundary', () => {
  it('derives toolbar URLs without querying the webview', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./BrowserPane.tsx', import.meta.url)),
      'utf8'
    )
    const start = source.indexOf('const isBlankTab =', source.indexOf('function BrowserPagePane'))
    const end = source.indexOf('useEffect(() => {', start)
    const renderUrlDerivation = source.slice(start, end)

    expect(renderUrlDerivation).toContain('getLiveBrowserUrl(browserTab.id)')
    expect(renderUrlDerivation).not.toContain('webviewRef')
    expect(renderUrlDerivation).not.toContain('.getURL(')
  })
})
