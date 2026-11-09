import { useId, useState } from 'react'
import { Download, Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { repoDisplayName } from './cloud-environment-copy'
import type {
  EnvironmentDraft,
  EnvironmentResult,
  RepoSetupImports
} from './cloud-environment-types'
import { draftsEqual, MAX_INSTALL_SCRIPT_CHARS, mergeEnvVarNames } from './environment-draft'
import {
  FieldLabel,
  InstallScriptEditor,
  RepoListEditor,
  type LocalRepoSuggestion
} from './EnvironmentFormFields'
import { EnvVarChipEditor, MachineSizeControl } from './EnvironmentSettingsFields'
import { ImportFromRepoDialog, type ImportReview } from './ImportFromRepoDialog'

export type EnvironmentFormProps = {
  mode: 'create' | 'edit'
  /** The saved state; the form is dirty when its draft differs. Remount (key) on a new revision. */
  base: EnvironmentDraft
  /** Starting draft when it differs from `base` (fixtures, pre-filled create). */
  initialDraft?: EnvironmentDraft
  saving: boolean
  error: string | null
  /** Someone else saved first (stale_revision): offer to reload. */
  conflict: boolean
  /** Who saved the newer revision, when known. */
  conflictEditor?: string | null
  suggestions: readonly LocalRepoSuggestion[]
  /** Local projects "Import from repo" can read. */
  importProjects: readonly LocalRepoSuggestion[]
  onReadImports: (path: string) => Promise<EnvironmentResult<RepoSetupImports>>
  onSave: (draft: EnvironmentDraft) => void
  onReload?: () => void
  onCancel?: () => void
}

export function EnvironmentForm({
  mode,
  base,
  initialDraft,
  saving,
  error,
  conflict,
  conflictEditor,
  suggestions,
  importProjects,
  onReadImports,
  onSave,
  onReload,
  onCancel
}: EnvironmentFormProps): React.JSX.Element {
  const t = useTranslate()
  const scriptId = useId()
  const [draft, setDraft] = useState<EnvironmentDraft>(initialDraft ?? base)
  const [review, setReview] = useState<ImportReview | null>(null)
  const [importing, setImporting] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const dirty = mode === 'create' || !draftsEqual(draft, base)
  const invalid = draft.repos.length === 0 || draft.installScript.length > MAX_INSTALL_SCRIPT_CHARS

  const readImports = async (project: LocalRepoSuggestion): Promise<void> => {
    setImporting(project.repoId)
    setImportError(null)
    const result = await onReadImports(project.path).catch(
      (cause: unknown): EnvironmentResult<RepoSetupImports> => ({
        ok: false,
        error: { code: 'unavailable', message: String(cause) }
      })
    )
    setImporting(null)
    if (result.ok) {
      setReview({ projectName: project.displayName, imports: result.data })
    } else {
      setImportError(result.error.message)
    }
  }

  return (
    <div className="space-y-6">
      {conflict ? (
        <ConflictNotice
          editor={conflictEditor ?? null}
          onReload={onReload}
          onCopyScript={() => void window.api.ui.writeClipboardText(draft.installScript)}
        />
      ) : null}
      <RepoListEditor
        repos={draft.repos}
        suggestions={suggestions}
        onChange={(repos) => setDraft((current) => ({ ...current, repos }))}
      />

      <div className="space-y-2">
        <div className="flex items-end justify-between gap-3">
          <FieldLabel htmlFor={scriptId}>
            {t('cloudEnvironment.form.script', 'Install script')}
          </FieldLabel>
          {importProjects.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="xs" disabled={importing !== null}>
                  {importing ? (
                    <Loader2 className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Download />
                  )}
                  {t('cloudEnvironment.form.import', 'Import from repo')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-72">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  {t(
                    'cloudEnvironment.form.importHint',
                    'Reads Conductor and dev container setup from a local project.'
                  )}
                </DropdownMenuLabel>
                {importProjects.map((project) => (
                  <DropdownMenuItem key={project.repoId} onSelect={() => void readImports(project)}>
                    <span className="truncate">{project.displayName}</span>
                    {project.slug ? (
                      <span className="ml-auto truncate pl-3 font-mono text-[11px] text-muted-foreground">
                        {project.slug}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <InstallScriptEditor
          id={scriptId}
          value={draft.installScript}
          onChange={(installScript) => setDraft((current) => ({ ...current, installScript }))}
        />
        {importError ? (
          <InlineError
            title={t('cloudEnvironment.import.failed', 'Couldn’t read that project’s setup.')}
            detail={importError}
          />
        ) : null}
      </div>

      <EnvVarChipEditor
        names={draft.envVarNames}
        onChange={(envVarNames) => setDraft((current) => ({ ...current, envVarNames }))}
      />

      <MachineSizeControl
        value={draft.machineSize}
        onChange={(machineSize) => setDraft((current) => ({ ...current, machineSize }))}
      />

      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-4">
        <Button
          type="button"
          size="sm"
          disabled={!dirty || invalid || saving || conflict}
          onClick={() => onSave(draft)}
        >
          {saving ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
          {mode === 'create'
            ? t('cloudEnvironment.form.create', 'Create and build')
            : t('cloudEnvironment.form.save', 'Save changes')}
        </Button>
        {mode === 'edit' && dirty ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => setDraft(base)}
          >
            {t('cloudEnvironment.form.discard', 'Discard')}
          </Button>
        ) : null}
        {mode === 'create' && onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t('cloudEnvironment.form.cancel', 'Cancel')}
          </Button>
        ) : null}
        <p className="min-w-0 flex-1 text-xs text-muted-foreground" aria-live="polite">
          {conflict || error ? null : mode === 'edit' && dirty ? (
            <span className="inline-flex items-center gap-1.5 text-status-warning-text">
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              {t(
                'cloudEnvironment.form.unsavedChanges',
                'Unsaved changes. Saving doesn’t rebuild; start a build when you’re ready.'
              )}
            </span>
          ) : draft.repos.length === 0 ? (
            t('cloudEnvironment.form.needRepo', 'Add at least one repository.')
          ) : null}
        </p>
      </div>
      {error && !conflict ? (
        <InlineError
          title={t('cloudEnvironment.form.saveFailed', 'Your changes weren’t saved.')}
          detail={error}
        />
      ) : null}
      <ImportFromRepoDialog
        review={review}
        currentScript={draft.installScript}
        currentEnvVarNames={draft.envVarNames}
        onClose={() => setReview(null)}
        onApply={({ envVarNames, installScript }) => {
          setDraft((current) => ({
            ...current,
            envVarNames: mergeEnvVarNames(current.envVarNames, envVarNames),
            installScript: installScript ?? current.installScript
          }))
          setReview(null)
        }}
      />
    </div>
  )
}

/** What members (no admin role) see: the same facts, nothing editable. */
export function EnvironmentSummary({ base }: { base: EnvironmentDraft }): React.JSX.Element {
  const t = useTranslate()
  const scriptId = useId()
  return (
    <div className="space-y-5">
      <p className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <Lock aria-hidden className="size-3.5 shrink-0" />
        {t(
          'cloudEnvironment.readOnlyAsk',
          'Ask an owner or admin to change the environment or start a build.'
        )}
      </p>
      <div className="space-y-2">
        <FieldLabel>{t('cloudEnvironment.form.repos', 'Repositories')}</FieldLabel>
        <ul className="divide-y divide-border/60 rounded-md border border-border">
          {base.repos.map((repo) => (
            <li key={repo.url} className="flex items-center gap-2 px-3 py-1.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate font-mono">{repoDisplayName(repo.url)}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {repo.defaultBranch ?? t('cloudEnvironment.form.defaultBranch', 'default branch')}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <FieldLabel htmlFor={scriptId}>
          {t('cloudEnvironment.form.script', 'Install script')}
        </FieldLabel>
        <InstallScriptEditor id={scriptId} value={base.installScript} readOnly />
      </div>
      <EnvVarChipEditor names={base.envVarNames} readOnly />
      <div className="space-y-1">
        <FieldLabel>{t('cloudEnvironment.size.label', 'Sandbox size')}</FieldLabel>
        <p className="text-sm">
          {base.machineSize === 'large'
            ? t('cloudEnvironment.size.large', 'Large (8 vCPU · 16 GB)')
            : t('cloudEnvironment.size.standard', 'Standard (4 vCPU · 8 GB)')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('cloudEnvironment.size.rateNote', 'Large uses sandbox hours at 2× the rate.')}
        </p>
      </div>
    </div>
  )
}

/** At the top, because Save is blocked until the user reloads (their draft would overwrite). */
function ConflictNotice({
  editor,
  onReload,
  onCopyScript
}: {
  editor: string | null
  onReload?: () => void
  onCopyScript: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-text"
    >
      <span className="min-w-0 flex-1 basis-64">
        {editor
          ? t(
              'cloudEnvironment.form.conflictNamed',
              '{{editor}} saved changes to this environment while you were editing. Reload to see them; your edits here will be discarded.',
              { editor }
            )
          : t(
              'cloudEnvironment.form.conflict',
              'Someone else saved changes to this environment. Reload to see them; your edits here will be discarded.'
            )}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => {
          onCopyScript()
          setCopied(true)
        }}
      >
        {copied
          ? t('cloudEnvironment.form.scriptCopied', 'Copied')
          : t('cloudEnvironment.form.copyScript', 'Copy my install script')}
      </Button>
      {onReload ? (
        <Button type="button" size="xs" variant="outline" onClick={onReload}>
          {t('cloudEnvironment.form.reload', 'Reload')}
        </Button>
      ) : null}
    </div>
  )
}
