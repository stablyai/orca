/**
 * The argv `orca serve` hands a serve host: Electron as `--serve-*`, orcad as plain flags. Shared so
 * orcad's own tests run the exact command line the CLI builds (#30120 dropped one across it).
 */
export type ServeOrcaAppArgs = {
  json?: boolean
  port?: string | null
  pairingAddress?: string | null
  noPairing?: boolean
  mobilePairing?: boolean
  grantDesktopControl?: boolean
  recipeJson?: boolean
  projectRoot?: string | null
  /** Literal IP to listen on; serve otherwise listens on every interface. */
  bind?: string | null
  /** Comma-separated IPs/CIDR ranges allowed to connect. */
  allowIp?: string | null
  /** Absolute PEM paths; set together. */
  tlsCert?: string | null
  tlsKey?: string | null
  /** Starts Electron serve despite a remembered macOS startup abort in this environment. */
  force?: boolean
  /** Restart the server under a service manager instead of exiting with it; never inferred. */
  supervise?: boolean
}

export function serveOptionArgs(args: ServeOrcaAppArgs, prefix: '--' | '--serve-'): string[] {
  return [
    ...(args.json ? [`${prefix}json`] : []),
    ...(args.port ? [`${prefix}port`, args.port] : []),
    ...(args.pairingAddress ? [`${prefix}pairing-address`, args.pairingAddress] : []),
    ...(args.noPairing ? [`${prefix}no-pairing`] : []),
    ...(args.mobilePairing ? [`${prefix}mobile-pairing`] : []),
    ...(args.grantDesktopControl ? [`${prefix}grant-desktop-control`] : []),
    ...(args.bind ? [`${prefix}bind`, args.bind] : []),
    ...(args.allowIp ? [`${prefix}allow-ip`, args.allowIp] : []),
    ...(args.tlsCert ? [`${prefix}tls-cert`, args.tlsCert] : []),
    ...(args.tlsKey ? [`${prefix}tls-key`, args.tlsKey] : []),
    ...(args.recipeJson && args.projectRoot
      ? [`${prefix}recipe-json`, `${prefix}project-root`, args.projectRoot]
      : [])
  ]
}

/** `bindHost` exists for tests, which must not listen on every interface; `--bind` replaces it. */
export function orcadServeArgs(
  args: ServeOrcaAppArgs,
  webClientRoot?: string,
  bindHost = '0.0.0.0'
): string[] {
  return [
    ...(args.bind ? [] : ['--bind', bindHost]),
    ...serveOptionArgs(args, '--'),
    ...(webClientRoot ? ['--web-client-root', webClientRoot] : [])
  ]
}
