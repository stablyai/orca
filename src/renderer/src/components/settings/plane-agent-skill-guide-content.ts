import { GitBranch, Globe, EyeOff, Slash, type LucideIcon } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export type PlaneGuideNote = {
  id: string
  icon: LucideIcon
  title: string
  body: string
}

export function getPlaneGuideNotes(): PlaneGuideNote[] {
  return [
    {
      id: 'linked-worktree',
      icon: GitBranch,
      title: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteLinkedTitle',
        'Start from a Plane issue'
      ),
      body: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteLinkedBody',
        'Issue actions work best in a worktree created from Tasks so the issue stays linked as context.'
      )
    },
    {
      id: 'slash-command',
      icon: Slash,
      title: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteSlashTitle',
        'Mention /orca-plane'
      ),
      body: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteSlashBody',
        'In chat, use /orca-plane (or ask in plain language) so the agent loads the skill for that turn.'
      )
    },
    {
      id: 'cloud-self-hosted',
      icon: Globe,
      title: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteInstanceTitle',
        'Cloud and Self-Hosted'
      ),
      body: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteInstanceBody',
        'Supports both Plane Cloud (app.plane.so) and custom self-hosted Plane instances.'
      )
    },
    {
      id: 'visibility',
      icon: EyeOff,
      title: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteVisibilityTitle',
        'Hiding ≠ disconnect'
      ),
      body: translate(
        'auto.components.settings.PlaneAgentSkillGuide.noteVisibilityBody',
        'Hiding Plane in Task Sources only removes it from the picker. It does not remove your token or skill.'
      )
    }
  ]
}
