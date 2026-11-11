import {
  hasFeatureInteraction,
  type FeatureInteractionId,
  type FeatureInteractionState
} from './feature-interactions'
import type { TelemetrySettings } from './telemetry-settings-types'

export type FeatureTipId =
  | 'chat-ui-here'
  | 'voice-dictation'
  | 'orca-cli'
  | 'cmd-j-palette'
  | 'agent-session-search'

export type FeatureTipSeenId = FeatureTipId | 'chat-ui-here-rollout-v1'

export function getFeatureTipSeenId(
  id: FeatureTipId,
  telemetry: Pick<TelemetrySettings, 'chatUiLaunchTipRolloutCohort'> | undefined
): FeatureTipSeenId {
  return id === 'chat-ui-here' && telemetry?.chatUiLaunchTipRolloutCohort
    ? 'chat-ui-here-rollout-v1'
    : id
}

export type FeatureTipPriority = 'new' | 'unseen'

export type FeatureTipAction =
  | 'use-chat-ui'
  | 'enable-voice'
  | 'setup-cli'
  | 'learn-cmd-j-palette'
  | 'enable-session-search'

export type FeatureTip = {
  id: FeatureTipId
  priority: FeatureTipPriority
  eyebrow: string
  title: string
  description: string
  action: FeatureTipAction
  ctaLabel: string
  completedByFeatureInteractions?: readonly FeatureInteractionId[]
}

export type CompletedFeatureTipState = {
  cliInstalled: boolean
  voiceDictationEnabled: boolean
  /** Search is on, or this client cannot turn it on. */
  sessionSearchTipCompleted: boolean
  /** Main's once-decided record leaves this profile out, or this client has no such profile. */
  chatUiLaunchTipCompleted: boolean
  featureInteractions?: FeatureInteractionState
}

export const FEATURE_TIPS = [
  {
    // First, so upgraded profiles meet it on their first launch after Chat UI left Experimental.
    id: 'chat-ui-here',
    priority: 'new',
    eyebrow: 'New',
    title: 'Chat UI is here',
    description: 'Agents can now open as a chat, with rich messages, visuals and images.',
    action: 'use-chat-ui',
    ctaLabel: 'Use Chat UI',
    completedByFeatureInteractions: []
  },
  {
    id: 'agent-session-search',
    priority: 'new',
    eyebrow: 'New',
    title: 'Search every agent session',
    description:
      'Find any past conversation by what was said in it, then pick up where the agent left off.',
    action: 'enable-session-search',
    ctaLabel: 'Turn on session search',
    completedByFeatureInteractions: []
  },
  {
    id: 'orca-cli',
    priority: 'new',
    eyebrow: 'Tip',
    title: 'Let agents drive Orca with the Orca CLI',
    description: 'Enable agents to coordinate child worktrees and communicate between worktrees.',
    action: 'setup-cli',
    ctaLabel: 'Install CLI & Skills',
    completedByFeatureInteractions: []
  },
  {
    id: 'cmd-j-palette',
    priority: 'new',
    eyebrow: 'Tip',
    // The dialog replaces <shortcut> with a live platform-aware <kbd>.
    title: 'Jump to a worktree with <shortcut>',
    description:
      'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.',
    action: 'learn-cmd-j-palette',
    ctaLabel: 'Got it',
    completedByFeatureInteractions: []
  },
  {
    id: 'voice-dictation',
    priority: 'unseen',
    eyebrow: 'Tip',
    title: 'Dictate into any pane',
    description: 'Start voice dictation in any focused pane, then use the shortcut again to stop.',
    action: 'enable-voice',
    ctaLabel: 'Set up voice dictation',
    completedByFeatureInteractions: ['voice-dictation']
  }
] as const satisfies readonly FeatureTip[]

export const FEATURE_TIP_IDS = FEATURE_TIPS.map((tip) => tip.id)
export const FEATURE_TIP_SEEN_IDS: readonly FeatureTipSeenId[] = [
  ...FEATURE_TIP_IDS,
  'chat-ui-here-rollout-v1'
]

export function isFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === 'string' && FEATURE_TIP_IDS.includes(value as FeatureTipId)
}

export function isFeatureTipSeenId(value: unknown): value is FeatureTipSeenId {
  return value === 'chat-ui-here-rollout-v1' || isFeatureTipId(value)
}

export function normalizeFeatureTipIds(value: unknown): FeatureTipSeenId[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<FeatureTipSeenId>()
  for (const item of value) {
    if (isFeatureTipSeenId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

export function getCompletedFeatureTipIds(state: CompletedFeatureTipState): Set<FeatureTipId> {
  const completedIds = new Set<FeatureTipId>()
  if (state.cliInstalled) {
    completedIds.add('orca-cli')
  }
  if (state.voiceDictationEnabled) {
    completedIds.add('voice-dictation')
  }
  if (state.sessionSearchTipCompleted) {
    completedIds.add('agent-session-search')
  }
  if (state.chatUiLaunchTipCompleted) {
    completedIds.add('chat-ui-here')
  }
  for (const tip of FEATURE_TIPS) {
    if (
      tip.completedByFeatureInteractions?.some((id) =>
        hasFeatureInteraction(state.featureInteractions, id)
      )
    ) {
      completedIds.add(tip.id)
    }
  }
  return completedIds
}

export function getOrderedUnseenFeatureTips(args: {
  seenTipIds: ReadonlySet<FeatureTipSeenId>
  completedTipIds?: ReadonlySet<FeatureTipId>
  telemetry?: Pick<TelemetrySettings, 'chatUiLaunchTipRolloutCohort'>
}): FeatureTip[] {
  const completedTipIds = args.completedTipIds ?? new Set<FeatureTipId>()
  const unseenTips = FEATURE_TIPS.filter(
    (tip) =>
      !args.seenTipIds.has(getFeatureTipSeenId(tip.id, args.telemetry)) &&
      !completedTipIds.has(tip.id)
  )
  return [
    ...unseenTips.filter((tip) => tip.priority === 'new'),
    ...unseenTips.filter((tip) => tip.priority !== 'new')
  ]
}
