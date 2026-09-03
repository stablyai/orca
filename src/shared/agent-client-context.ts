export const ORCA_AGENT_CLIENT_SURFACES = ['desktop', 'web', 'mobile'] as const
export type OrcaAgentClientSurface = (typeof ORCA_AGENT_CLIENT_SURFACES)[number]

export const ORCA_AGENT_HOST_MODES = ['desktop', 'serve', 'orcad'] as const
export type OrcaAgentHostMode = (typeof ORCA_AGENT_HOST_MODES)[number]

const WEB_AGENT_CONTEXT_HEADER = '<orca-client-context>'
const WEB_AGENT_CONTEXT_FOOTER = '</orca-client-context>'

/**
 * Trusted interaction context for prompts submitted through a paired Web UI.
 *
 * Keep this provider-neutral: the same text can ride in an argv prompt, a
 * delayed TUI paste, or a resumed session's next user turn.
 */
export function buildOrcaAgentClientContext(args: {
  clientSurface: OrcaAgentClientSurface
  hostMode: OrcaAgentHostMode
}): string | null {
  if (args.clientSurface !== 'web') {
    return null
  }
  const noDesktopWindow = args.hostMode === 'serve' || args.hostMode === 'orcad'
  return [
    WEB_AGENT_CONTEXT_HEADER,
    `clientSurface=web hostMode=${args.hostMode}`,
    noDesktopWindow
      ? 'The user is connected through Orca Web UI; this runtime has no user-operable Electron window.'
      : 'The user is connected through Orca Web UI; do not assume they can operate the host Electron window.',
    'Do not instruct the user to click Electron-only menus, settings, dialogs, or local desktop controls.',
    'Prefer Web UI, Orca CLI/RPC, or server-side configuration. If an action is desktop-only, say so and give a Web/CLI/server alternative.',
    'Do not treat an unavailable Electron window as a reason to restart Orca; give an alternative that works from the current surface.',
    WEB_AGENT_CONTEXT_FOOTER
  ].join('\n')
}

export function prependOrcaAgentClientContext(
  prompt: string,
  args: {
    clientSurface: OrcaAgentClientSurface
    hostMode: OrcaAgentHostMode
  }
): string {
  const context = buildOrcaAgentClientContext(args)
  if (!context || prompt.startsWith(`${context}\n\n`)) {
    return prompt
  }
  return `${context}\n\n${prompt}`
}

export function withOrcaAgentClientContextEnv(
  env: Record<string, string> | undefined,
  args: {
    clientSurface: OrcaAgentClientSurface
    hostMode: OrcaAgentHostMode
  }
): Record<string, string> {
  return {
    ...env,
    ORCA_CLIENT_SURFACE: args.clientSurface,
    ORCA_HOST_MODE: args.hostMode
  }
}
