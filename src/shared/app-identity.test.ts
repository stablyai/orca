import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getAppBundleId,
  getComputerUseBundleId,
  setAppBundleId,
  ORCA_APP_BUNDLE_ID,
  ORCA_COMPUTER_USE_BUNDLE_ID,
  ORCA_DEV_APP_BUNDLE_ID,
  ORCA_LOCAL_APP_BUNDLE_ID
} from './app-identity'

const SRC_ROOT = join(__dirname, '..')

function runtimeSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : runtimeSourceFiles(path)
    }
    return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
      ? [path]
      : []
  })
}

describe('app identity', () => {
  it('keeps the shipped bundle id and its variants', () => {
    expect(ORCA_APP_BUNDLE_ID).toBe('com.stablyai.orca')
    expect(ORCA_DEV_APP_BUNDLE_ID).toBe('com.stablyai.orca.dev')
    expect(ORCA_LOCAL_APP_BUNDLE_ID).toBe('com.stablyai.orca.local')
    expect(ORCA_COMPUTER_USE_BUNDLE_ID).toBe('com.stablyai.orca.computer-use')
  })

  it('is the only runtime source that spells the bundle id', () => {
    // Why: a rebranded build must change one constant; a stray literal would
    // silently keep the old identity for TCC, defaults, or notifications.
    const offenders = runtimeSourceFiles(SRC_ROOT)
      .filter((path) => /['"`]com\.stablyai\.orca/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC_ROOT, path).replaceAll('\\', '/'))
    expect(offenders).toEqual(['shared/app-identity.ts'])
  })
})

describe('runtime app bundle id', () => {
  afterEach(() => setAppBundleId(null))

  it("is Orca's unless a rebranded build sets its own", () => {
    expect(getAppBundleId()).toBe(ORCA_APP_BUNDLE_ID)
    expect(getComputerUseBundleId()).toBe(ORCA_COMPUTER_USE_BUNDLE_ID)

    setAppBundleId('com.example.rebrand')
    expect(getAppBundleId()).toBe('com.example.rebrand')
    expect(getComputerUseBundleId()).toBe('com.example.rebrand.computer-use')

    setAppBundleId(null)
    expect(getAppBundleId()).toBe(ORCA_APP_BUNDLE_ID)
  })
})
