import type {
  LinearProjectRef,
  LinearProjectTargetRequest,
  LinearProjectUpdateHealth,
  LinearProjectUpdateNode
} from './project-agent-access'

export const LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES = ['on-track', 'at-risk', 'off-track'] as const
export type LinearProjectUpdateHealthInput =
  (typeof LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES)[number]

const HEALTH_BY_CLI_VALUE: Record<LinearProjectUpdateHealthInput, LinearProjectUpdateHealth> = {
  'on-track': 'onTrack',
  'at-risk': 'atRisk',
  'off-track': 'offTrack'
}

/** Returns null for anything else, including the camelCase API spellings. */
export function toLinearProjectUpdateHealth(value: string): LinearProjectUpdateHealth | null {
  return HEALTH_BY_CLI_VALUE[value as LinearProjectUpdateHealthInput] ?? null
}

export type LinearProjectUpdateAddRequest = LinearProjectTargetRequest & {
  body: string
  health?: LinearProjectUpdateHealth
  isDiffHidden?: boolean
  writeId?: string
}

export type LinearProjectUpdateAddResult = {
  projectUpdate: Pick<LinearProjectUpdateNode, 'id' | 'url' | 'health' | 'createdAt'>
  project: LinearProjectRef
  meta: {
    workspaceId: string
    bodyChars: number
    writeId: string
    /** True when a pinned write id matched an existing post with the same intent. */
    deduplicated: boolean
  }
}
