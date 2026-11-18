import { getLinearGuideNotes } from './linear-agent-skill-guide-content'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

export function LinearAgentSkillNotes(): React.JSX.Element {
  const t = useTranslate()
  const notes = getLinearGuideNotes(t)

  return (
    <SettingsGroup
      title={t('auto.components.settings.LinearAgentSkillGuide.notesTitle', 'Good to know')}
      description={t(
        'auto.components.settings.LinearAgentSkillGuide.notesIntro',
        'Quick reminders once Linear is connected and the skill is installed.'
      )}
      bodyClassName="py-4"
    >
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {notes.map((note) => {
          const Icon = note.icon
          return (
            <div key={note.id} className="flex gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground">
                <Icon className="size-3.5" />
              </div>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">{note.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{note.body}</p>
              </div>
            </div>
          )
        })}
      </div>
    </SettingsGroup>
  )
}
