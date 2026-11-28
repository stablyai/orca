import { lstat } from 'node:fs/promises'
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import { getWslHostDeploymentStorePath } from './wsl-host-deployment-store'

// Same racy-stamp guard as foreign-sqlite-reader: only cache when all files are settled >3s.
export const ENVIRONMENT_STORE_STAMP_SETTLE_MS = 3_000

export type RegularFileStamp = { token: string; newestMs: number } | 'missing' | null
export type EnvironmentStoreListStamp = {
  token: string
  settled: boolean
  allMissing: boolean
  storeMissing: boolean
}

export async function lstatRegularFileStamp(path: string): Promise<RegularFileStamp> {
  try {
    const info = await lstat(path)
    // Non-regular files (symlinks, directories) must go through the worker's security checks.
    if (!info.isFile()) {
      return null
    }
    return {
      token: `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
      newestMs: Math.max(info.mtimeMs, info.ctimeMs)
    }
  } catch (error) {
    // Only ENOENT is 'missing': the worker read fails closed on ENOTDIR (userDataPath is not a
    // directory), so the allMissing fast path must not answer [] for it.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'missing'
    }
    return null
  }
}

export async function readEnvironmentStoreListStamp(
  userDataPath: string,
  servingWsl: boolean
): Promise<EnvironmentStoreListStamp | null> {
  const settledBeforeMs = Date.now() - ENVIRONMENT_STORE_STAMP_SETTLE_MS
  const [storeStamp, sidecarStamp, wslStamp] = await Promise.all([
    lstatRegularFileStamp(getEnvironmentStorePath(userDataPath)),
    lstatRegularFileStamp(getRuntimeEnvironmentSidecarPath(userDataPath)),
    lstatRegularFileStamp(getWslHostDeploymentStorePath(userDataPath))
  ])
  if (storeStamp === null || sidecarStamp === null || wslStamp === null) {
    return null
  }
  const stamps = [storeStamp, sidecarStamp, wslStamp]
  const allMissing = stamps.every((entry) => entry === 'missing')
  const tokens = stamps.map((entry) => (entry === 'missing' ? 'missing' : entry.token))
  return {
    token: `${servingWsl ? '1' : '0'}|${tokens.join('|')}`,
    settled: stamps.every((entry) => entry === 'missing' || entry.newestMs < settledBeforeMs),
    allMissing,
    storeMissing: storeStamp === 'missing'
  }
}
