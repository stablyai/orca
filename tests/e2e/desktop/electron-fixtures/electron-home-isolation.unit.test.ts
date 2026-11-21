import { rmSync } from 'node:fs'
import 'node:os'
import 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../src/main/zcode/zcode-v2-plan-credentials'

import { areSameHomePath } from './electron-home-isolation'

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('createElectronHomeIsolation', () => {
  it('compares Windows home paths case-insensitively', () => {
    expect(areSameHomePath('C:\\Users\\Alice', 'c:\\users\\alice', 'win32')).toBe(true)
  })
})
