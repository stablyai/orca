import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    manager.setSources({
      kimchiExtensionSource: '// kimchi status',
      kimchiPrefillExtensionSource: '// kimchi prefill'
    })

    const result = manager.materializePi('wsl-kimchi', undefined, 'kimchi', {
      materializeDefaultHome: true
    })

    expect(result?.sourceAgentDir).toBe(join(home, '.config', 'kimchi', 'harness'))
    expect(readFileSync(result!.statusExtensionPath!, 'utf8')).toContain('// kimchi status')
    expect(
      readFileSync(
        join(home, '.config', 'kimchi', 'harness', 'extensions', 'orca-prefill.ts'),
        'utf8'
      )
    ).toContain('// kimchi prefill')
  })

  it.runIf(process.platform !== 'win32')('preserves an unreadable user prefill extension', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-kimchi-wsl-'))
    homes.push(home)
    const extensionsDir = join(home, '.config', 'kimchi', 'harness', 'extensions')
    const prefillPath = join(extensionsDir, 'orca-prefill.ts')
    mkdirSync(extensionsDir, { recursive: true })
    writeFileSync(prefillPath, '// user prefill')
    chmodSync(prefillPath, 0o200)
    const manager = new PluginOverlayManager({ homeDir: home })
    manager.setSources({
      kimchiExtensionSource: '// kimchi status',
      kimchiPrefillExtensionSource: '// managed prefill'
    })

    manager.materializePi('wsl-kimchi', undefined, 'kimchi', { materializeDefaultHome: true })
    chmodSync(prefillPath, 0o600)

    expect(readFileSync(prefillPath, 'utf8')).toBe('// user prefill')
  })
})
