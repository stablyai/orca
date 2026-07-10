import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

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

function getHostedReviewDefaultRows(): {
  key: HostedReviewDefaultKey
  label: string
  description: string
}[] {
  return [
    {
      key: 'draft',
      label: translate(
        'auto.components.settings.CommitMessageAiPane.6ba48f07a4',
        'Draft by default'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.e001734396',
        'Create hosted reviews as drafts unless changed in the composer.'
      )
    },
    {
      key: 'useTemplate',
      label: translate(
        'auto.components.settings.CommitMessageAiPane.d8b6764d79',
        'Use review template when available'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.6278c0ce43',
        'Prefer repository pull request templates when no description is set.'
      )
    },
    {
      key: 'generateDetailsOnOpen',
      label: translate(
        'auto.components.settings.CommitMessageAiPane.d5f0de6309',
        'Generate details when opening Create PR'
      ),
      description: translate(
        'auto.components.settings.CommitMessageAiPane.b27b0809f3',
        'Run hosted-review detail generation once when the composer opens.'
      )
    },
    {
      key: 'openAfterCreate',
      label: translate(
        'auto.components.settings.CommitMessageAiPane.7662715213',
        'Open hosted review after creation'
      ),
      description: translate(
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
  return (
    <SearchableSetting
      key="pr-creation-defaults"
      title={translate(
        'auto.components.settings.CommitMessageAiPane.2dafc7646e',
        'Hosted-review creation defaults'
      )}
      description={translate(
        'auto.components.settings.CommitMessageAiPane.e9d46a544d',
        'Defaults used when the hosted-review composer opens.'
      )}
      keywords={KEYWORDS}
      className="space-y-3 px-1 py-2"
    >
      <div className="space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.CommitMessageAiPane.2dafc7646e',
            'Hosted-review creation defaults'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CommitMessageAiPane.347094560b',
            'Used by repositories that inherit global hosted-review defaults.'
          )}
        </p>
      </div>
      <div className="space-y-2">
        {getHostedReviewDefaultRows().map((row) => (
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
