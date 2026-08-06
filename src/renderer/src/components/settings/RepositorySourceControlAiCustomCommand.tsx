import type React from 'react'
import { useState } from 'react'
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
  // onChange drafts the value locally (per keystroke); onCommit persists it (on blur / mode change).
  onChange: (value: string | undefined) => void
  onCommit: (value: string | undefined) => void
}

function isRepoCommand(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function RepositorySourceControlAiCustomCommand({
  value,
  source,
  onChange,
  onCommit
}: RepositorySourceControlAiCustomCommandProps): React.JSX.Element {
  // Why: selecting "Repository command" with an empty global/repo value would otherwise snap the
  // Select back to inherit (empty is not a repo command). Keep a local intent so the user can type.
  const [forceRepoMode, setForceRepoMode] = useState(false)
  const hasRepoCommand = isRepoCommand(value)
  const mode =
    hasRepoCommand || forceRepoMode ? CUSTOM_COMMAND_MODE_REPO : CUSTOM_COMMAND_MODE_INHERIT
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <Label className="text-xs font-medium">
            {translate(
              'auto.components.settings.RepositorySourceControlAiCustomCommand.ebffc5a28c',
              'Custom command'
            )}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.RepositorySourceControlAiCustomCommand.fbb77e122a',
              'Repo fallback for text actions that select Custom command.'
            )}
          </p>
        </div>
        <Select
          value={mode}
          onValueChange={(nextMode) => {
            if (nextMode === CUSTOM_COMMAND_MODE_REPO) {
              // Why: pre-populate from the current draft or the global command when available; when
              // both are empty, stay in local REPO mode so the Select does not snap back to inherit.
              const nextValue = value ?? source.customAgentCommand
              if (isRepoCommand(nextValue)) {
                setForceRepoMode(false)
                onChange(nextValue)
                onCommit(nextValue)
                return
              }
              setForceRepoMode(true)
              onChange(nextValue === '' ? undefined : nextValue)
              return
            }
            setForceRepoMode(false)
            onChange(undefined)
            onCommit(undefined)
          }}
        >
          <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CUSTOM_COMMAND_MODE_INHERIT}>
              {translate(
                'auto.components.settings.RepositorySourceControlAiCustomCommand.e56668c291',
                'Use global'
              )}
            </SelectItem>
            <SelectItem value={CUSTOM_COMMAND_MODE_REPO}>
              {translate(
                'auto.components.settings.RepositorySourceControlAiCustomCommand.0704dd55cd',
                'Repository command'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Input
        value={value ?? ''}
        onChange={(event) => {
          const nextValue = event.target.value
          // Why: an empty field while typing keeps local REPO intent so the Select doesn't snap to
          // inherit mid-edit; blur is what commits the clear. A non-empty value exits the intent.
          setForceRepoMode(!isRepoCommand(nextValue))
          onChange(nextValue === '' ? undefined : nextValue)
        }}
        onBlur={(event) => {
          const nextValue = event.target.value
          // Why: blur with an empty field exits local REPO intent and commits inherit (clear).
          if (!isRepoCommand(nextValue)) {
            setForceRepoMode(false)
          }
          onCommit(nextValue === '' ? undefined : nextValue)
        }}
        placeholder={
          source.customAgentCommand ||
          translate(
            'auto.components.settings.RepositorySourceControlAiCustomCommand.f9941f0caf',
            'e.g. ollama run llama3.1 {prompt}'
          )
        }
        spellCheck={false}
        className="h-8 font-mono text-xs"
      />
    </div>
  )
}
