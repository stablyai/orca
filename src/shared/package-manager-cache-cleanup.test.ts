import { describe, expect, it } from 'vitest'
import {
  detectPackageManagersFromFilenames,
  getPackageManagerCacheCleanupAction,
  getPackageManagerCacheCleanupActions,
  getPackageManagerCacheSafetyCopy
} from './package-manager-cache-cleanup'

describe('package manager cache cleanup metadata', () => {
  it('detects package managers from top-level lockfiles', () => {
    const detected = detectPackageManagersFromFilenames([
      'package.json',
      'pnpm-lock.yaml',
      'package-lock.json',
      'bun.lockb',
      'src'
    ])

    expect(detected.get('pnpm')).toEqual(['pnpm-lock.yaml'])
    expect(detected.get('npm')).toEqual(['package-lock.json'])
    expect(detected.get('bun')).toEqual(['bun.lockb'])
    expect(detected.has('yarn')).toBe(false)
  })

  it('uses conservative commands for safe defaults and explicit aggressive cleanup', () => {
    expect(getPackageManagerCacheCleanupAction('pnpm', 'pnpm-store-prune')).toMatchObject({
      binary: 'pnpm',
      args: ['store', 'prune'],
      safety: 'safe'
    })
    expect(getPackageManagerCacheCleanupAction('npm', 'npm-cache-verify')).toMatchObject({
      binary: 'npm',
      args: ['cache', 'verify'],
      safety: 'safe'
    })
    expect(getPackageManagerCacheCleanupAction('npm', 'npm-cache-clean-force')).toMatchObject({
      binary: 'npm',
      args: ['cache', 'clean', '--force'],
      safety: 'aggressive'
    })
    expect(getPackageManagerCacheCleanupActions('yarn')[0]).toMatchObject({
      binary: 'yarn',
      args: ['cache', 'clean'],
      safety: 'aggressive'
    })
    expect(getPackageManagerCacheCleanupActions('bun')[0]).toMatchObject({
      binary: 'bun',
      args: ['pm', 'cache', 'rm'],
      safety: 'aggressive'
    })
  })

  it('keeps safety copy explicit', () => {
    expect(getPackageManagerCacheSafetyCopy('safe')).toBe('Safe default')
    expect(getPackageManagerCacheSafetyCopy('aggressive')).toBe('Aggressive')
  })
})
