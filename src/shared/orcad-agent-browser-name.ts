export function orcadAgentBrowserNativeName(
  platformName: NodeJS.Platform,
  architecture: string,
  linuxLibc: 'glibc' | 'musl' = 'glibc'
): string {
  const ext = platformName === 'win32' ? '.exe' : ''
  const platformToken =
    platformName === 'linux' && linuxLibc === 'musl' ? 'linux-musl' : platformName
  return `agent-browser-${platformToken}-${architecture}${ext}`
}

/** Set by `orca serve` for orcad: the app's bundled driver, since desktop orcad slots omit it. */
export const ORCAD_AGENT_BROWSER_DRIVER_ENV = 'ORCA_AGENT_BROWSER_DRIVER'
