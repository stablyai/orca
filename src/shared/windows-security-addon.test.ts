import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { trustedPackagePath } from './windows-security-addon'

describe('trustedPackagePath', () => {
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

  function layout(): { app: string; inside: string; beside: string; above: string } {
    const root = mkdtempSync(join(tmpdir(), 'orca-addon-trust-'))
    roots.push(root)
    const file = (path: string) => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, '')
      return path
    }
    return {
      app: join(root, 'app'),
      inside: file(join(root, 'app', 'node_modules', '@orca', 'windows-security', 'index.js')),
      // A sibling whose name merely starts with the app's must not count as inside it.
      beside: file(join(root, 'app-evil', 'node_modules', '@orca', 'windows-security', 'index.js')),
      // What a bare specifier finds by walking past the app, e.g. C:\node_modules on a shared host.
      above: file(join(root, 'node_modules', '@orca', 'windows-security', 'index.js'))
    }
  }

  it('accepts the package where the app ships it', () => {
    const { app, inside } = layout()
    expect(trustedPackagePath(inside, [app])).toContain('windows-security')
  })

  it('refuses a resolution outside every app root', () => {
    const { app, beside, above } = layout()
    expect(() => trustedPackagePath(above, [app])).toThrow(/outside the app/)
    expect(() => trustedPackagePath(beside, [app])).toThrow(/outside the app/)
  })
})
