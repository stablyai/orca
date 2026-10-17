import type { LaunchAgentInNewTabResult } from '@/lib/launch-agent-in-new-tab'

export function shouldQueueTerminalFocusAfterMenuClose(
  result: NonNullable<LaunchAgentInNewTabResult>
): boolean {
  return result.surface.kind === 'host-published'
}
