import type React from 'react'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { triStateValue } from './repository-source-control-ai-draft'

type HostedReviewDefaultKey = keyof NonNullable<RepoSourceControlAiOverrides['prCreationDefaults']>

type RepositorySourceControlAiHostedReviewDefaultsProps = {
  value: RepoSourceControlAiOverrides['prCreationDefaults']
  source: SourceControlAiSettings
  onChange: (key: HostedReviewDefaultKey, value: string) => void
}

const HOSTED_REVIEW_DEFAULT_ROWS: { key: HostedReviewDefaultKey; label: string }[] = [
  { key: 'draft', label: 'Draft by default' },
  { key: 'useTemplate', label: 'Use review template when available' },
  { key: 'generateDetailsOnOpen', label: 'Generate details when opening Create PR' },
  { key: 'openAfterCreate', label: 'Open hosted review after creation' }
]

export function RepositorySourceControlAiHostedReviewDefaults({
  value,
  source,
  onChange
}: RepositorySourceControlAiHostedReviewDefaultsProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium">Hosted-review creation defaults</Label>
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
                  Global default is {inherited}.
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
                  <SelectItem value="inherit">Use global</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )
        })}
      </div>
    </div>
  )
}
