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
