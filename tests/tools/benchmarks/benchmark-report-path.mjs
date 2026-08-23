import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Where a benchmark writes its JSON report.
 *
 * `--output` pins the path so automation can read the report back by name;
 * without it, land in results/ under a timestamped name so local before/after
 * runs accumulate instead of overwriting each other. Creates the directory.
 */
export function resolveBenchmarkReportPath({ output, scriptDir, prefix, label }) {
  if (output) {
    const outPath = resolve(output)
    mkdirSync(dirname(outPath), { recursive: true })
    return outPath
  }
  const resultsDir = join(scriptDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return join(resultsDir, `${prefix}-${label}-${stamp}.json`)
}
