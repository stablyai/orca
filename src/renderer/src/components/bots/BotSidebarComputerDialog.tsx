import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { BOT_COMPUTER_NAME_LIMIT, type BotComputerAssignment } from './bot-sidebar-computer-view'
import { revealBotSidebarRow } from './reveal-bot-sidebar-row'

const RUN_LOCATION = 'run-location'
const NAMED_COMPUTER = 'named-computer'

export function BotSidebarComputerDialog({
  entryId,
  botName,
  assignment,
  hostNames,
  onSubmit,
  onClose
}: {
  entryId: string
  botName: string
  assignment: BotComputerAssignment | undefined
  hostNames: ReadonlyMap<string, string>
  onSubmit: (value: BotComputerAssignment | null) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const computerId = useId()
  const nameId = useId()
  const [choice, setChoice] = useState(
    assignment?.kind === 'host' ? assignment.hostId : assignment ? NAMED_COMPUTER : RUN_LOCATION
  )
  const [name, setName] = useState(assignment?.kind === 'named' ? assignment.name : '')
  const computers = new Map(hostNames)
  if (assignment?.kind === 'host' && !computers.has(assignment.hostId)) {
    computers.set(assignment.hostId, assignment.name)
  }
  const trimmedName = name.trim()
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-sm"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          revealBotSidebarRow({
            sidebarKey: entryId,
            isCurrent: () => document.activeElement === document.body,
            focusName: true
          })
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('bots.computerView.assign', 'Show under computer')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.computerView.assignDescription',
              'Choose where {{botName}} appears in the Bots sidebar. The bot still runs on its current computer.',
              { botName }
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (choice === NAMED_COMPUTER && !trimmedName) {
              return
            }
            if (choice === RUN_LOCATION) {
              onSubmit(null)
            } else if (choice === NAMED_COMPUTER) {
              onSubmit({ kind: 'named', name: trimmedName })
            } else {
              const label = computers.get(choice)
              if (label) {
                onSubmit({ kind: 'host', hostId: choice, name: label })
              }
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={computerId}>{t('bots.computerView.computer', 'Computer')}</Label>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id={computerId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={RUN_LOCATION}>
                  {t('bots.computerView.runLocation', 'Where the bot runs')}
                </SelectItem>
                {[...computers].map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
                <SelectItem value={NAMED_COMPUTER}>
                  {t('bots.computerView.custom', 'Another computer…')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {choice === NAMED_COMPUTER ? (
            <div className="space-y-2">
              <Label htmlFor={nameId}>{t('bots.computerView.name', 'Computer name')}</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={BOT_COMPUTER_NAME_LIMIT}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={choice === NAMED_COMPUTER && !trimmedName}>
              {t('bots.computerView.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
