import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ChevronDown, Check, X, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TaskPageLinearProjectFields } from './ProjectFields'
export function TaskPageLinearProjectDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    availableTeams,
    newLinearProjectOpen,
    setNewLinearProjectOpen,
    newLinearProjectName,
    setNewLinearProjectTeamId,
    newLinearProjectSubmitting,
    newLinearProjectTargetTeam,
    handleCreateNewLinearProject
  } = model
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

        <TaskPageLinearProjectFields model={model} />

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
