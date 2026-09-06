import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ChevronDown, Check, X, LoaderCircle } from 'lucide-react'
import { TaskPageLinearIssueAttributes } from './IssueAttributes'
export function TaskPageLinearIssueDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    submitShortcutLabel,
    availableTeams,
    newLinearIssueOpen,
    setNewLinearIssueOpen,
    newLinearIssueTitle,
    setNewLinearIssueTitle,
    newLinearIssueBody,
    setNewLinearIssueBody,
    newLinearIssueTeamId,
    setNewLinearIssueTeamId,
    newLinearIssueSubmitting,
    newLinearIssueTargetTeam,
    handleCreateNewLinearIssue
  } = model
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
        {/* Header/Team section */}
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
                      className={`w-full flex items-center justify-between text-left px-2 py-1.5 text-xs rounded-sm hover:bg-muted transition-colors ${newLinearIssueTeamId === t.id ? 'bg-muted font-medium' : ''}`}
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
            onClick={() => setNewLinearIssueOpen(false)}
            className="text-muted-foreground hover:text-foreground p-1 rounded-md transition-colors"
            disabled={newLinearIssueSubmitting}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Form Content */}
        <div className="flex flex-col px-6 py-4 gap-3">
          {/* Title */}
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

          {/* Description */}
          <textarea
            value={newLinearIssueBody}
            onChange={(e) => setNewLinearIssueBody(e.target.value)}
            placeholder={translate('auto.components.TaskPage.9bc8aea407', 'Add description...')}
            rows={5}
            disabled={newLinearIssueSubmitting}
            className="w-full min-w-0 text-sm bg-transparent border-none outline-none focus:outline-none focus:ring-0 focus-visible:ring-0 p-0 placeholder:text-muted-foreground/45 text-foreground resize-none max-h-60 overflow-y-auto scrollbar-sleek py-1"
          />

          {/* Attribute Badges Row */}
          <TaskPageLinearIssueAttributes model={model} />
        </div>

        {/* Footer */}
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
