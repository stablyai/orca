import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_RIPGREP_PACKAGE_BIN_DIR,
  BUNDLED_RIPGREP_PLATFORMS,
  BUNDLED_RIPGREP_RESOURCE_DIR,
  bundledRipgrepBinaryName
} from './bundled-ripgrep'

const requireFromRoot = createRequire(`${process.cwd()}/`)

describe('bundled ripgrep platforms', () => {
  it('packages exactly the layout the runtime resolves', () => {
    const packaging: {
      BUNDLED_RIPGREP_PLATFORMS: string[]
      RIPGREP_PACKAGE_BIN_DIR: string
      RIPGREP_RESOURCE_DIR: string
      ripgrepBinaryName: (platform: string) => string
    } = requireFromRoot('./config/bundled-ripgrep-resources.cjs')

    expect(packaging.BUNDLED_RIPGREP_PLATFORMS).toEqual([...BUNDLED_RIPGREP_PLATFORMS])
    expect(packaging.RIPGREP_PACKAGE_BIN_DIR).toBe(BUNDLED_RIPGREP_PACKAGE_BIN_DIR)
    expect(packaging.RIPGREP_RESOURCE_DIR).toBe(BUNDLED_RIPGREP_RESOURCE_DIR)
    for (const platform of BUNDLED_RIPGREP_PLATFORMS) {
      expect(packaging.ripgrepBinaryName(platform)).toBe(bundledRipgrepBinaryName(platform))
    }
  })
})
