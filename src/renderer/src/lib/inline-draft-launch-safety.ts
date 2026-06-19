import type { AgentDraftLaunchPlan } from '@/lib/tui-agent-startup'

const WIN32_INLINE_DRAFT_LIMIT_CHARS = 24_000

// Why: a newline in the typed launch command submits at the embedded Enter, so
// multi-line drafts must use the post-ready paste path; win32 also caps length.
export function canUseInlineDraftLaunchPlan(
  plan: AgentDraftLaunchPlan,
  platform: NodeJS.Platform
): boolean {
  if (/[\r\n]/.test(plan.launchCommand)) {
    return false
  }
  if (platform !== 'win32') {
    return true
  }
  const envChars = Object.entries(plan.env ?? {}).reduce(
    (total, [key, value]) => total + key.length + value.length,
    0
  )
  return plan.launchCommand.length + envChars <= WIN32_INLINE_DRAFT_LIMIT_CHARS
}
