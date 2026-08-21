import { getLinearGuideNotes } from './linear-agent-skill-guide-content'
import { translate } from '@/i18n/i18n'

// Keep setup and examples primary, with reminders at the bottom.
export function LinearAgentSkillNotes(): React.JSX.Element {
  const notes = getLinearGuideNotes()

  return (
    <section className="space-y-3 border-t border-border/60 pt-6">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          {translate('auto.components.settings.LinearAgentSkillGuide.notesTitle', 'Good to know')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.LinearAgentSkillGuide.notesIntro',
            'Quick reminders once Linear is connected and the skill is installed.'
          )}
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {notes.map((note) => {
          const Icon = note.icon
          return (
            <div
              key={note.id}
              className="flex gap-3 rounded-xl border border-border/50 bg-muted/10 px-3.5 py-3"
            >
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
    </section>
  )
}
