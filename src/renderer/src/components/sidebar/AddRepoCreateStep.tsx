// Step for AddRepoDialog (orca#763), split out so create-project state stays scoped.
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, Folder, GitBranch, Loader2 } from 'lucide-react'
import { DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  CreateProjectLocationField,
  CreateProjectParentBrowser
} from './CreateProjectLocationField'
import { translate } from '@/i18n/i18n'
import {
  formatCreateProjectParentSummary,
  joinCreateProjectPath,
  type GitAvailability,
  type RepoKind
} from './create-project-defaults'

// ── UI helpers ───────────────────────────────────────────────────────

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
  onNameChange,
  onParentChange,
  onKindChange,
  onPickParent,
  onCreate
}: CreateStepProps): React.JSX.Element {
  const radioGroupRef = useRef<HTMLDivElement>(null)
  const radioFocusFrameRef = useRef<number | null>(null)
  const [browsingParent, setBrowsingParent] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const cancelRadioFocusFrame = useCallback((): void => {
    if (radioFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(radioFocusFrameRef.current)
    radioFocusFrameRef.current = null
  }, [])

  const setRadioGroupNode = useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: the queued arrow-key focus is only valid while this radiogroup is mounted.
      if (!node) {
        cancelRadioFocusFrame()
      }
      radioGroupRef.current = node
    },
    [cancelRadioFocusFrame]
  )

  // Arrow keys cycle selection within the radiogroup (WAI-ARIA radio pattern).
  const cycleKind = useCallback(() => {
    const next = createKind === 'git' ? 'folder' : 'git'
    onKindChange(next)
    cancelRadioFocusFrame()
    radioFocusFrameRef.current = requestAnimationFrame(() => {
      radioFocusFrameRef.current = null
      const nextEl = radioGroupRef.current?.querySelector<HTMLButtonElement>(
        `[data-kind="${next}"]`
      )
      nextEl?.focus()
    })
  }, [cancelRadioFocusFrame, createKind, onKindChange])

  const canSubmit =
    createName.trim().length > 0 &&
    createParent.trim().length > 0 &&
    gitAvailability !== 'checking' &&
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

  const summaryParent = useMemo(
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
  const targetPathPreview = useMemo(() => {
    const name = createName.trim() || CREATE_PROJECT_NAME_PLACEHOLDER
    return createParent.trim() ? joinCreateProjectPath(createParent, name) : ''
  }, [createName, createParent])
  const kindLabel =
    createKind === 'git'
      ? translate('auto.components.sidebar.AddRepoCreateStep.11fd2a7db8', 'Git repository')
      : translate('auto.components.sidebar.AddRepoCreateStep.038729c107', 'Folder')
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
            'auto.components.sidebar.AddRepoCreateStep.c7b9f94456',
            'Create a new project'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRepoCreateStep.b100311784',
            'Name it and Orca will create a real project with sensible defaults.'
          )}
        </DialogDescription>
      </DialogHeader>

      {/* Why: DialogContent is a CSS grid; grid items default to min-width:auto
        (= content size), so a long path inside the Location row would blow out
        the dialog width even with flex + truncate on the row itself. min-w-0
        here caps the grid track at the dialog's max-width. */}
      <div className="space-y-3.5 pt-1 min-w-0">
        {/* Name. Monospaced because it ends up as a directory name. */}
        <div className="space-y-1">
          <label
            htmlFor="create-project-name"
            className="text-[11px] font-medium text-muted-foreground block"
          >
            {translate('auto.components.sidebar.AddRepoCreateStep.a8149a3a5a', 'Name')}
          </label>
          <Input
            id="create-project-name"
            value={createName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={translate(
              'auto.components.sidebar.AddRepoCreateStep.0ae45b8238',
              'my-project'
            )}
            className="h-11 text-sm font-mono"
            disabled={isCreating}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Summary card doubles as the disclosure for the uncommon settings, so the
          defaults and the controls to change them live in one place. */}
        <div className="min-w-0 rounded-md border border-border bg-muted/30">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-background/60 text-muted-foreground">
              {createKind === 'git' ? (
                <GitBranch className="size-3.5" />
              ) : (
                <Folder className="size-3.5" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {translate(
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
                  {translate(
                    'auto.components.sidebar.AddRepoCreateStep.2a762f3b19',
                    'Checking Git on this host...'
                  )}
                </p>
              ) : showGitFallback ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.AddRepoCreateStep.fe1e616c5b',
                    "Git isn't installed, so a plain folder is the default."
                  )}
                </p>
              ) : showRuntimeMissingParent ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.AddRepoCreateStep.c234df77f7',
                    'Choose or enter a server parent folder before creating.'
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
              {/* Real radiogroup so screen readers announce the segmented choice. */}
              <div className="space-y-1.5">
                <span className="text-[11px] font-medium text-muted-foreground block">
                  {translate(
                    'auto.components.sidebar.AddRepoCreateStep.180e9b5e48',
                    'Project kind'
                  )}
                </span>
                <div
                  ref={setRadioGroupNode}
                  role="radiogroup"
                  aria-label={translate(
                    'auto.components.sidebar.AddRepoCreateStep.180e9b5e48',
                    'Project kind'
                  )}
                  className="grid grid-cols-2 rounded-md border border-border bg-muted/30 p-0.5"
                >
                  {(['git', 'folder'] as const).map((kind) => {
                    const selected = createKind === kind
                    const label =
                      kind === 'git'
                        ? translate(
                            'auto.components.sidebar.AddRepoCreateStep.11fd2a7db8',
                            'Git repository'
                          )
                        : translate(
                            'auto.components.sidebar.AddRepoCreateStep.038729c107',
                            'Folder'
                          )
                    const Icon = kind === 'git' ? GitBranch : Folder
                    return (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => onKindChange(kind)}
                        onKeyDown={(e) => {
                          // Why: keep keyboard radio navigation intact inside the compact segmented control.
                          if (
                            e.key === 'ArrowLeft' ||
                            e.key === 'ArrowRight' ||
                            e.key === 'ArrowUp' ||
                            e.key === 'ArrowDown'
                          ) {
                            e.preventDefault()
                            cycleKind()
                          } else if (e.key === ' ' || e.key === 'Enter') {
                            e.preventDefault()
                            onKindChange(kind)
                          }
                        }}
                        disabled={isCreating}
                        data-kind={kind}
                        className={cn(
                          'inline-flex min-w-0 items-center justify-center gap-1.5 rounded-sm border px-2.5 py-2 text-xs font-medium outline-none transition-colors',
                          // Why: the segment sits on a muted card, so bg-background alone
                          // is too subtle; the border makes the selected state legible.
                          selected
                            ? 'border-border bg-background text-foreground shadow-xs'
                            : 'border-transparent text-muted-foreground hover:text-foreground',
                          'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60'
                        )}
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                    )
                  })}
                </div>
                {showGitFallback && (
                  <p className="text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.sidebar.AddRepoCreateStep.fe1e616c5b',
                      "Git isn't installed, so a plain folder is the default."
                    )}
                  </p>
                )}
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

        {createError && (
          <p className="text-[11px] text-destructive" role="alert">
            {createError}
          </p>
        )}

        <Button onClick={onCreate} disabled={!canSubmit} size="lg" className="w-full">
          {isCreating
            ? translate('auto.components.sidebar.AddRepoCreateStep.85085d74d2', 'Creating…')
            : translate('auto.components.sidebar.AddRepoCreateStep.45b7c26034', 'Create project')}
        </Button>
      </div>
    </>
  )
}
