import { GitBranch, KeyRound, EyeOff, Slash, type LucideIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type LinearGuideNote = {
  id: string
  icon: LucideIcon
  title: string
  body: string
}

export function getLinearGuideNotes(): LinearGuideNote[] {
  return [
    {
      id: 'linked-worktree',
      icon: GitBranch,
      title: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteLinkedTitle',
        'Start from a Linear issue'
      ),
      body: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteLinkedBody',
        'Ticket actions work best in a worktree created from Tasks so the issue stays linked as context.'
      )
    },
    {
      id: 'slash-command',
      icon: Slash,
      title: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteSlashTitle',
        'Mention /orca-linear'
      ),
      body: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteSlashBody',
        'In chat, use /orca-linear (or ask in plain language) so the agent loads the skill for that turn.'
      )
    },
    {
      id: 'keys',
      icon: KeyRound,
      title: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteKeysTitle',
        'Keys follow the runtime'
      ),
      body: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteKeysBody',
        'API keys and workspaces are stored for the active runtime.'
      )
    },
    {
      id: 'visibility',
      icon: EyeOff,
      title: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteVisibilityTitle',
        'Hiding ≠ disconnect'
      ),
      body: translate(
        'auto.components.settings.LinearAgentSkillGuide.noteVisibilityBody',
        'Hiding Linear in Task Sources only removes it from the picker. It does not remove your key or skill.'
      )
    }
  ]
}
