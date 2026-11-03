import { useId, useState } from 'react'
import type { Repo } from '../../../../../shared/repo-types'
import {
  DEFAULT_FORMATTER_INCLUDE,
  editorFormatterSchema
} from '../../../../../shared/editor-formatter'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { Textarea } from '../../ui/textarea'
import { SearchableSetting } from '../SearchableSetting'
import { SettingsSubsectionHeader } from '../SettingsFormControls'

export function getRepositoryFormatterSearchEntry() {
  return {
    title: translate('settings.repositoryFormatter.title', 'Formatter Command'),
    description: translate(
      'settings.repositoryFormatter.description',
      'Use this project’s formatter for Format on Save.'
    ),
    keywords: [
      translate(
        'settings.editorFormatOnSave.keywords',
        'formatter format on save prettier biome gofmt'
      )
    ]
  }
}

export function RepositoryFormatterSection({
  repo,
  updateRepo,
  forceVisible = false
}: {
  repo: Repo
  forceVisible?: boolean
  updateRepo: (repoId: string, updates: Pick<Repo, 'editorFormatter'>) => void | Promise<boolean>
}): React.JSX.Element {
  const commandId = useId()
  const includeId = useId()
  const sourceKey = JSON.stringify(repo.editorFormatter)
  const [source, setSource] = useState(sourceKey)
  const [command, setCommand] = useState(repo.editorFormatter?.command ?? '')
  const [include, setInclude] = useState(
    repo.editorFormatter?.include.join('\n') ?? DEFAULT_FORMATTER_INCLUDE
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  if (source !== sourceKey) {
    setSource(sourceKey)
    setCommand(repo.editorFormatter?.command ?? '')
    setInclude(repo.editorFormatter?.include.join('\n') ?? DEFAULT_FORMATTER_INCLUDE)
  }
  const entry = getRepositoryFormatterSearchEntry()
  const changed =
    command !== (repo.editorFormatter?.command ?? '') ||
    include !== (repo.editorFormatter?.include.join('\n') ?? DEFAULT_FORMATTER_INCLUDE)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const editorFormatter = editorFormatterSchema.parse({
        command: command.trim(),
        include: include
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      })
      const saved = await updateRepo(repo.id, { editorFormatter })
      if (saved === false) {
        setError(
          translate('settings.repositoryFormatter.saveFailed', 'Could not save formatter settings.')
        )
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SearchableSetting {...entry} forceVisible={forceVisible}>
      <section className="space-y-4">
        <SettingsSubsectionHeader title={entry.title} description={entry.description} />
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={commandId}>
              {translate('settings.repositoryFormatter.command', 'Command')}
            </Label>
            <Input
              id={commandId}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={translate(
                'settings.repositoryFormatter.placeholder',
                'npx --no-install prettier --stdin-filepath "${file}"'
              )}
              variant="code"
              disabled={saving}
              aria-invalid={Boolean(error)}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.repositoryFormatter.commandHelp',
                'Runs on the file’s host in the workspace root. Reads the buffer from stdin and must print only formatted text to stdout. Use ${file} or ${relativeFile} for the path. Arguments are passed directly, without a shell. Do not use --write. Leave empty to disable for this project.'
              )}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor={includeId}>
              {translate('settings.repositoryFormatter.include', 'Include globs (one per line)')}
            </Label>
            <Textarea
              id={includeId}
              value={include}
              onChange={(event) => setInclude(event.target.value)}
              variant="code"
              rows={2}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.repositoryFormatter.includeHelp',
                'Match paths relative to the workspace root. No matching glob means no formatting. Enable Format on Save in General > Editor to use this command.'
              )}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="sm" disabled={!changed || saving}>
            {saving
              ? translate('settings.repositoryFormatter.saving', 'Saving…')
              : translate('settings.repositoryFormatter.save', 'Save formatter')}
          </Button>
        </form>
      </section>
    </SearchableSetting>
  )
}
