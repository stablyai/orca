import { ImeTextarea } from '@/lib/ime-text-field'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { SkillDisclosureTrigger } from './SkillDisclosureTrigger'

/** Open notes for a new version; first publication has no prior version to explain changes against. */
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
  const t = useTranslate()
  const isMac = navigator.userAgent.includes('Mac')
  return (
    <Collapsible defaultOpen={newVersion} className="space-y-2">
      <SkillDisclosureTrigger
        label={
          newVersion
            ? t('auto.components.skills.share.releaseNotesVersion', 'Release notes')
            : t('auto.components.skills.share.releaseNotesOptional', 'Add release notes (optional)')
        }
      />
      <CollapsibleContent className="collapsible-height-content space-y-2">
        <Label htmlFor="skill-release-notes" className="sr-only">
          {t('auto.components.skills.SkillShareReviewContent.f0c0411549', 'Release notes')}
        </Label>
        <ImeTextarea
          id="skill-release-notes"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Provide a shortcut back to Publish without stealing Enter while IME composition commits a candidate.
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
              ? t(
                  'auto.components.skills.SkillShareReviewContent.bf02d6ed9e',
                  'What changed in this version?'
                )
              : t('auto.components.skills.share.releaseNotesFirst', 'Describe this release')
          }
          className="min-h-20 w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
