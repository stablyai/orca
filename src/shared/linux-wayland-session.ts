export function isLinuxWaylandSession(host: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  ozonePlatform?: string
}): boolean {
  const platform = (host.ozonePlatform ?? '').toLowerCase()
  const hint = (host.env.ELECTRON_OZONE_PLATFORM_HINT ?? '').toLowerCase()
  return (
    host.platform === 'linux' &&
    platform !== 'x11' &&
    !(platform === '' && hint === 'x11') &&
    (Boolean(host.env.WAYLAND_DISPLAY) ||
      host.env.XDG_SESSION_TYPE === 'wayland' ||
      hint === 'wayland' ||
      platform === 'wayland')
  )
}
