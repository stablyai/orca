import type { SourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type HostedReviewDefaultKey = keyof NonNullable<SourceControlAiSettings['prCreationDefaults']>

const KEYWORDS = [
  'hosted review',
  'pull request',
  'merge request',
  'pr',
  'draft',
  'template',
  'generate',
  'open'
]

function getHostedReviewDefaultRows(t: Translate = translate): {
  key: HostedReviewDefaultKey
  label: string
  description: string
}[] {
  return [
    {
      key: 'draft',
      label: t('auto.components.settings.CommitMessageAiPane.6ba48f07a4', 'Draft by default'),
      description: t(
        'auto.components.settings.CommitMessageAiPane.e001734396',
        'Create hosted reviews as drafts unless changed in the composer.'
      )
    },
    {
      key: 'useTemplate',
      label: t(
        'auto.components.settings.CommitMessageAiPane.d8b6764d79',
        'Use review template when available'
      ),
      description: t(
        'auto.components.settings.CommitMessageAiPane.6278c0ce43',
        'Prefer repository pull request templates when no description is set.'
      )
    },
    {
      key: 'generateDetailsOnOpen',
      label: t(
        'auto.components.settings.CommitMessageAiPane.d5f0de6309',
        'Generate details when opening Create PR'
      ),
      description: t(
        'auto.components.settings.CommitMessageAiPane.b27b0809f3',
        'Run hosted-review detail generation once when the composer opens.'
      )
    },
    {
      key: 'openAfterCreate',
      label: t(
        'auto.components.settings.CommitMessageAiPane.7662715213',
        'Open hosted review after creation'
      ),
      description: t(
        'auto.components.settings.CommitMessageAiPane.b125eabffa',
        'Open the created hosted review in your browser after submit.'
      )
    }
  ]
}

export function HostedReviewCreationDefaults({
  prDefaults,
  onPrDefaultChange
}: {
  prDefaults: NonNullable<SourceControlAiSettings['prCreationDefaults']>
  onPrDefaultChange: (key: HostedReviewDefaultKey, value: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      key="pr-creation-defaults"
      title={t(
        'auto.components.settings.CommitMessageAiPane.2dafc7646e',
        'Hosted-review creation defaults'
      )}
      description={t(
        'auto.components.settings.CommitMessageAiPane.e9d46a544d',
        'Defaults used when the hosted-review composer opens.'
      )}
      keywords={KEYWORDS}
      className="space-y-3 py-3"
    >
      <div className="space-y-0.5">
        <Label>
          {t(
            'auto.components.settings.CommitMessageAiPane.2dafc7646e',
            'Hosted-review creation defaults'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.CommitMessageAiPane.347094560b',
            'Used by repositories that inherit global hosted-review defaults.'
          )}
        </p>
      </div>
      <div className="space-y-2">
        {getHostedReviewDefaultRows(t).map((row) => (
          <label
            key={row.key}
            className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2"
          >
            <span className="space-y-0.5">
              <span className="block text-xs font-medium text-foreground">{row.label}</span>
              <span className="block text-[11px] text-muted-foreground">{row.description}</span>
            </span>
            <input
              type="checkbox"
              checked={prDefaults[row.key] === true}
              onChange={(event) => onPrDefaultChange(row.key, event.target.checked)}
              className="mt-0.5 size-4 rounded border-border accent-primary"
            />
          </label>
        ))}
      </div>
    </SearchableSetting>
  )
}
