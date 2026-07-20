import type React from 'react'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { triStateValue } from './repository-source-control-ai-draft'
import { translate } from '@/i18n/i18n'

type HostedReviewDefaultKey = keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>

type RepositorySourceControlAiHostedReviewDefaultsProps = {
  value: RepoSourceControlAiOverrides['prCreationDefaults']
  source: SourceControlAiSettings
  onChange: (key: HostedReviewDefaultKey, value: string) => void
}

const HOSTED_REVIEW_DEFAULT_ROWS: { key: HostedReviewDefaultKey; label: string }[] = [
  {
    key: 'draft',
    get label() {
      return translate(
        'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.981eae7e14',
        'Draft by default'
      )
    }
  },
  {
    key: 'useTemplate',
    get label() {
      return translate(
        'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.d32b87e754',
        'Use review template when available'
      )
    }
  },
  {
    key: 'generateDetailsOnOpen',
    get label() {
      return translate(
        'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.14f1eb99d0',
        'Generate details when opening Create PR'
      )
    }
  },
  {
    key: 'openAfterCreate',
    get label() {
      return translate(
        'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.629ed8a9d3',
        'Open hosted review after creation'
      )
    }
  }
]

export function RepositorySourceControlAiHostedReviewDefaults({
  value,
  source,
  onChange
}: RepositorySourceControlAiHostedReviewDefaultsProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">
        {translate(
          'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.aa6ee4b7d6',
          'Hosted-review creation defaults'
        )}
      </Label>
      <div className="space-y-2">
        {HOSTED_REVIEW_DEFAULT_ROWS.map((row) => {
          const inherited = source.prCreationDefaults?.[row.key] === true ? 'On' : 'Off'
          return (
            <div
              key={row.key}
              className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2"
            >
              <span className="min-w-0 space-y-0.5">
                <span className="block text-xs text-foreground">{row.label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.a68849a859',
                    'Global default is'
                  )}{' '}
                  {inherited}.
                </span>
              </span>
              <Select
                value={triStateValue(value?.[row.key])}
                onValueChange={(nextValue) => onChange(row.key, nextValue)}
              >
                <SelectTrigger size="sm" className="h-8 w-[120px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {translate(
                      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.ffc3b26b26',
                      'Use global'
                    )}
                  </SelectItem>
                  <SelectItem value="on">
                    {translate(
                      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.777443bf89',
                      'On'
                    )}
                  </SelectItem>
                  <SelectItem value="off">
                    {translate(
                      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.053ccfbf52',
                      'Off'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
