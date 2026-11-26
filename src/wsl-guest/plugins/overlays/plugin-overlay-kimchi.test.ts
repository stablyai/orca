import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginOverlayManager } from './plugin-overlay'

describe('Kimchi guest plugin installation', () => {
  const homes: string[] = []

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('installs the managed extension into the default Kimchi harness directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-kimchi-wsl-'))
    homes.push(home)
    const manager = new PluginOverlayManager({ homeDir: home })
    manager.setSources({ kimchiExtensionSource: '// kimchi status' })

    const result = manager.materializePi('wsl-kimchi', undefined, 'kimchi', {
      materializeDefaultHome: true
    })

    expect(result?.sourceAgentDir).toBe(join(home, '.config', 'kimchi', 'harness'))
    expect(readFileSync(result!.statusExtensionPath!, 'utf8')).toContain('// kimchi status')
  })
})
