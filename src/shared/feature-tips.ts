export type FeatureTipId = 'voice-dictation' | 'agent-status-sidebar'

export type FeatureTipPriority = 'new' | 'unseen'

export type FeatureTipAction = 'enable-voice' | 'open-agent-status-release-notes'

type FeatureTipBase = {
  id: FeatureTipId
  priority: FeatureTipPriority
  eyebrow: string
  title: string
  description: string
  ctaLabel: string
}

export type FeatureTip =
  | (FeatureTipBase & {
      action: 'enable-voice'
    })
  | (FeatureTipBase & {
      action: 'open-agent-status-release-notes'
      releaseNotesUrl: string
    })

export type CompletedFeatureTipState = {
  voiceDictationEnabled: boolean
}

export const FEATURE_TIPS = [
  {
    id: 'voice-dictation',
    priority: 'new',
    eyebrow: 'New',
    title: 'Voice Dictation is here',
    description:
      'Speak into any focused pane and Orca will transcribe it. Press the dictation shortcut to start and stop.',
    action: 'enable-voice',
    ctaLabel: 'Set Up Voice'
  },
  {
    id: 'agent-status-sidebar',
    priority: 'new',
    eyebrow: 'New in 1.3.41',
    title: "See every agent's live status in the sidebar",
    description:
      'Worktree cards now show each agent inline with a status dot, so you can spot what is working and what is done without opening every terminal.',
    action: 'open-agent-status-release-notes',
    ctaLabel: "See What's New",
    releaseNotesUrl: 'https://onorca.dev/changelog/1-3-41'
  }
] as const satisfies readonly FeatureTip[]

export const FEATURE_TIP_IDS = FEATURE_TIPS.map((tip) => tip.id)

export function isFeatureTipId(value: unknown): value is FeatureTipId {
  return typeof value === 'string' && FEATURE_TIP_IDS.includes(value as FeatureTipId)
}

export function normalizeFeatureTipIds(value: unknown): FeatureTipId[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<FeatureTipId>()
  for (const item of value) {
    if (isFeatureTipId(item)) {
      seen.add(item)
    }
  }
  return [...seen]
}

export function getCompletedFeatureTipIds(state: CompletedFeatureTipState): Set<FeatureTipId> {
  const completedIds = new Set<FeatureTipId>()
  if (state.voiceDictationEnabled) {
    completedIds.add('voice-dictation')
  }
  return completedIds
}

export function getOrderedUnseenFeatureTips(args: {
  seenTipIds: ReadonlySet<FeatureTipId>
  completedTipIds?: ReadonlySet<FeatureTipId>
}): FeatureTip[] {
  const completedTipIds = args.completedTipIds ?? new Set<FeatureTipId>()
  const unseenTips = FEATURE_TIPS.filter(
    (tip) => !args.seenTipIds.has(tip.id) && !completedTipIds.has(tip.id)
  )
  return [
    ...unseenTips.filter((tip) => tip.priority === 'new'),
    ...unseenTips.filter((tip) => tip.priority !== 'new')
  ]
}
