import React, { useCallback, useDeferredValue, useId, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  evaluateClaudeConfigDirAdvice,
  type ClaudeConfigDirProbe
} from './claude-config-dir-advice'
import type { InheritedClaudeConfigDir } from './project-group-claude-config-dir-selection'
import { useClaudeConfigDirProbe } from './use-claude-config-dir-probe'

export type ProjectGroupSettingsDialogProps = {
  open: boolean
  groupName: string
  /** The group's own persisted binding; ancestors show up through `inherited` instead. */
  configDir: string | null
  inherited: InheritedClaudeConfigDir | null
  /** The group's resolved owner host — the one filesystem this path means anything on. */
  executionHostId: ExecutionHostId
  onOpenChange: (open: boolean) => void
  /** Resolves false when the host refused or could not confirm the write. */
  onSubmit: (claudeConfigDir: string | null) => Promise<boolean> | boolean
}

export function ProjectGroupSettingsDialog({
  open,
  groupName,
  configDir,
  inherited,
  executionHostId,
  onOpenChange,
  onSubmit
}: ProjectGroupSettingsDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [draft, setDraft] = useState(configDir ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [previousOpenState, setPreviousOpenState] = useState({ open, configDir })
  // What the field was last seeded with; `draft` still equal to it means the user has typed nothing.
  const [seededDraft, setSeededDraft] = useState(configDir ?? '')
  const [externalConfigDir, setExternalConfigDir] = useState<string | null>(null)
  const mountedRef = useRef(true)

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: a save can finish after the dialog closes; the content ref keeps late completions from
    // mutating stale dialog state without an Effect.
    mountedRef.current = node !== null
  }, [])

  // Why: the field should mount already seeded for the active group; Effect-based hydration shows
  // one frame with the prior draft.
  if (open !== previousOpenState.open || configDir !== previousOpenState.configDir) {
    setPreviousOpenState({ open, configDir })
    if (open) {
      const seed = configDir ?? ''
      // Why guarded: the binding is a live prop, so an edit from another window would otherwise
      // replace text the user is still typing. `seed === draft.trim()` is this dialog's own save
      // arriving in the store, which is not an external change.
      if (seed === draft.trim() || draft === seededDraft) {
        setDraft(seed)
        setSeededDraft(seed)
        setExternalConfigDir(null)
      } else {
        setExternalConfigDir(seed)
        // Why also here: the pristine test compares against the last seeded value, so a kept draft
        // must still advance it or a later external edit reads a stale seed as "untouched".
        setSeededDraft(seed)
      }
      setSubmitting(false)
    }
  }

  const probe: ClaudeConfigDirProbe | null = useClaudeConfigDirProbe({
    enabled: open,
    draft,
    executionHostId
  })
  const advice = evaluateClaudeConfigDirAdvice({ draft, probe })
  const isLocalHost = executionHostId === LOCAL_EXECUTION_HOST_ID
  const trimmedDraft = draft.trim()
  // Stops flagging once the user's own text has caught up with the external value.
  const divergedConfigDir =
    externalConfigDir !== null && externalConfigDir !== trimmedDraft ? externalConfigDir : null
  // Why draft-driven: clearing the field puts the group back under its ancestor, so the hint has to
  // come back the moment the field is empty, not only after the save round-trips.
  const showInherited = !trimmedDraft && inherited !== null

  const submit = useCallback(
    async (nextValue: string | null) => {
      if (submitting) {
        return
      }
      setSubmitting(true)
      try {
        const saved = await onSubmit(nextValue)
        if (!mountedRef.current) {
          return
        }
        // Why keep the dialog open on a refusal: the draft is the only copy of what the user typed.
        if (saved) {
          onOpenChange(false)
        } else {
          setSubmitting(false)
        }
      } catch (error) {
        console.error('Failed to save project group settings:', error)
        if (mountedRef.current) {
          setSubmitting(false)
        }
      }
    },
    [onOpenChange, onSubmit, submitting]
  )

  const handleBrowse = useCallback(async () => {
    const picked = await window.api?.shell?.pickDirectory({
      defaultPath: trimmedDraft || undefined
    })
    if (picked) {
      setDraft(picked)
    }
  }, [trimmedDraft])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={handleDialogContentRef}
        className="max-w-md sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle size="sm">
            {translate(
              'auto.components.sidebar.ProjectGroupSettingsDialog.title',
              'Group Settings'
            )}
          </DialogTitle>
          <DialogDescription size="sm">
            {translate(
              'auto.components.sidebar.ProjectGroupSettingsDialog.description',
              'Settings for {{value0}} and the groups nested inside it.',
              { value0: groupName }
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit(trimmedDraft || null)
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={inputId} size="sm">
              {translate(
                'auto.components.sidebar.ProjectGroupSettingsDialog.fieldLabel',
                'Claude config directory'
              )}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={inputId}
                ref={inputRef}
                type="text"
                value={draft}
                spellCheck={false}
                placeholder={translate(
                  'auto.components.sidebar.ProjectGroupSettingsDialog.fieldPlaceholder',
                  'Claude’s default home'
                )}
                onChange={(event) => setDraft(event.target.value)}
                size="sm"
              />
              {/* The picker can only browse this client, so it is offered for no other host. */}
              {isLocalHost ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm-compact"
                  className="shrink-0"
                  onClick={() => void handleBrowse()}
                >
                  <FolderOpen className="size-3.5" />
                  {translate('auto.components.sidebar.ProjectGroupSettingsDialog.browse', 'Browse')}
                </Button>
              ) : null}
            </div>
          </div>
          <ClaudeConfigDirFieldNote
            adviceMessage={advice?.message ?? null}
            divergedConfigDir={divergedConfigDir}
            inherited={showInherited ? inherited : null}
            remoteHostLabel={isLocalHost ? null : getExecutionHostLabel(executionHostId)}
          />
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm-compact"
              disabled={submitting || (!configDir && !trimmedDraft)}
              onClick={() => void submit(null)}
            >
              {translate('auto.components.sidebar.ProjectGroupSettingsDialog.clear', 'Clear')}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm-compact"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                {translate('auto.components.sidebar.ProjectGroupSettingsDialog.cancel', 'Cancel')}
              </Button>
              {/* Never disabled on advice: the directory's state can change before launch, where the authoritative refusal lives. */}
              <Button type="submit" size="sm-compact" disabled={submitting}>
                {submitting
                  ? translate(
                      'auto.components.sidebar.ProjectGroupSettingsDialog.saving',
                      'Saving...'
                    )
                  : translate('auto.components.sidebar.ProjectGroupSettingsDialog.save', 'Save')}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ClaudeConfigDirFieldNote({
  adviceMessage,
  divergedConfigDir,
  inherited,
  remoteHostLabel
}: {
  adviceMessage: string | null
  /** The stored binding after someone else changed it, while the user's own draft says otherwise. */
  divergedConfigDir: string | null
  inherited: InheritedClaudeConfigDir | null
  remoteHostLabel: string | null
}): React.JSX.Element {
  // Why deferred into its own region: a live region announces a *mutation*, so text already
  // present when the region mounts is silent — and an advisory can be true at open time. The
  // `null` initial value commits the region empty first, so the first advisory is an update too.
  // The visible copy below carries no role, so nothing announces it a second time.
  const announced = useDeferredValue(adviceMessage, null)

  return (
    <div className="space-y-1 text-[11px]">
      <span role="status" data-claude-config-dir-live="" className="sr-only">
        {announced}
      </span>
      {remoteHostLabel ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.sidebar.ProjectGroupSettingsDialog.remoteHostPath',
            'This path is read on {{value0}}, so type it as that host spells it.',
            { value0: remoteHostLabel }
          )}
        </p>
      ) : null}
      {adviceMessage ? (
        <p data-claude-config-dir-advice="" className="text-muted-foreground">
          {adviceMessage}
        </p>
      ) : null}
      {divergedConfigDir !== null ? (
        <p data-claude-config-dir-external="" className="text-foreground">
          {divergedConfigDir
            ? translate(
                'auto.components.sidebar.ProjectGroupSettingsDialog.externalChange',
                'Changed elsewhere to {{value0}}. Your edit is kept — saving replaces it.',
                { value0: divergedConfigDir }
              )
            : translate(
                'auto.components.sidebar.ProjectGroupSettingsDialog.externalCleared',
                'Cleared elsewhere. Your edit is kept — saving replaces it.'
              )}
        </p>
      ) : null}
      {inherited ? (
        <p className="text-muted-foreground">
          {translate(
            'auto.components.sidebar.ProjectGroupSettingsDialog.inherited',
            'Inherited from {{value0}}:',
            { value0: inherited.groupName }
          )}{' '}
          <span className="font-mono break-all text-foreground">{inherited.configDir}</span>
        </p>
      ) : null}
    </div>
  )
}
