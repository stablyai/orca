import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'
import { LoaderCircle } from 'lucide-react'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
export function TaskPageBusinessmapCardDialog({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const {
    submitShortcutLabel,
    newBusinessmapCardOpen,
    setNewBusinessmapCardOpen,
    newBusinessmapCardTitle,
    setNewBusinessmapCardTitle,
    newBusinessmapCardBody,
    setNewBusinessmapCardBody,
    newBusinessmapCardBoardId,
    setNewBusinessmapCardBoardId,
    newBusinessmapCardSubmitting,
    availableBusinessmapBoards,
    businessmapBoardsLoading,
    handleCreateNewBusinessmapCard
  } = model
  return (
    <Dialog
      open={newBusinessmapCardOpen}
      onOpenChange={(open) => {
        if (!newBusinessmapCardSubmitting) {
          setNewBusinessmapCardOpen(open)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreateNewBusinessmapCard()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.businessmapNewCard', 'New Businessmap card')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.TaskPage.businessmapNewCardBody',
              'Creates a new card on the selected Businessmap board.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.businessmapBoard', 'Board')}
            </label>
            <Select
              value={
                newBusinessmapCardBoardId !== null ? String(newBusinessmapCardBoardId) : undefined
              }
              onValueChange={(v) => setNewBusinessmapCardBoardId(Number(v))}
              disabled={
                newBusinessmapCardSubmitting ||
                businessmapBoardsLoading ||
                availableBusinessmapBoards.length === 0
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    businessmapBoardsLoading
                      ? translate('auto.components.TaskPage.7d63e2626e', 'Loading...')
                      : translate('auto.components.TaskPage.businessmapBoard', 'Board')
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableBusinessmapBoards.map((board) => (
                  <SelectItem key={board.id} value={String(board.id)}>
                    {board.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.16cba35bee', 'Title')}
            </label>
            <Input
              autoFocus
              value={newBusinessmapCardTitle}
              onChange={(e) => setNewBusinessmapCardTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreateNewBusinessmapCard()
                }
              }}
              placeholder={translate('auto.components.TaskPage.578f730c16', 'Short summary')}
              disabled={newBusinessmapCardSubmitting}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.f161bf9ede', 'Description (optional)')}
            </label>
            <textarea
              value={newBusinessmapCardBody}
              onChange={(e) => setNewBusinessmapCardBody(e.target.value)}
              placeholder={translate('auto.components.TaskPage.34d97ca682', "What's going on?")}
              rows={6}
              disabled={newBusinessmapCardSubmitting}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto scrollbar-sleek"
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            {submitShortcutLabel} {translate('auto.components.TaskPage.fc0d8a1fa4', 'to submit.')}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setNewBusinessmapCardOpen(false)}
            disabled={newBusinessmapCardSubmitting}
          >
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreateNewBusinessmapCard()}
            disabled={
              newBusinessmapCardBoardId === null ||
              !newBusinessmapCardTitle.trim() ||
              newBusinessmapCardSubmitting
            }
          >
            {newBusinessmapCardSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
              </>
            ) : (
              translate('auto.components.TaskPage.businessmapCreateCard', 'Create card')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
