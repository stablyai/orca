import { useId, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { useAgentRowConversationName } from '@/components/dashboard/use-agent-row-conversation-name'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { renameSidebarAgent } from './sidebar-agent-rename'

export function SidebarAgentRenameDialog({
  agent,
  returnFocusRef,
  onClose
}: {
  agent: DashboardAgentRow
  returnFocusRef?: RefObject<HTMLButtonElement | null>
  onClose: () => void
}): React.JSX.Element {
  const name = useAgentRowConversationName(agent)
  const [value, setValue] = useState(name ?? '')
  const id = useId()
  const submit = () => {
    if (renameSidebarAgent(agent, value)) {
      onClose()
    } else {
      toast.error(
        translate(
          'sidebar.agentActions.renameUnavailable',
          'This agent is no longer available to rename.'
        )
      )
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current?.isConnected) {
            event.preventDefault()
            returnFocusRef.current.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{translate('sidebar.agentActions.renameTitle', 'Rename agent')}</DialogTitle>
          <DialogDescription>
            {translate(
              'sidebar.agentActions.renameDescription',
              'Leave the name blank to use the default title.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor={id}>{translate('sidebar.agentActions.name', 'Name')}</Label>
            <Input
              id={id}
              autoFocus
              value={value}
              onFocus={(event) => event.target.select()}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {translate('sidebar.agentActions.cancel', 'Cancel')}
            </Button>
            <Button type="submit">{translate('sidebar.agentActions.save', 'Save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
