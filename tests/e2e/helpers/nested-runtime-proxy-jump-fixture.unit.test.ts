import { existsSync, readFileSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
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

    expect(statSync(fixture.wrapperPath).mode & 0o111).not.toBe(0)
    expect(readFileSync(fixture.configPath, 'utf8')).toContain('Host destination')

    const directory = fixture.directory
    fixture.dispose()
    fixture = null

    expect(existsSync(directory)).toBe(false)
  })
})
