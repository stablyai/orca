import React, { useCallback, useId, useRef, useState } from 'react'
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
  /** SSH target of the group's owner host, so the advisory probe reads the right filesystem. */
  connectionId?: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (claudeConfigDir: string | null) => Promise<void> | void
}

export function ProjectGroupSettingsDialog({
  open,
  groupName,
  configDir,
  inherited,
  connectionId,
  onOpenChange,
  onSubmit
}: ProjectGroupSettingsDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const adviceId = useId()
  const [draft, setDraft] = useState(configDir ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [previousOpenState, setPreviousOpenState] = useState({ open, configDir })
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
      setDraft(configDir ?? '')
      setSubmitting(false)
    }
  }

  const probe: ClaudeConfigDirProbe | null = useClaudeConfigDirProbe({
    enabled: open,
    draft,
    connectionId
  })
  const advice = evaluateClaudeConfigDirAdvice({ draft, probe })
  const trimmedDraft = draft.trim()
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
        await onSubmit(nextValue)
        if (mountedRef.current) {
          onOpenChange(false)
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
          <DialogTitle>
            {translate(
              'auto.components.sidebar.ProjectGroupSettingsDialog.title',
              'Group Settings'
            )}
          </DialogTitle>
          <DialogDescription>
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
            <Label htmlFor={inputId}>
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
                aria-describedby={advice ? adviceId : undefined}
                placeholder={translate(
                  'auto.components.sidebar.ProjectGroupSettingsDialog.fieldPlaceholder',
                  'Claude’s default home'
                )}
                onChange={(event) => setDraft(event.target.value)}
                className="h-8"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => void handleBrowse()}
              >
                <FolderOpen className="size-3.5" />
                {translate('auto.components.sidebar.ProjectGroupSettingsDialog.browse', 'Browse')}
              </Button>
            </div>
          </div>
          <ClaudeConfigDirFieldNote
            adviceId={adviceId}
            adviceMessage={advice?.message ?? null}
            inherited={showInherited ? inherited : null}
          />
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={submitting || (!configDir && !trimmedDraft)}
              onClick={() => void submit(null)}
            >
              {translate('auto.components.sidebar.ProjectGroupSettingsDialog.clear', 'Clear')}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                {translate('auto.components.sidebar.ProjectGroupSettingsDialog.cancel', 'Cancel')}
              </Button>
              {/* Never disabled on advice: the directory's state can change before launch, where the authoritative refusal lives. */}
              <Button type="submit" size="sm" disabled={submitting}>
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
  adviceId,
  adviceMessage,
  inherited
}: {
  adviceId: string
  adviceMessage: string | null
  inherited: InheritedClaudeConfigDir | null
}): React.JSX.Element {
  return (
    <div className="space-y-1 text-[11px]">
      {adviceMessage ? (
        <p
          id={adviceId}
          role="status"
          data-claude-config-dir-advice=""
          className="text-muted-foreground"
        >
          {adviceMessage}
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
