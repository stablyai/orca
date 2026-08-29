import React from 'react'
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import {
  NewLinearIssueMorePickers,
  type NewLinearIssueMorePickersProps
} from './new-linear-issue-more-pickers'
import {
  NewLinearIssueStatusAssignee,
  type NewLinearIssueStatusAssigneeProps
} from './new-linear-issue-status-assignee'

export type NewLinearIssueDialogProps = NewLinearIssueStatusAssigneeProps &
  NewLinearIssueMorePickersProps & {
    newLinearIssueOpen: boolean
    setNewLinearIssueOpen: (open: boolean) => void
    handleCreateNewLinearIssue: () => Promise<void> | void
    availableTeams: LinearTeam[]
    newLinearIssueTargetTeam: LinearTeam | null
    newLinearIssueTeamId: string | null
    setNewLinearIssueTeamId: (id: string | null) => void
    newLinearIssueTitle: string
    setNewLinearIssueTitle: (value: string) => void
    newLinearIssueBody: string
    setNewLinearIssueBody: (value: string) => void
    submitShortcutLabel: string
  }

export function NewLinearIssueDialog({
  newLinearIssueOpen,
  newLinearIssueSubmitting,
  setNewLinearIssueOpen,
  handleCreateNewLinearIssue,
  availableTeams,
  newLinearIssueTargetTeam,
  newLinearIssueTeamId,
  setNewLinearIssueTeamId,
  newLinearIssueTitle,
  setNewLinearIssueTitle,
  newLinearIssueBody,
  setNewLinearIssueBody,
  submitShortcutLabel,
  newLinearStates,
  newLinearIssueStateId,
  setNewLinearIssueStateId,
  newLinearMembers,
  newLinearIssueAssigneeId,
  setNewLinearIssueAssigneeId,
  ...morePickerProps
}: NewLinearIssueDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={newLinearIssueOpen}
      onOpenChange={(open) => {
        if (!newLinearIssueSubmitting) {
          setNewLinearIssueOpen(open)
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-2xl bg-background border-border shadow-2xl p-0 overflow-hidden flex flex-col gap-0 rounded-xl"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreateNewLinearIssue()
          }
        }}
      >
        <DialogTitle className="sr-only">
          {translate(
            'auto.components.task.page.dialogs.new.linear.issue.dialog.dialogTitle',
            'New Linear issue'
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate(
            'auto.components.task.page.dialogs.new.linear.issue.dialog.dialogDescription',
            'Create a Linear issue for the selected team.'
          )}
        </DialogDescription>
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3 bg-muted/10">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {translate('auto.components.TaskPage.c11105dac5', 'New Issue')}
            </span>
            <span className="text-muted-foreground/40 text-xs">/</span>
            {availableTeams.length > 1 ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 gap-1 px-2 font-medium text-xs text-foreground hover:bg-muted"
                  >
                    {newLinearIssueTargetTeam?.key ??
                      translate('auto.components.TaskPage.d7f16d0e32', 'Select Team')}
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-64 p-1 popover-scroll-content scrollbar-sleek"
                >
                  <div className="text-[10px] font-semibold text-muted-foreground px-2 py-1.5 uppercase tracking-wider">
                    {translate('auto.components.TaskPage.4f3cb99f41', 'Switch Team')}
                  </div>
                  {availableTeams.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setNewLinearIssueTeamId(t.id)}
                      className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${
                        newLinearIssueTeamId === t.id ? 'bg-muted font-medium' : ''
                      }`}
                    >
                      <span>
                        {t.key} — {t.name}
                      </span>
                      {newLinearIssueTeamId === t.id && <Check className="size-3" />}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            ) : (
              <span className="text-xs font-medium text-foreground">
                {newLinearIssueTargetTeam?.key ?? ''} — {newLinearIssueTargetTeam?.name ?? ''}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setNewLinearIssueOpen(false)}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
            disabled={newLinearIssueSubmitting}
            aria-label={translate('auto.components.TaskPage.b6795e65fd', 'Close')}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col px-6 py-4 gap-3">
          <input
            autoFocus
            value={newLinearIssueTitle}
            onChange={(e) => setNewLinearIssueTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void handleCreateNewLinearIssue()
              }
            }}
            placeholder={translate('auto.components.TaskPage.d9151fd4e9', 'Issue title')}
            disabled={newLinearIssueSubmitting}
            className="text-lg font-semibold bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/40 text-foreground w-full"
          />

          <textarea
            value={newLinearIssueBody}
            onChange={(e) => setNewLinearIssueBody(e.target.value)}
            placeholder={translate('auto.components.TaskPage.9bc8aea407', 'Add description...')}
            rows={5}
            disabled={newLinearIssueSubmitting}
            className="w-full min-w-0 text-sm bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/45 text-foreground resize-none max-h-60 overflow-y-auto scrollbar-sleek py-1"
          />

          <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4 mt-2">
            <NewLinearIssueStatusAssignee
              newLinearIssueSubmitting={newLinearIssueSubmitting}
              newLinearStates={newLinearStates}
              newLinearIssueStateId={newLinearIssueStateId}
              setNewLinearIssueStateId={setNewLinearIssueStateId}
              newLinearMembers={newLinearMembers}
              newLinearIssueAssigneeId={newLinearIssueAssigneeId}
              setNewLinearIssueAssigneeId={setNewLinearIssueAssigneeId}
            />
            <NewLinearIssueMorePickers
              newLinearIssueSubmitting={newLinearIssueSubmitting}
              {...morePickerProps}
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 px-6 py-4 bg-muted/5">
          <span className="text-[10px] text-muted-foreground/60 font-medium">
            {submitShortcutLabel} {translate('auto.components.TaskPage.fc0d8a1fa4', 'to submit.')}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNewLinearIssueOpen(false)}
              disabled={newLinearIssueSubmitting}
              className="text-xs h-8 text-muted-foreground hover:text-foreground"
            >
              {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void handleCreateNewLinearIssue()}
              disabled={
                !newLinearIssueTargetTeam || !newLinearIssueTitle.trim() || newLinearIssueSubmitting
              }
              className="text-xs h-8 bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
            >
              {newLinearIssueSubmitting ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin mr-1" />
                  {translate('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
                </>
              ) : (
                translate('auto.components.TaskPage.e15ba2d2eb', 'Create issue')
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
