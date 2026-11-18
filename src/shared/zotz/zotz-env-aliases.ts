const ZOTZ_PREFIX = 'ZOTZ_'

/** Lets users write ZOTZ_X for any ORCA_X the code reads; an explicit ORCA_X still wins. */
export function applyZotzEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(ZOTZ_PREFIX) || value === undefined) {
      continue
    }
    const orcaKey = `ORCA_${key.slice(ZOTZ_PREFIX.length)}`
    if (env[orcaKey] === undefined) {
      env[orcaKey] = value
    }
  }
}
