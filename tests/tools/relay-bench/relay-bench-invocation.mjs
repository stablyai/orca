// Argument parsing and the two guards every script in this directory runs before it opens a
// socket. Why: these benches dial real relay infrastructure with real credentials, so nothing
// here carries a production default. The operator names the target and opts in explicitly, which
// makes an accidental or automated run inert rather than live traffic against production.
export const LIVE_ENV_VAR = 'ORCA_RELAY_BENCH_LIVE'
export const DIRECTOR_ENV_VAR = 'ORCA_RELAY_BENCH_DIRECTOR'

export function parseArgs(argv) {
  const flags = new Set()
  const options = new Map()
  const positional = []
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    if (equals === -1) {
      flags.add(arg)
    } else {
      options.set(arg.slice(0, equals), arg.slice(equals + 1))
    }
  }
  return { flags, options, positional }
}

export function refuse(message) {
  console.error(message)
  process.exit(2)
}

export function requireLiveRun(usage) {
  if (process.env[LIVE_ENV_VAR] !== '1') {
    refuse(`refusing to dial the relay: set ${LIVE_ENV_VAR}=1 to opt in. usage: ${usage}`)
  }
}

export function requireOrigin(value, label, usage) {
  if (!value) {
    refuse(`missing ${label}. usage: ${usage}`)
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return refuse(`${label} is not a URL: ${value}. usage: ${usage}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    refuse(`${label} must be an http(s) origin: ${value}. usage: ${usage}`)
  }
  return parsed.origin
}

export function requireDirector(options, usage) {
  return requireOrigin(
    options.get('--director') ?? process.env[DIRECTOR_ENV_VAR],
    `director origin (--director=<origin> or ${DIRECTOR_ENV_VAR})`,
    usage
  )
}
