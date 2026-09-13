import { PanelTopClose, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { CanvasNode } from './agent-canvas-document'
import type { Tab } from '../../../../shared/tab-types'

export function AgentCanvasRemoveDialog({
  node,
  tab,
  onCancel,
  onDetach,
  onCloseTab
}: {
  node: CanvasNode | null
  tab?: Tab
  onCancel: () => void
  onDetach: () => void
  onCloseTab: () => void
}) {
  return (
    <Dialog
      open={!!node}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{translate('agentCanvas.removeTitle', 'Remove this card?')}</DialogTitle>
          <DialogDescription className="break-words">
            {node?.title || translate('agentCanvas.removeCard', 'Remove card')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Button className="w-full justify-start" onClick={onDetach}>
              <Unplug />
              {translate('agentCanvas.removeNode', 'Remove from canvas')}
            </Button>
            <p className="text-xs text-muted-foreground">
              {tab
                ? translate(
                    'agentCanvas.detachDescription',
                    'Removes this card and its connections. The tab stays open and running.'
                  )
                : translate(
                    'agentCanvas.removeOnlyDescription',
                    'Removes this card and its connections. No workspace tab will be closed.'
                  )}
            </p>
          </div>
          {tab && (
            <div className="space-y-1.5 border-t border-border pt-3">
              <Button
                variant="outline"
                className="w-full justify-start"
                disabled={tab.isPinned}
                onClick={onCloseTab}
              >
                <PanelTopClose />
                {translate('agentCanvas.removeAndClose', 'Remove and close tab')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {tab.isPinned
                  ? translate(
                      'agentCanvas.unpinToClose',
                      'Unpin this tab before closing it from the canvas.'
                    )
                  : tab.contentType === 'terminal'
                    ? translate(
                        'agentCanvas.closeTerminalDescription',
                        'Closes the entire terminal tab, including all its panes and running agents. Canvas undo will not reopen it.'
                      )
                    : translate(
                        'agentCanvas.closeBrowserDescription',
                        'Closes the browser tab and all its pages. Canvas undo will not reopen it.'
                      )}
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {translate('agentCanvas.cancel', 'Cancel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
