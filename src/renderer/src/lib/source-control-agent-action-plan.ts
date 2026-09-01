import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import { isCustomTuiAgentId, resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'
import type { BuiltInTuiAgent, GlobalSettings, TuiAgent } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

// Preview classes mirror the host `availabilityCheck` projection (plan §830/§972):
// a stock-prefix launch is gated on baseline detection, while a configured
// executable or agent env is launch-reported and must never be blocked here —
// baseline stock detection cannot evaluate it, no preflight runs anywhere, and
// only the real launch on the execution host reports the outcome.
export type SourceControlAgentAvailabilityClass = 'baseline-detection' | 'launch-reported'

export type SourceControlAgentAvailability = {
  /** Proven built-in base of the selected id; null for an unknown/unresolvable id. */
  baseAgent: BuiltInTuiAgent | null
  availabilityClass: SourceControlAgentAvailabilityClass
}

type SourceControlAgentAvailabilitySettings = Partial<
  Pick<
    GlobalSettings,
    'customTuiAgents' | 'deletedCustomTuiAgents' | 'agentCmdOverrides' | 'agentDefaultEnv'
  >
>

/** Resolve the selected agent's proven base and availability class from the local
 *  catalog view. Custom ids resolve their base through the catalog (never id syntax),
 *  and a configured executable or agent env marks the row launch-reported so a
 *  base-not-detected host cannot falsely block it. Zero host projection field added. */
export function resolveSourceControlAgentAvailability(
  agent: TuiAgent | null | undefined,
  settings: SourceControlAgentAvailabilitySettings | null | undefined
): SourceControlAgentAvailability {
  const baseAgent = resolveTuiAgentBaseAgent(
    agent,
    settings?.customTuiAgents,
    settings?.deletedCustomTuiAgents
  )
  if (!agent || baseAgent === null) {
    return { baseAgent, availabilityClass: 'baseline-detection' }
  }
  if (isCustomTuiAgentId(agent)) {
    const definition = settings?.customTuiAgents?.find((candidate) => candidate?.id === agent)
    const usesHostPreflight = Boolean(
      definition && (definition.commandOverride || Object.keys(definition.env ?? {}).length > 0)
    )
    return {
      baseAgent,
      availabilityClass: usesHostPreflight ? 'launch-reported' : 'baseline-detection'
    }
  }
  const override = settings?.agentCmdOverrides?.[baseAgent]
  const env = settings?.agentDefaultEnv?.[baseAgent]
  const usesHostPreflight = Boolean(override || (env && Object.keys(env).length > 0))
  return {
    baseAgent,
    availabilityClass: usesHostPreflight ? 'launch-reported' : 'baseline-detection'
  }
}

export type SourceControlLaunchPlanDelivery =
  | 'argv'
  | 'draft-native'
  | 'draft-paste'
  | 'paste-submit'

export type SourceControlLaunchPlanResult =
  | {
      ok: true
      delivery: SourceControlLaunchPlanDelivery
      // A delivery-mode label, not a reconstructed command: the host owns command
      // assembly for every id (plan §U8), so a client-rebuilt command would be a
      // drift-prone claim and would resurrect the registry-unsafe assembly path.
      deliveryLabel: string
      summary: string
      caveat: string
    }
  | { ok: false; error: string }

function resolveDelivery(
  baseAgent: BuiltInTuiAgent,
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
): SourceControlLaunchPlanDelivery {
  const config = TUI_AGENT_CONFIG[baseAgent]
  if (promptDelivery === 'submit-after-ready') {
    return 'paste-submit'
  }
  if (promptDelivery === 'draft') {
    // Native draft prefill exists when the base exposes a `--prefill`-style flag or
    // an equivalent draft env var; otherwise the draft is pasted after the TUI is ready.
    return config.draftPromptFlag || config.draftPromptEnvVar ? 'draft-native' : 'draft-paste'
  }
  if (config.promptInjectionMode === 'stdin-after-start') {
    return 'draft-paste'
  }
  return 'argv'
}

const DELIVERY_LABELS: Record<SourceControlLaunchPlanDelivery, string> = {
  'paste-submit': 'Pasted and submitted after the TUI is ready',
  'draft-native': 'Prefilled as an editable draft',
  'draft-paste': 'Pasted as an editable draft after the TUI is ready',
  argv: 'Sent as the first-turn command'
}

const DELIVERY_SUMMARIES: Record<SourceControlLaunchPlanDelivery, string> = {
  'paste-submit':
    'The agent starts with no prompt, then Orca pastes and submits the command input after the TUI is ready.',
  'draft-native':
    'The command input is prefilled as an editable draft by the agent launch command.',
  'draft-paste':
    'The agent starts with no prompt, then Orca pastes the command input as an editable draft after the TUI is ready.',
  argv: 'The command input is included in the launch command and submitted as the first turn.'
}

/** Preview/validation only. The launch itself rides the host-resolved identity
 *  (`launchAgentInNewTab` + `sourceRecord`), so this never assembles a command;
 *  it validates the selection and describes how the input will be delivered. */
export function planSourceControlAgentActionLaunch(args: {
  agent: TuiAgent | null
  baseAgent: BuiltInTuiAgent | null
  availabilityClass: SourceControlAgentAvailabilityClass
  commandInput: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
}): SourceControlLaunchPlanResult {
  const agent = args.agent
  if (!agent) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.a7ac8717c7',
        'Choose an agent before starting.'
      )
    }
  }
  if (!isTuiAgentEnabled(agent, args.disabledAgents)) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.b96e091fc9',
        'The selected agent is disabled in Settings.'
      )
    }
  }
  if (args.baseAgent === null) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.8eb541cc83',
        'The selected agent was not detected on this workspace host.'
      )
    }
  }
  // Host-preflight rows stay selectable: baseline stock detection cannot evaluate a
  // configured executable/env, so only baseline-detection rows gate on base detection.
  if (
    args.availabilityClass === 'baseline-detection' &&
    !args.detectedAgents.includes(args.baseAgent)
  ) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.8eb541cc83',
        'The selected agent was not detected on this workspace host.'
      )
    }
  }

  const trimmedInput = args.commandInput.trim()
  if (!trimmedInput) {
    return {
      ok: false,
      error: translate(
        'auto.lib.source.control.agent.action.plan.46f1a2c9bd',
        'Command input is empty.'
      )
    }
  }

  const delivery = resolveDelivery(args.baseAgent, args.promptDelivery)
  return {
    ok: true,
    delivery,
    deliveryLabel: DELIVERY_LABELS[delivery],
    summary: DELIVERY_SUMMARIES[delivery],
    caveat:
      'PATH, binary availability, account setup, and terminal startup failures are checked at launch by the real launch watchdog.'
  }
}
