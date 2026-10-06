// A paired host that predates profiles would silently discard the optional binding.
export function assertTerminalProfilesStayLocal(params: unknown): void {
  if (!params || typeof params !== 'object') {
    return
  }
  const config = 'launchConfig' in params ? params.launchConfig : undefined
  if (
    ('agentProfileId' in params && params.agentProfileId !== undefined) ||
    (config &&
      typeof config === 'object' &&
      'agentProfile' in config &&
      config.agentProfile !== undefined)
  ) {
    throw new Error(
      'Agent profiles are supported only in local terminals. Choose a plain agent for a paired runtime.'
    )
  }
}
