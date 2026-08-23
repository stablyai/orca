import { existsSync, readFileSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { permissionBitsAreEnforced } from '../../../src/shared/file-mode-capability'
import {
  createNestedRuntimeProxyJumpFixture,
  type NestedRuntimeProxyJumpFixture
} from './nested-runtime-proxy-jump-fixture'

describe('nested runtime ProxyJump fixture', () => {
  let fixture: NestedRuntimeProxyJumpFixture | null = null

  afterEach(() => fixture?.dispose())

  it('removes its exact wrapper and config directory on disposal', () => {
    fixture = createNestedRuntimeProxyJumpFixture()
    fixture.writeConfig('Host destination\n  HostName 127.0.0.1\n')

    // Why the capability and not the platform: there is no exec bit to assert where a
    // mode is not kept. The wrapper's existence and the rest of the case still run.
    expect(existsSync(fixture.wrapperPath)).toBe(true)
    if (permissionBitsAreEnforced()) {
      expect(statSync(fixture.wrapperPath).mode & 0o111).not.toBe(0)
    }
    expect(readFileSync(fixture.configPath, 'utf8')).toContain('Host destination')

    const directory = fixture.directory
    fixture.dispose()
    fixture = null

    expect(existsSync(directory)).toBe(false)
  })
})
