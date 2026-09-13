import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { LaunchAgentInNewTabResult } from '@/lib/launch-agent-in-new-tab'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { StructuredPromptDeliveryResult } from '@/lib/structured-agent-session-launch-prompt'

export type StructuredNewTabLaunchArgs = {
  /** Planned on the structured route with an already-trimmed prompt; empty means no prompt. */
  plan: AgentSessionLaunchPlan
  /** The terminal-backed launch with the same arguments. Runs at most once, on definitive refusal. */
  legacyLaunch: () => LaunchAgentInNewTabResult
}

export type StructuredNewTabLaunch = {
  structuredSettlement: Promise<StructuredAgentLaunchSettlement>
  promptDeliveryResult?: Promise<StructuredPromptDeliveryResult>
}

const UNDELIVERED: StructuredPromptDeliveryResult = { delivered: false, failureNotified: true }

function promptDeliveryFromSettlement(
  settlement: StructuredAgentLaunchSettlement
): Promise<StructuredPromptDeliveryResult> {
  if (settlement.kind === 'structured' || settlement.kind === 'refused-then-legacy') {
    return settlement.promptDeliveryResult ?? Promise.resolve(UNDELIVERED)
  }
  return Promise.resolve(UNDELIVERED)
}

/**
 * The new-tab launcher's structured branch. Returns synchronously so `launchAgentInNewTab` keeps
 * its signature; the settlement carries what the launch actually did, and `promptDeliveryResult`
 * follows it so a refusal reports the terminal fallback's delivery, not the refused structured one.
 */
export function launchAgentInStructuredNewTab(
  args: StructuredNewTabLaunchArgs
): StructuredNewTabLaunch {
  const hasPrompt = Boolean(args.plan.prompt)
  const structuredSettlement = args.plan
    .launch({
      legacyFallback: async () => {
        const fallback = args.legacyLaunch()
        // Why: a legacy launch with no delivery promise still delivered an argv-carried or draft
        // prompt; only a null launch (no startup plan) is a failure.
        const promptDeliveryResult =
          fallback?.promptDeliveryResult ??
          (hasPrompt
            ? Promise.resolve({ delivered: Boolean(fallback), failureNotified: fallback === null })
            : undefined)
        return {
          primaryTabId: fallback?.tabId ?? null,
          ...(promptDeliveryResult ? { promptDeliveryResult } : {})
        }
      }
    })
    .then(
      (settlement): StructuredAgentLaunchSettlement =>
        settlement ?? {
          kind: 'failed',
          error: new Error('Launch planned off the structured route')
        },
      (error: unknown): StructuredAgentLaunchSettlement => ({ kind: 'failed', error })
    )
  void structuredSettlement.then((settlement) => {
    // Why: unknown already shows the launch badge and failed already toasted; this is the log
    // line the old fire-and-forget fallback claim kept.
    if (settlement.kind === 'failed') {
      console.error('Structured agent launch failed', settlement.error)
    }
  })
  return {
    structuredSettlement,
    // Why: draft mode has no delivery event; the composer adopts the text and the user sends it.
    ...(hasPrompt && args.plan.promptDelivery !== 'draft'
      ? { promptDeliveryResult: structuredSettlement.then(promptDeliveryFromSettlement) }
      : {})
  }
}
