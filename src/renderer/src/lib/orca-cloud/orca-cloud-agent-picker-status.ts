// JA-22: the status suffix each agent row shows inside the open agent picker when Run on is Orca
// Cloud. Claude and Codex read the Orca account coverage (the shared selector); the API-key agents
// read whether a Cloud secret they use exists. Names only: no secret value ever reaches here.
import { useMemo } from 'react'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  ORCA_CLOUD_IMAGE_AGENTS,
  isOrcaCloudImageAgent
} from '../../../../shared/hosted-sandbox/orca-cloud-image-agents'
import {
  orcaCloudAgentCoverageFromAccounts,
  type OrcaCloudAgentAccountsRead
} from './orca-cloud-agent-accounts-model'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useOrcaCloudAgentAccounts } from './orca-cloud-agent-accounts-store'

export type OrcaCloudAgentPickerStatus =
  /** A new cloud workspace can run it with nothing more to do. */
  | 'ready'
  /** Not set up yet: the Orca account (Claude, Codex) or a key in Cloud secrets. */
  | 'setUp'
  /** Orca-account sign-in is off or paused here: the agent signs in inside each workspace. */
  | 'perWorkspace'
  /** The Orca Cloud image doesn't ship it. */
  | 'notAvailable'

/**
 * Cloud secrets that make each API-key agent work in a cloud workspace. Copilot and Cursor read
 * their own token; Gemini its Google key; OpenCode any model provider key it supports.
 */
const API_KEY_AGENT_NAMES: Partial<Record<TuiAgent, readonly string[]>> = {
  copilot: ['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'],
  cursor: ['CURSOR_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  opencode: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
    'AI_GATEWAY_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'DEEPSEEK_API_KEY'
  ]
}

/** Null while the account or Cloud secrets aren't read yet, so the row shows no suffix. */
export function orcaCloudAgentPickerStatus(
  agent: TuiAgent,
  accounts: OrcaCloudAgentAccountsRead & { cloudSecretNames?: ReadonlySet<string> | null }
): OrcaCloudAgentPickerStatus | null {
  if (!isOrcaCloudImageAgent(agent)) {
    return 'notAvailable'
  }
  if (agent === 'claude' || agent === 'codex') {
    const coverage = orcaCloudAgentCoverageFromAccounts(agent, accounts)
    switch (coverage?.kind) {
      case undefined:
        return null
      case 'account':
      case 'key':
        return 'ready'
      case 'notSetUp':
      case 'expired':
        return 'setUp'
      case 'killSwitch':
      case 'unavailable':
        return 'perWorkspace'
    }
  }
  const names = accounts.cloudSecretNames ?? null
  if (!names) {
    return null
  }
  return (API_KEY_AGENT_NAMES[agent] ?? []).some((name) => names.has(name)) ? 'ready' : 'setUp'
}

/** The muted suffix; null for 'ready' (no status means ready, design-squad JA-22). */
export function orcaCloudAgentPickerStatusLabel(
  status: OrcaCloudAgentPickerStatus,
  t: Translate
): string | null {
  switch (status) {
    case 'ready':
      return null
    case 'setUp':
      return t('orcaCloudAgentPicker.status.notSetUp', 'Not set up')
    case 'perWorkspace':
      return t('orcaCloudAgentPicker.status.perWorkspace', 'Signs in per workspace')
    case 'notAvailable':
      return t('orcaCloudAgentPicker.status.notAvailable', 'Not available in cloud')
  }
}

/** Status labels for the image agents while Run on is Orca Cloud; undefined otherwise. */
export function useOrcaCloudAgentPickerStatusLabels(
  enabled: boolean
): ReadonlyMap<TuiAgent, string> | undefined {
  const t = useTranslate()
  const accounts = useOrcaCloudAgentAccounts(enabled)
  return useMemo(() => {
    if (!enabled) {
      return undefined
    }
    const labels = new Map<TuiAgent, string>()
    for (const agent of ORCA_CLOUD_IMAGE_AGENTS) {
      const status = orcaCloudAgentPickerStatus(agent, accounts)
      const label = status ? orcaCloudAgentPickerStatusLabel(status, t) : null
      if (label) {
        labels.set(agent, label)
      }
    }
    return labels
  }, [enabled, accounts, t])
}
