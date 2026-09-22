import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { SkillDisclosureTrigger } from './SkillDisclosureTrigger'

/**
 * Collapsed on a first publish, where "what changed" has no answer yet, and open
 * for a new version, where the notes are the reason to read the dialog.
 */
export function SkillShareReleaseNotesField({
  value,
  newVersion,
  onChange,
  onSubmit
}: {
  value: string
  newVersion: boolean
  onChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  return (
    <Collapsible defaultOpen={newVersion} className="space-y-2">
      <SkillDisclosureTrigger
        label={
          newVersion
            ? translate('auto.components.skills.share.releaseNotesVersion', 'Release notes')
            : translate(
                'auto.components.skills.share.releaseNotesOptional',
                'Add release notes (optional)'
              )
        }
      />
      <CollapsibleContent className="collapsible-height-content space-y-2">
        <Label htmlFor="skill-release-notes" className="sr-only">
          {translate('auto.components.skills.SkillShareReviewContent.f0c0411549', 'Release notes')}
        </Label>
        <textarea
          id="skill-release-notes"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Why: a textarea owns Enter, so the keyboard needs its own way back
            // to the primary action — but not while an IME is composing, where
            // Enter is still committing the candidate.
            if (event.nativeEvent.isComposing) {
              return
            }
            if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
              event.preventDefault()
              onSubmit()
            }
          }}
          maxLength={10_000}
          placeholder={
            newVersion
              ? translate(
                  'auto.components.skills.SkillShareReviewContent.bf02d6ed9e',
                  'What changed in this version?'
                )
              : translate('auto.components.skills.share.releaseNotesFirst', 'Describe this release')
          }
          className="min-h-20 w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
