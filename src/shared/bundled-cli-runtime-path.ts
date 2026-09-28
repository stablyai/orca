import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Resolve from the entry, never cwd: npm shims and symlinks may live elsewhere. */
export function resolveBundledCliRuntimePath(
  entry: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`Unsupported Orca CLI runtime: ${platform}-${arch}`)
  }
  const out = dirname(dirname(realpathSync(entry)))
  const filename = platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'
  const candidates = [
    join(out, 'cli-runtime', `${platform}-${arch}`, filename),
    join(out, '..', '..', 'cli-runtime', filename)
  ]
  const runtime = candidates.find(existsSync)
  if (!runtime) {
    throw new Error('Orca CLI runtime is missing. Rebuild or reinstall Orca.')
  }
  return runtime
}
