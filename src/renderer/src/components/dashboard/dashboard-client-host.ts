/**
 * The facts about the machine *rendering* the board, as opposed to the machine
 * executing a pty. A card's preview terminal needs both: byte encodings follow
 * the pty's host, while xterm's own ConPTY wrap-marker compat follows the client.
 */
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
