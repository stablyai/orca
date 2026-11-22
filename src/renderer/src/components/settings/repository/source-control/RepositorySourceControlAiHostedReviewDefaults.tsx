import type React from 'react'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { triStateValue } from './repository-source-control-ai-draft'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type HostedReviewDefaultKey = keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>

type RepositorySourceControlAiHostedReviewDefaultsProps = {
  value: RepoSourceControlAiOverrides['prCreationDefaults']
  source: SourceControlAiSettings
  onChange: (key: HostedReviewDefaultKey, value: string) => void
}

const getHostedReviewDefaultRows = (
  t: Translate
): { key: HostedReviewDefaultKey; label: string }[] => [
  {
    key: 'draft',
    label: t(
      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.981eae7e14',
      'Draft by default'
    )
  },
  {
    key: 'useTemplate',
    label: t(
      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.d32b87e754',
      'Use review template when available'
    )
  },
  {
    key: 'generateDetailsOnOpen',
    label: t(
      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.14f1eb99d0',
      'Generate details when opening Create PR'
    )
  },
  {
    key: 'openAfterCreate',
    label: t(
      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.629ed8a9d3',
      'Open hosted review after creation'
    )
  }
]

export function RepositorySourceControlAiHostedReviewDefaults({
  value,
  source,
  onChange
}: RepositorySourceControlAiHostedReviewDefaultsProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-settings-row="" className="space-y-2 py-3">
      <Label className="text-xs font-medium">
        {t(
          'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.aa6ee4b7d6',
          'Hosted-review creation defaults'
        )}
      </Label>
      <div className="space-y-2">
        {getHostedReviewDefaultRows(t).map((row) => {
          const inherited =
            source.prCreationDefaults?.[row.key] === true
              ? t(
                  'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.777443bf89',
                  'On'
                )
              : t(
                  'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.053ccfbf52',
                  'Off'
                )
          return (
            <div
              key={row.key}
              className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2"
            >
              <span className="min-w-0 space-y-0.5">
                <span className="block text-xs text-foreground">{row.label}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {t(
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
                    {t(
                      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.ffc3b26b26',
                      'Use global'
                    )}
                  </SelectItem>
                  <SelectItem value="on">
                    {t(
                      'auto.components.settings.RepositorySourceControlAiHostedReviewDefaults.777443bf89',
                      'On'
                    )}
                  </SelectItem>
                  <SelectItem value="off">
                    {t(
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
