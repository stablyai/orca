/** PTY byte protocols follow the execution host; xterm ConPTY wrap compatibility follows the rendering client. */
export type DashboardClientHost = {
  platform: NodeJS.Platform
  userAgent: string
  osRelease: string | undefined
}

export function readDashboardClientHost(): DashboardClientHost {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  return {
    platform: userAgent.includes('Mac')
      ? 'darwin'
      : userAgent.includes('Windows')
        ? 'win32'
        : 'linux',
    userAgent,
    // Why: absent in the pop-out renderer and in tests, where no preload rides along.
    osRelease: readClientOsRelease()
  }
}

function readClientOsRelease(): string | undefined {
  try {
    return window.api?.platform?.get?.()?.osRelease
  } catch {
    return undefined
  }
}
