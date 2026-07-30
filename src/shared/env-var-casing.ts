// Why: Windows environment variable names are case-insensitive and native processes
// expose `Path`, while POSIX (and Git Bash) expose `PATH`. Reading `env.PATH` directly
// silently yields undefined for a Windows-spawned child, and writing `PATH` back when
// the child already carries `Path` leaves two colliding keys whose precedence is
// undefined. Resolve the caller's actual key instead of assuming a casing.

/** Reads `name` from `env` under any casing, so a Windows child's `Path` satisfies a `PATH` lookup. */
export function readEnvVar(
  env: Record<string, string | undefined>,
  name: string
): string | undefined {
  const direct = env[name]
  if (direct !== undefined) {
    return direct
  }
  const lowered = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === lowered) {
      return value
    }
  }
  return undefined
}

/** Returns the key `env` already uses for `name` (any casing), else `name` unchanged. */
export function resolveEnvVarKey(env: Record<string, string | undefined>, name: string): string {
  if (env[name] !== undefined) {
    return name
  }
  const lowered = name.toLowerCase()
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lowered) {
      return key
    }
  }
  return name
}
