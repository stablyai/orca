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

/** Where pnpm installs a target's driver; agent-browser 0.43+ ships each one as an optional package. */
export function agentBrowserDependencyBinaryPath(
  platformName: NodeJS.Platform,
  architecture: string,
  linuxLibc: 'glibc' | 'musl' = 'glibc'
): string[] {
  const target =
    platformName === 'win32'
      ? 'win32-x64-msvc'
      : platformName === 'linux'
        ? `linux-${architecture}-${linuxLibc === 'musl' ? 'musl' : 'gnu'}`
        : `${platformName}-${architecture}`
  const file = platformName === 'win32' ? 'agent-browser.exe' : 'agent-browser'
  return ['node_modules', '@agent-browser', `cli-${target}`, 'bin', file]
}
