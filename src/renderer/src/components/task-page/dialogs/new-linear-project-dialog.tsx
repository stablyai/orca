import React from 'react'
import { Check, ChevronDown, LoaderCircle, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { LinearTeam } from '../../../../../shared/linear/workspace-types'
import {
  NewLinearProjectFields,
  type NewLinearProjectFieldsProps
} from './new-linear-project-fields'

export type NewLinearProjectDialogProps = NewLinearProjectFieldsProps & {
  newLinearProjectOpen: boolean
  setNewLinearProjectOpen: (open: boolean) => void
  handleCreateNewLinearProject: () => Promise<void> | void
  availableTeams: LinearTeam[]
  newLinearProjectTargetTeam: LinearTeam | null
  setNewLinearProjectTeamId: (id: string | null) => void
  newLinearProjectName: string
  setNewLinearProjectName: (value: string) => void
  newLinearProjectDescription: string
  setNewLinearProjectDescription: (value: string) => void
  newLinearProjectContent: string
  setNewLinearProjectContent: (value: string) => void
  submitShortcutLabel: string
}

export function NewLinearProjectDialog({
  newLinearProjectOpen,
  newLinearProjectSubmitting,
  setNewLinearProjectOpen,
  handleCreateNewLinearProject,
  availableTeams,
  newLinearProjectTargetTeam,
  setNewLinearProjectTeamId,
  newLinearProjectName,
  setNewLinearProjectName,
  newLinearProjectDescription,
  setNewLinearProjectDescription,
  newLinearProjectContent,
  setNewLinearProjectContent,
  submitShortcutLabel,
  ...fieldProps
}: NewLinearProjectDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={newLinearProjectOpen}
      onOpenChange={(open) => {
        if (!newLinearProjectSubmitting) {
          setNewLinearProjectOpen(open)
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[88vh] flex-col gap-0 overflow-hidden rounded-xl border-border bg-background p-0 shadow-2xl sm:max-w-3xl"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreateNewLinearProject()
          }
        }}
      >
        <DialogTitle className="sr-only">
          {translate('auto.components.TaskPage.1361275ec3', 'New Linear project')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate(
            'auto.components.TaskPage.bdebffcbfe',
            'Create a Linear project for the selected team.'
          )}
        </DialogDescription>
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/10 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {translate('auto.components.TaskPage.02f67c0d09', 'New Project')}
            </span>
            <span className="text-xs text-muted-foreground/40">/</span>
            {availableTeams.length > 1 ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 max-w-56 gap-1 px-2 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    <span className="truncate">
                      {newLinearProjectTargetTeam
                        ? `${newLinearProjectTargetTeam.key} - ${newLinearProjectTargetTeam.name}`
                        : translate('auto.components.TaskPage.5af6f0ae5b', 'Select team')}
                    </span>
                    <ChevronDown className="size-3 flex-none text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-1">
                  <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {translate('auto.components.TaskPage.a98cbe7664', 'Team')}
                  </div>
                  <div className="max-h-64 overflow-y-auto scrollbar-sleek">
                    {availableTeams.map((team) => (
                      <button
                        key={team.id}
                        type="button"
                        onClick={() => setNewLinearProjectTeamId(team.id)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                          newLinearProjectTargetTeam?.id === team.id
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-foreground/80'
                        )}
                      >
                        <span className="truncate">
                          {team.key} - {team.name}
                        </span>
                        {newLinearProjectTargetTeam?.id === team.id ? (
                          <Check className="size-3 flex-none" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <span className="truncate text-xs font-medium text-foreground">
                {newLinearProjectTargetTeam
                  ? `${newLinearProjectTargetTeam.key} - ${newLinearProjectTargetTeam.name}`
                  : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setNewLinearProjectOpen(false)}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
            disabled={newLinearProjectSubmitting}
            aria-label={translate('auto.components.TaskPage.b6795e65fd', 'Close')}
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 scrollbar-sleek">
          <input
            autoFocus
            value={newLinearProjectName}
            onChange={(event) => setNewLinearProjectName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void handleCreateNewLinearProject()
              }
            }}
            placeholder={translate('auto.components.TaskPage.ecbcc83140', 'Project name')}
            disabled={newLinearProjectSubmitting}
            className="w-full border-none bg-transparent p-0 text-xl font-semibold text-foreground outline-none placeholder:text-muted-foreground/45 focus:outline-none focus:ring-0 focus-visible:ring-0"
          />

          <input
            value={newLinearProjectDescription}
            onChange={(event) => setNewLinearProjectDescription(event.target.value)}
            placeholder={translate('auto.components.TaskPage.579f98afcd', 'Add a short summary...')}
            disabled={newLinearProjectSubmitting}
            className="w-full border-none bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/45 focus:outline-none focus:ring-0 focus-visible:ring-0"
          />

          <NewLinearProjectFields
            newLinearProjectSubmitting={newLinearProjectSubmitting}
            {...fieldProps}
          />

          <div className="border-t border-border/40 pt-4">
            <textarea
              value={newLinearProjectContent}
              onChange={(event) => setNewLinearProjectContent(event.target.value)}
              placeholder={translate(
                'auto.components.TaskPage.cf72580c04',
                'Write a description, project brief, or collect ideas...'
              )}
              rows={8}
              disabled={newLinearProjectSubmitting}
              className="max-h-72 min-h-40 w-full min-w-0 resize-none overflow-y-auto border-none bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/45 scrollbar-sleek focus:outline-none focus:ring-0 focus-visible:ring-0"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {submitShortcutLabel} {translate('auto.components.TaskPage.fc0d8a1fa4', 'to submit.')}
          </p>
        </div>

        <DialogFooter className="border-t border-border/60 bg-muted/10 px-5 py-3">
          <Button
            variant="outline"
            onClick={() => setNewLinearProjectOpen(false)}
            disabled={newLinearProjectSubmitting}
          >
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreateNewLinearProject()}
            disabled={
              !newLinearProjectTargetTeam ||
              !newLinearProjectName.trim() ||
              newLinearProjectSubmitting
            }
          >
            {newLinearProjectSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.TaskPage.1b59a07674', 'Creating...')}
              </>
            ) : (
              translate('auto.components.TaskPage.5301ca0f20', 'Create project')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
