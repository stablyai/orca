export const AGENT_AWAKE_TITLE = 'Keep computer awake while agents are working'

export function getAgentAwakeDescription(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string {
  if (userAgent.includes('Windows')) {
    return "Keeps this computer and display awake while agents are working. Lid-close behavior follows this device's power settings."
  }

  return 'Keeps this computer and display awake while agents are working. Orca also asks this device to stay awake when the lid is closed, subject to its power policy.'
}

export function getAgentAwakeSearchKeywords(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string[] {
  const keywords = ['awake', 'sleep', 'power', 'agent', 'running', 'working', 'lid', 'display']
  return userAgent.includes('Linux') ? [...keywords, 'linux'] : keywords
}
