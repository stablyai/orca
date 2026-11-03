import type { AgentStatus } from './agent-title-core'
import type { TerminalAgent } from './terminal-agent'

export function hermesNativeTitleStatus(
  title: string,
  agent: TerminalAgent | null
): AgentStatus | null {
  if (agent !== 'hermes') {
    return null
  }
  const marker = title.match(/^(✓|⏳|⚠)\uFE0F?(?:\s|$)/u)?.[1]
  if (marker === '✓') {
    return 'idle'
  }
  if (marker === '⏳') {
    return 'working'
  }
  if (marker === '⚠') {
    return 'permission'
  }
  return null
}
