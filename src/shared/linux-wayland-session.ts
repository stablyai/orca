export function isLinuxWaylandSession(host: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  ozonePlatform?: string
}): boolean {
  const platform = (host.ozonePlatform ?? '').trim().toLowerCase()
  if (platform === 'auto') {
    return host.platform === 'linux' && host.env.XDG_SESSION_TYPE === 'wayland'
  }
  if (platform) {
    return host.platform === 'linux' && platform === 'wayland'
  }
  return (
    host.platform === 'linux' &&
    (Boolean(host.env.WAYLAND_DISPLAY) || host.env.XDG_SESSION_TYPE === 'wayland')
  )
}
