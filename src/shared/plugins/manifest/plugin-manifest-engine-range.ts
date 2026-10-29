import { z } from 'zod'

// Why: v0 supports only the ">=x.y.z" form. A closed grammar keeps the gate
// predictable; richer ranges can be added without breaking old manifests.
export const orcaEngineRangeSchema = z
  .string()
  .max(64)
  .regex(/^>=\d+\.\d+\.\d+$/, 'must be a ">=x.y.z" version range')

/** v0 engines gate: supports the ">=x.y.z" grammar the schema enforces. A prerelease host
 *  (`1.5.0-rc.1`) ranks below its release, as in semver; build metadata (`+…`) is ignored. */
export function satisfiesOrcaEngineRange(hostVersion: string, range: string): boolean {
  const minimum = range.slice(2)
  const parse = (value: string): number[] =>
    value
      .split(/[-+]/)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const host = parse(hostVersion)
  const min = parse(minimum)
  for (let i = 0; i < 3; i++) {
    const a = host[i] ?? 0
    const b = min[i] ?? 0
    if (a !== b) {
      return a > b
    }
  }
  return !/^[^+]*-/.test(hostVersion)
}
