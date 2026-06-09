import type React from 'react'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  CUSTOM_COMMAND_MODE_INHERIT,
  CUSTOM_COMMAND_MODE_REPO
} from './repository-source-control-ai-labels'
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiCustomCommandProps = {
  value: string | undefined
  source: SourceControlAiSettings
  onChange: (value: string | undefined) => void
}

export function RepositorySourceControlAiCustomCommand({
  value,
  source,
  onChange
}: RepositorySourceControlAiCustomCommandProps): React.JSX.Element {
  // Why: value only counts as a repo command when it is a non-empty trimmed string;
  // empty/nullish values make hasRepoCommand select CUSTOM_COMMAND_MODE_INHERIT
  // instead of CUSTOM_COMMAND_MODE_REPO, so clearing the input switches mode.
  const hasRepoCommand = typeof value === 'string' && value.trim().length > 0
  const mode = hasRepoCommand ? CUSTOM_COMMAND_MODE_REPO : CUSTOM_COMMAND_MODE_INHERIT
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">{translate("auto.components.settings.RepositorySourceControlAiCustomCommand.ebffc5a28c", "Custom command")}</Label>
          <p className="text-[11px] text-muted-foreground">
            {translate("auto.components.settings.RepositorySourceControlAiCustomCommand.fbb77e122a", "Repo fallback for text actions that select Custom command.")}</p>
        </div>
        <Select
          value={mode}
          onValueChange={(nextMode) => {
            // Why: CUSTOM_COMMAND_MODE_REPO pre-populates onChange from
            // source.customAgentCommand when this repo has no command yet; other modes clear.
            onChange(
              nextMode === CUSTOM_COMMAND_MODE_REPO
                ? (value ?? source.customAgentCommand)
                : undefined
            )
          }}
        >
          <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CUSTOM_COMMAND_MODE_INHERIT}>{translate("auto.components.settings.RepositorySourceControlAiCustomCommand.e56668c291", "Use global")}</SelectItem>
            <SelectItem value={CUSTOM_COMMAND_MODE_REPO}>{translate("auto.components.settings.RepositorySourceControlAiCustomCommand.0704dd55cd", "Repository command")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Input
        value={value ?? ''}
        onChange={(event) => {
          const nextValue = event.target.value
          onChange(nextValue === '' ? undefined : nextValue)
        }}
        placeholder={source.customAgentCommand || translate("auto.components.settings.RepositorySourceControlAiCustomCommand.f9941f0caf", "e.g. ollama run llama3.1 {prompt}")}
        spellCheck={false}
        className="h-8 font-mono text-xs"
      />
    </div>
  )
}
