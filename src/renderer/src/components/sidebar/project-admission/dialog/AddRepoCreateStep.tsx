import React, { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Folder, GitBranch, Loader2 } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/class-names'
import {
  CreateProjectLocationField,
  CreateProjectParentBrowser
} from '../create/CreateProjectLocationField'
import { useTranslate } from '@/i18n/use-translate'
import {
  formatCreateProjectParentSummary,
  joinCreateProjectPath,
  type GitAvailability
} from '../create/create-project-defaults'
import type { RepoKind } from '../../../../../../shared/repo-types'

const CREATE_PROJECT_NAME_PLACEHOLDER = 'project-name'

type CreateStepProps = {
  createName: string
  createParent: string
  createKind: RepoKind
  createError: string | null
  isCreating: boolean
  defaultParent?: string
  gitAvailability?: GitAvailability
  runtimeParentStatus?: 'idle' | 'checking' | 'failed'
  parentDefaultPending?: boolean
  manualParentEntry?: boolean
  runtimeEnvironmentId?: string | null
  /** No host resolved yet (its server is still coming up): never create on this computer. */
  submitDisabled?: boolean
  /** A WSL host's Windows drive refusal for the parent folder. */
  notice?: ReactNode
  onNameChange: (value: string) => void
  onParentChange: (value: string) => void
  onKindChange: (kind: RepoKind) => void
  onPickParent: () => void
  onCreate: () => void
}

