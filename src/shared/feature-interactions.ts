export type FeatureInteractionId =
  | 'workspace-board'
  | 'workspace-agent-sessions'
  | 'workspace-board-actions'
  | 'browser'
  | 'tasks'
  | 'automations'
  | 'automation-created'
  | 'automation-run'
  | 'browser-annotations'
  | 'browser-grab'
  | 'workspace-creation'
  | 'agent-browser-setup'
  | 'agent-browser-use'
  | 'agent-orchestration-setup'
  | 'agent-orchestration'
  | 'ai-commit-generation'
  | 'ai-pr-generation'
  | 'claude-account-switching'
  | 'computer-use-setup'
  | 'computer-use'
  | 'codex-account-switching'
  | 'cookie-import'
  | 'floating-workspace'
  | 'mobile-pairing'
  | 'notifications'
  | 'ports'
  | 'quick-commands'
  | 'resource-manager'
  | 'review-notes'
  | 'ssh'
  | 'terminal-pane-split'
  | 'terminal-panes'
  | 'terminal-tabs'
  | 'tab-splits'
  | 'usage-tracking'
  | 'voice-dictation'
  | 'workspace-cleanup'

export type FeatureInteractionDefinition = {
  id: FeatureInteractionId
  /** The product action that counts as "the user has interacted with this feature." */
  interaction: string
}

export type FeatureInteractionRecord = {
  /** Unix timestamp in milliseconds for the first local interaction. */
  firstInteractedAt: number
  /** Number of local interactions recorded for this feature. */
  interactionCount: number
}

export type FeatureInteractionState = Partial<
  Record<FeatureInteractionId, FeatureInteractionRecord>
>

// Why: these ids become persisted product state; see
// docs/reference/feature-discovery-interaction-tracking.md before changing them.
export const FEATURE_INTERACTIONS = [
  {
    id: 'workspace-board',
    interaction: 'workspace board opened'
  },
  {
    id: 'workspace-agent-sessions',
    interaction: 'workspace agent-session surface opened'
  },
  {
    id: 'workspace-board-actions',
    interaction: 'workspace board card, lane, density, or status action used'
  },
  {
    id: 'browser',
    interaction: 'in-app browser opened'
  },
  {
    id: 'tasks',
    interaction: 'Tasks page opened'
  },
  {
    id: 'automations',
    interaction: 'Automations page opened'
  },
  {
    id: 'automation-created',
    interaction: 'automation created'
  },
  {
    id: 'automation-run',
    interaction: 'automation run queued'
  },
  {
    id: 'browser-annotations',
    interaction: 'browser annotation added, copied, or cleared'
  },
  {
    id: 'browser-grab',
    interaction: 'browser element grab or screenshot used'
  },
  {
    id: 'workspace-creation',
    interaction: 'workspace creation flow opened'
  },
  {
    id: 'agent-browser-setup',
    interaction: 'Agent Browser Use setup enabled or opened'
  },
  {
    id: 'agent-browser-use',
    interaction: 'agent browser runtime method used'
  },
  {
    id: 'agent-orchestration-setup',
    interaction: 'Agent Orchestration setup enabled or opened'
  },
  {
    id: 'agent-orchestration',
    interaction: 'agent orchestration runtime method used'
  },
  {
    id: 'ai-commit-generation',
    interaction: 'AI commit message generation enabled or used'
  },
  {
    id: 'ai-pr-generation',
    interaction: 'AI pull request generation used'
  },
  {
    id: 'claude-account-switching',
    interaction: 'Claude managed account added, selected, reauthenticated, or removed'
  },
  {
    id: 'computer-use-setup',
    interaction: 'Computer Use setup or permission flow opened'
  },
  {
    id: 'computer-use',
    interaction: 'computer-use runtime method used'
  },
  {
    id: 'codex-account-switching',
    interaction: 'Codex managed account added, selected, reauthenticated, or removed'
  },
  {
    id: 'cookie-import',
    interaction: 'browser cookies imported or cleared'
  },
  {
    id: 'floating-workspace',
    interaction: 'Floating Workspace opened or configured'
  },
  {
    id: 'mobile-pairing',
    interaction: 'mobile pairing enabled or QR code generated'
  },
  {
    id: 'notifications',
    interaction: 'desktop notifications enabled or tested'
  },
  {
    id: 'ports',
    interaction: 'Ports popover opened, configured, or port action used'
  },
  {
    id: 'quick-commands',
    interaction: 'terminal quick command created or edited'
  },
  {
    id: 'resource-manager',
    interaction: 'Resource Manager opened or configured'
  },
  {
    id: 'review-notes',
    interaction: 'review note added or sent to an agent'
  },
  {
    id: 'ssh',
    interaction: 'SSH target added, imported, tested, connected, disconnected, or configured'
  },
  {
    id: 'terminal-pane-split',
    interaction: 'terminal pane split from the split-pane command'
  },
  {
    id: 'terminal-panes',
    interaction: 'terminal/editor/browser pane created, resized, or merged'
  },
  {
    id: 'terminal-tabs',
    interaction: 'workspace tab created, moved, reordered, pinned, renamed, recolored, or closed'
  },
  {
    id: 'tab-splits',
    interaction: 'workspace tab split into another pane'
  },
  {
    id: 'usage-tracking',
    interaction: 'Stats & Usage or provider usage details opened or configured'
  },
  {
    id: 'voice-dictation',
    interaction: 'dictation session started'
  },
  {
    id: 'workspace-cleanup',
    interaction: 'workspace disk space scan, review, or cleanup action used'
  }
] as const satisfies readonly FeatureInteractionDefinition[]

export const FEATURE_INTERACTION_IDS = FEATURE_INTERACTIONS.map((feature) => feature.id)

export function isFeatureInteractionId(value: unknown): value is FeatureInteractionId {
  return (
    typeof value === 'string' && FEATURE_INTERACTION_IDS.includes(value as FeatureInteractionId)
  )
}

export function hasFeatureInteraction(
  state: FeatureInteractionState | null | undefined,
  id: FeatureInteractionId
): boolean {
  return normalizeFeatureInteractionRecord(state?.[id]) !== null
}

export function normalizeFeatureInteractions(value: unknown): FeatureInteractionState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const input = value as Record<string, unknown>
  const out: FeatureInteractionState = {}
  for (const id of FEATURE_INTERACTION_IDS) {
    const record = normalizeFeatureInteractionRecord(input[id])
    if (record) {
      out[id] = record
    }
  }
  return out
}

function normalizeFeatureInteractionRecord(value: unknown): FeatureInteractionRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const input = value as Record<string, unknown>
  const firstInteractedAt = input.firstInteractedAt
  if (
    typeof firstInteractedAt !== 'number' ||
    !Number.isFinite(firstInteractedAt) ||
    firstInteractedAt < 0
  ) {
    return null
  }
  const rawInteractionCount = input.interactionCount
  const interactionCount =
    typeof rawInteractionCount === 'number' &&
    Number.isInteger(rawInteractionCount) &&
    rawInteractionCount > 0
      ? rawInteractionCount
      : 1
  return { firstInteractedAt, interactionCount }
}
