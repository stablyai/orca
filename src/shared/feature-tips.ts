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

const CHAT_UI_HERE_EXTRA_SEEN_IDS = ['chat-ui-here-rollout-v1', 'chat-ui-here-v2'] as const

export type FeatureTipSeenId = FeatureTipId | (typeof CHAT_UI_HERE_EXTRA_SEEN_IDS)[number]

type ChatUiLaunchTipSavedSettings = Pick<
  TelemetrySettings,
  'chatUiLaunchTipCohort' | 'chatUiLaunchTipRolloutCohort' | 'chatUiLaunchTipTargeting'
>

/** Saved values that keep their own targeting; anything else, including an unknown value, is a default profile. */
export function isChatUiLaunchTipTargeted(telemetry: ChatUiLaunchTipSavedSettings | undefined) {
  const saved = telemetry?.chatUiLaunchTipRolloutCohort ?? telemetry?.chatUiLaunchTipCohort
  return (
    saved === 'treatment' ||
    saved === 'treatment-live-switch' ||
    saved === 'treatment-swapped-buttons' ||
    saved === 'treatment-center'
  )
}

/** Not shown the tip earlier for a reason other than being on Chat UI. */
function wasChatUiLaunchTipHeldBackOffChatUi(
  telemetry: ChatUiLaunchTipSavedSettings | undefined
): boolean {
  const targeting = telemetry?.chatUiLaunchTipTargeting
  return (
    (telemetry?.chatUiLaunchTipRolloutCohort ?? telemetry?.chatUiLaunchTipCohort) === 'control' ||
    (isChatUiLaunchTipTargeted(telemetry) &&
      targeting?.mode === 'eligible-harnesses' &&
      targeting.eligible !== true)
  )
}

export function getFeatureTipSeenId(
  id: FeatureTipId,
  telemetry: ChatUiLaunchTipSavedSettings | undefined
): FeatureTipSeenId {
  if (id !== 'chat-ui-here') {
    return id
  }
  // Why: these profiles already have the older ids without having seen the card, so they need a fresh
  // one; the saved assignment no longer changes, so neither does this id after delivery.
  if (wasChatUiLaunchTipHeldBackOffChatUi(telemetry)) {
    return 'chat-ui-here-v2'
  }
  return telemetry?.chatUiLaunchTipRolloutCohort ? 'chat-ui-here-rollout-v1' : id
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
  ...CHAT_UI_HERE_EXTRA_SEEN_IDS
]

export function isFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === 'string' && FEATURE_TIP_IDS.includes(value as FeatureTipId)
}

export function isFeatureTipSeenId(value: unknown): value is FeatureTipSeenId {
  return FEATURE_TIP_SEEN_IDS.some((id) => id === value)
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
  telemetry?: ChatUiLaunchTipSavedSettings
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
