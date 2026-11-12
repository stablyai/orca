import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  AGENT_CONFIG_MEMORY_NAME,
  agentOfKind,
  type AgentConfigSyncRow
} from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'

// Glossary: the agent is "Claude" in UI copy, never "Claude Code".
export const AGENT_LABEL = { claude: 'Claude', codex: 'Codex' } as const

/** What the user types or sees: `/frontend:review`, `/prompts:x` in Codex, CLAUDE.md for memory. */
export function cloudSkillsDisplayName(row: Pick<AgentConfigSyncRow, 'kind' | 'name'>): string {
  if (row.kind === 'claude-command') {
    return `/${row.name.split('/').join(':')}`
  }
  if (row.kind === 'codex-prompt') {
    return `/prompts:${row.name}`
  }
  if (AGENT_CONFIG_MEMORY_NAME[row.kind]) {
    return `${row.name}.md`
  }
  if (row.kind === 'claude-settings') {
    return 'settings.json'
  }
  return row.name
}

function baseKindLabel(row: AgentConfigSyncRow, t: Translate): string {
  const agent = AGENT_LABEL[agentOfKind(row.kind)]
  switch (row.kind) {
    case 'codex-prompt':
      return t('cloudSkillsSync.kind.prompt', 'Codex prompt')
    case 'claude-agent':
      return t('cloudSkillsSync.kind.agent', 'Claude subagent')
    case 'claude-output-style':
      return t('cloudSkillsSync.kind.outputStyle', 'Claude output style')
    case 'claude-memory':
    case 'codex-memory':
      return t('cloudSkillsSync.kind.memory', '{{agent}} memory', { agent })
    case 'claude-settings':
      return t('cloudSkillsSync.kind.settings', 'Claude settings')
    case 'claude-command':
      return t('cloudSkillsSync.kind.command', '{{agent}} command', { agent })
    case 'claude-skill':
    case 'agents-skill':
    case 'codex-skill':
      return t('cloudSkillsSync.kind.skill', '{{agent}} skill', { agent })
  }
}

export function cloudSkillsKindLabel(row: AgentConfigSyncRow, t: Translate = translate): string {
  const kind = baseKindLabel(row, t)
  return row.scope === 'project'
    ? t('cloudSkillsSync.kind.project', '{{kind}}, this project', { kind })
    : kind
}

/** settings.json says what it carries, and what it left behind. */
export function cloudSkillsSettingsNote(row: AgentConfigSyncRow, t: Translate = translate): string {
  return row.localRefs
    ? t(
        'cloudSkillsSync.row.settingsLocalRefs',
        'Permissions, model and output style only. {{count}} rules mention paths on this computer and stay here. Changes made in a workspace stay there.',
        {
          count: row.localRefs,
          defaultValue_one:
            'Permissions, model and output style only. 1 rule mentions a path on this computer and stays here. Changes made in a workspace stay there.'
        }
      )
    : t(
        'cloudSkillsSync.row.settingsScope',
        'Permissions, model and output style only. Env, hooks and helper commands never sync. Changes made in a workspace stay there.'
      )
}
