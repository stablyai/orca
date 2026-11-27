import React, { useId, useState } from 'react'
import { Folder, House, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BotSidebarFolder } from '../../../../shared/bots/bot-sidebar-folders'

export type BotFolderDestination = {
  /** null is the section's root. */
  id: string | null
  name: string
  depth: number
  kind?: 'group'
}

function destinationValue(id: string | null): string {
  return id === null ? 'root' : `destination:${id}`
}

/** Picks a folder for a bot or folder; the caller leaves invalid destinations out. */
export function BotFolderMoveDialog({
  open,
  title,
  description,
  destinations,
  value,
  onOpenChange,
  onMove
}: {
  open: boolean
  title: string
  description: string
  destinations: readonly BotFolderDestination[]
  /** The current parent, disabled because moving there changes nothing. */
  value: string | null
  onOpenChange: (open: boolean) => void
  onMove: (folderId: string | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const idPrefix = useId()
  const [selected, setSelected] = useState(destinationValue(value))
  const current = destinationValue(value)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="compact">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="scrollbar-sleek max-h-64 overflow-y-auto">
          <RadioGroup value={selected} onValueChange={setSelected} layout="rows" aria-label={title}>
            {destinations.map((destination) => {
              const itemValue = destinationValue(destination.id)
              const itemId = `${idPrefix}-${itemValue}`
              const disabled = itemValue === current
              const Icon =
                destination.id === null ? House : destination.kind === 'group' ? Users : Folder
              return (
                <div
                  key={itemValue}
                  className={cn(
                    'flex min-h-8 items-center gap-2 rounded-sm px-2 text-xs',
                    disabled ? 'text-muted-foreground' : 'hover:bg-accent'
                  )}
                >
                  <RadioGroupItem
                    id={itemId}
                    value={itemValue}
                    disabled={disabled}
                    className="size-3.5"
                  />
                  <Label
                    htmlFor={itemId}
                    variant="dialog"
                    className={cn('min-w-0 flex-1', disabled ? 'cursor-default' : 'cursor-pointer')}
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span
                      className="truncate"
                      style={{ paddingInlineStart: `min(${destination.depth * 10}px, 40%)` }}
                      title={destination.name}
                    >
                      {destination.name}
                    </span>
                  </Label>
                </div>
              )
            })}
          </RadioGroup>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"

            onClick={() => onOpenChange(false)}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="sm"

            disabled={selected === current}
            onClick={() => {
              const destination = destinations.find(
                (candidate) => destinationValue(candidate.id) === selected
              )
              if (destination) {
                onMove(destination.id)
              }
            }}
          >
            {t('bots.folders.moveConfirm', 'Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Root first, then every folder in tree order. */
export function botFolderDestinations(
  listed: readonly { folder: BotSidebarFolder; depth: number }[],
  rootName: string
): BotFolderDestination[] {
  return [
    { id: null, name: rootName, depth: 0 },
    ...listed.map(({ folder, depth }) => ({ id: folder.id, name: folder.name, depth }))
  ]
}
