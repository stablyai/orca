// Step for AddRepoDialog (orca#763), split out so create-project state stays scoped.
import React, { useMemo, useState } from 'react'
import { CornerDownLeft, FolderOpen, Loader2 } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CreateProjectParentBrowser } from './CreateProjectLocationField'
import { translate } from '@/i18n/i18n'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { formatCreateProjectParentSummary, type GitAvailability } from './create-project-defaults'

type CreateStepProps = {
  createName: string
  createParent: string
  createError: string | null
  isCreating: boolean
  defaultParent?: string
  gitAvailability?: GitAvailability
  runtimeParentStatus?: 'idle' | 'checking' | 'failed'
  parentDefaultPending?: boolean
  manualParentEntry?: boolean
  runtimeEnvironmentId?: string | null
  onNameChange: (value: string) => void
  onParentChange: (value: string) => void
  onPickParent: () => void
  onCreate: () => void
}

export function CreateStep({
  createName,
  createParent,
  createError,
  isCreating,
  defaultParent = '',
  gitAvailability = 'unknown',
  runtimeParentStatus = 'idle',
  parentDefaultPending = false,
  manualParentEntry = false,
  runtimeEnvironmentId,
  onNameChange,
  onParentChange,
  onPickParent,
  onCreate
}: CreateStepProps): React.JSX.Element {
  const [browsingParent, setBrowsingParent] = useState(false)

  const canSubmit =
    createName.trim().length > 0 &&
    createParent.trim().length > 0 &&
    gitAvailability !== 'checking' &&
    gitAvailability !== 'unavailable' &&
    !parentDefaultPending &&
    !isCreating
  const missingLocationLabel = translate(
    'auto.components.sidebar.AddRepoCreateStep.3a13f6e88b',
    'location not selected'
  )
  const missingServerLocationLabel = translate(
    'auto.components.sidebar.AddRepoCreateStep.6ed14c0281',
    'server folder not selected'
  )

  const parentSummary = useMemo(
    () =>
      formatCreateProjectParentSummary({
        parent: createParent,
        defaultParent,
        runtimeEnvironmentId,
        missingLocationLabel,
        missingServerLocationLabel
      }),
    [
      createParent,
      defaultParent,
      missingLocationLabel,
      missingServerLocationLabel,
      runtimeEnvironmentId
    ]
  )
  const repoNamePreview = createName.trim()
  const submitShortcutModifierLabel = getScreenSubmitModifierLabel()
  const showGitFallback = gitAvailability === 'unavailable'
  const showGitChecking = gitAvailability === 'checking'
  const showRuntimeMissingParent =
    runtimeEnvironmentId && !createParent.trim() && runtimeParentStatus !== 'checking'

  if (browsingParent && runtimeEnvironmentId) {
    return (
      <CreateProjectParentBrowser
        runtimeEnvironmentId={runtimeEnvironmentId}
        createParent={createParent}
        onParentChange={onParentChange}
        onClose={() => setBrowsingParent(false)}
      />
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.sidebar.AddRepoCreateStep.createProjectTitle',
            'Create project'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRepoCreateStep.createProjectDescription',
            'Create a local Git repo and first workspace.'
          )}
        </DialogDescription>
      </DialogHeader>

      {/* Why: DialogContent is a CSS grid; grid items default to min-width:auto
        (= content size), so a long path inside the Location row would blow out
        the dialog width even with flex + truncate on the row itself. min-w-0
        here caps the grid track at the dialog's max-width. */}
      <div className="min-w-0 space-y-5 pt-1">
        <div className="space-y-2">
          <label
            htmlFor="create-project-name"
            className="block text-sm font-medium text-foreground"
          >
            {translate(
              'auto.components.sidebar.AddRepoCreateStep.projectNameLabel',
              'Project name'
            )}
          </label>
          <Input
            id="create-project-name"
            value={createName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={translate(
              'auto.components.sidebar.AddRepoCreateStep.0ae45b8238',
              'my-project'
            )}
            className="h-11 text-sm"
            disabled={isCreating}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
          {repoNamePreview ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.sidebar.AddRepoCreateStep.createsGitRepoHelp',
                'Git repo:'
              )}{' '}
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{repoNamePreview}</span>
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="create-project-parent"
            className="block text-sm font-medium text-foreground"
          >
            {translate(
              'auto.components.sidebar.AddRepoCreateStep.parentFolderLabel',
              'Parent folder'
            )}
          </label>
          <div className="flex min-w-0 gap-2">
            <Input
              id="create-project-parent"
              value={createParent}
              onChange={(e) => onParentChange(e.target.value)}
              placeholder={translate(
                'auto.components.sidebar.CreateProjectLocationField.2a20a603a3',
                '/home/user/projects'
              )}
              className="h-11 min-w-0 flex-1 font-mono text-sm"
              disabled={isCreating}
              spellCheck={false}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (runtimeEnvironmentId) {
                  setBrowsingParent(true)
                } else {
                  onPickParent()
                }
              }}
              disabled={isCreating || (manualParentEntry && !runtimeEnvironmentId)}
              size="sm"
              className="h-11 shrink-0 gap-1.5 px-3"
            >
              <FolderOpen className="size-3.5" />
              {translate('auto.components.sidebar.AddRepoCreateStep.browseParentFolder', 'Browse')}
            </Button>
          </div>
          {showGitChecking ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {translate(
                'auto.components.sidebar.AddRepoCreateStep.2a762f3b19',
                'Checking Git on this host...'
              )}
            </p>
          ) : showGitFallback ? (
            <p className="text-sm text-destructive" role="alert">
              {translate(
                'auto.components.sidebar.AddRepoCreateStep.gitRequiredError',
                'Git is required to create a project.'
              )}
            </p>
          ) : showRuntimeMissingParent ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.sidebar.AddRepoCreateStep.c234df77f7',
                'Choose or enter a server parent folder before creating.'
              )}
            </p>
          ) : (
            <p className="truncate text-sm text-muted-foreground" title={parentSummary}>
              {parentSummary}
            </p>
          )}
        </div>

        {createError && (
          <p className="mt-6 text-sm text-destructive" role="alert">
            {createError}
          </p>
        )}

        <div className="flex justify-end pt-2">
          <Button onClick={onCreate} disabled={!canSubmit} size="lg">
            {isCreating
              ? translate('auto.components.sidebar.AddRepoCreateStep.85085d74d2', 'Creating…')
              : translate('auto.components.sidebar.AddRepoCreateStep.createAction', 'Create')}
            <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-primary-foreground/25 bg-primary-foreground/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground/75">
              <span>{submitShortcutModifierLabel}</span>
              <CornerDownLeft className="size-3" />
            </span>
          </Button>
        </div>
      </div>
    </>
  )
}
