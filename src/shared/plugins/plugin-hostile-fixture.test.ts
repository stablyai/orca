import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('hostile panel fixture', () => {
  it('is complete JavaScript and retains every containment probe', async () => {
    const html = await readFile(
      join(process.cwd(), 'examples', 'plugins', 'hostile-panel', 'panel.html'),
      'utf8'
    )
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]

    expect(script).toBeTruthy()
    if (!script) {
      throw new Error('hostile fixture script is missing')
    }
    expect(() => new Script(script)).not.toThrow()
    expect(html).toContain('self-navigation')
    expect(html).toContain('meta-refresh-navigation')
    expect(html).toContain('Navigation probes are opt-in')
    expect(html).toContain("window.name = ''")
    expect(html).toContain('oversized-message')
    expect(html).toContain('message-flood')
    expect(html).toContain("data.errorCode === 'rate_limited'")
    expect(html).toContain('busy-loop')
    expect(html.trimEnd()).toMatch(/<\/html>$/)
  })
})