export function CreateStep({
  createName,
  createParent,
  createKind,
  createError,
  isCreating,
  defaultParent = '',
  gitAvailability = 'unknown',
  runtimeParentStatus = 'idle',
  parentDefaultPending = false,
  manualParentEntry = false,
  runtimeEnvironmentId,
  submitDisabled = false,
  notice,
  onNameChange,
  onParentChange,
  onKindChange,
  onPickParent,
  onCreate
}: CreateStepProps): React.JSX.Element {
  const t = useTranslate()
  const [browsingParent, setBrowsingParent] = useState(false)
  // Remote hosts need typed paths; expose Location so creation does not appear blocked.
  const [advancedOpen, setAdvancedOpen] = useState(manualParentEntry)

  // Folder projects do not need Git; only a Git create waits for its availability probe.
  const canSubmit =
    createName.trim().length > 0 &&
    createParent.trim().length > 0 &&
    (createKind === 'folder' ||
      (gitAvailability !== 'checking' && gitAvailability !== 'unavailable')) &&
    !parentDefaultPending &&
    !isCreating &&
    !submitDisabled
  const missingLocationLabel = t(
    'auto.components.sidebar.AddRepoCreateStep.3a13f6e88b',
    'location not selected'
  )
  const missingServerLocationLabel = t(
    'auto.components.sidebar.AddRepoCreateStep.6ed14c0281',
    'host folder not selected'
  )
  const isRemoteHost = Boolean(runtimeEnvironmentId)

  const summaryParent = useMemo(
    () =>
      formatCreateProjectParentSummary({
        parent: createParent,
        defaultParent,
        runtimeEnvironmentId,
        isRemoteHost,
        missingLocationLabel,
        missingServerLocationLabel
      }),
    [
      createParent,
      defaultParent,
      isRemoteHost,
      missingLocationLabel,
      missingServerLocationLabel,
      runtimeEnvironmentId
    ]
  )
  const targetPathPreview = useMemo(() => {
    const name = createName.trim() || CREATE_PROJECT_NAME_PLACEHOLDER
    return createParent.trim() ? joinCreateProjectPath(createParent, name) : ''
  }, [createName, createParent])
  const kindLabel =
    createKind === 'git'
      ? t('auto.components.sidebar.AddRepoCreateStep.11fd2a7db8', 'Git repository')
      : t('auto.components.sidebar.AddRepoCreateStep.038729c107', 'Folder')
  const KindIcon = createKind === 'git' ? GitBranch : Folder
  const showGitFallback = createKind === 'git' && gitAvailability === 'unavailable'
  const showGitChecking = createKind === 'git' && gitAvailability === 'checking'
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
          {t('auto.components.sidebar.AddRepoCreateStep.c7b9f94456', 'Create a new project')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.sidebar.AddRepoCreateStep.b100311784',
            'Name it and Orca will create a real project with sensible defaults.'
          )}
        </DialogDescription>
      </DialogHeader>

      {/* Grid children default to min-width:auto; min-w-0 prevents long paths widening the dialog despite row truncation. */}
      <div className="space-y-3.5 pt-1 min-w-0">
        <div className="space-y-1">
          <label
            htmlFor="create-project-name"
            className="text-[11px] font-medium text-muted-foreground block"
          >
            {t('auto.components.sidebar.AddRepoCreateStep.a8149a3a5a', 'Name')}
          </label>
          <Input
            id="create-project-name"
            value={createName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={t('auto.components.sidebar.AddRepoCreateStep.0ae45b8238', 'my-project')}
            className="h-11 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="min-w-0 rounded-md border border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background/60 text-muted-foreground">
              <KindIcon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {t(
                  'auto.components.sidebar.AddRepoCreateStep.685b5eefe1',
                  '{{kind}} in {{parent}}',
                  {
                    kind: kindLabel,
                    parent: summaryParent
                  }
                )}
              </p>
              {showGitChecking ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t(
                    'auto.components.sidebar.AddRepoCreateStep.2a762f3b19',
                    'Checking Git on this host...'
                  )}
                </p>
              ) : showGitFallback ? (
                <p className="mt-0.5 text-[11px] text-destructive">
                  {t(
                    'auto.components.sidebar.AddRepoCreateStep.fe1e616c5b',
                    'Git is required to create a project.'
                  )}
                </p>
              ) : showRuntimeMissingParent ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t(
                    'auto.components.sidebar.AddRepoCreateStep.c234df77f7',
                    'Choose or enter a host parent folder before creating.'
                  )}
                </p>
              ) : targetPathPreview ? (
                <p
                  className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                  title={targetPathPreview}
                >
                  {targetPathPreview}
                </p>
              ) : null}
            </div>
            <ChevronDown
              className={cn(
                'size-4 shrink-0 self-center text-muted-foreground transition-transform',
                advancedOpen && 'rotate-180'
              )}
            />
          </button>

          {advancedOpen && (
            <div className="space-y-3 border-t border-border px-3 py-3">
              <div className="space-y-1.5">
                <span className="block text-2xs font-medium text-muted-foreground">
                  {t('auto.components.sidebar.AddRepoCreateStep.180e9b5e48', 'Project kind')}
                </span>
                <RadioGroup
                  layout="inline"
                  value={createKind}
                  onValueChange={(kind) => {
                    if (kind === 'git' || kind === 'folder') {
                      onKindChange(kind)
                    }
                  }}
                  disabled={isCreating}
                  aria-label={t(
                    'auto.components.sidebar.AddRepoCreateStep.180e9b5e48',
                    'Project kind'
                  )}
                >
                  {(['git', 'folder'] as const).map((kind) => {
                    const label =
                      kind === 'git'
                        ? t(
                            'auto.components.sidebar.AddRepoCreateStep.11fd2a7db8',
                            'Git repository'
                          )
                        : t('auto.components.sidebar.AddRepoCreateStep.038729c107', 'Folder')
                    const Icon = kind === 'git' ? GitBranch : Folder
                    return (
                      <RadioGroupItem key={kind} value={kind} variant="pill">
                        <Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </RadioGroupItem>
                    )
                  })}
                </RadioGroup>
                {showGitFallback ? (
                  <p className="text-2xs text-destructive">
                    {t(
                      'auto.components.sidebar.AddRepoCreateStep.fe1e616c5b',
                      'Git is required to create a project.'
                    )}
                  </p>
                ) : null}
              </div>
              {/* The local picker returns client paths; runtime servers browse host paths via RPC. */}
              <CreateProjectLocationField
                createParent={createParent}
                isCreating={isCreating}
                manualParentEntry={manualParentEntry}
                runtimeEnvironmentId={runtimeEnvironmentId}
                onParentChange={onParentChange}
                onPickParent={onPickParent}
                onBrowseServer={() => setBrowsingParent(true)}
              />

              {targetPathPreview && (
                <p className="min-w-0 break-all rounded-md border border-border bg-background/40 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
                  {targetPathPreview}
                </p>
              )}
            </div>
          )}
        </div>

        {notice}
        {createError && (
          <p className="text-[11px] text-destructive" role="alert">
            {createError}
          </p>
        )}

        <Button onClick={onCreate} disabled={!canSubmit} size="lg" className="w-full">
          {isCreating
            ? t('auto.components.sidebar.AddRepoCreateStep.85085d74d2', 'Creating…')
            : t('auto.components.sidebar.AddRepoCreateStep.45b7c26034', 'Create project')}
        </Button>
      </div>
    </>
  )
}
