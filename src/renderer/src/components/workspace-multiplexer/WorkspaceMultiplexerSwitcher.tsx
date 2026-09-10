import { useState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getWorkspaceMultiplexerLayouts } from '../../../../shared/workspace-multiplexer-collections'

export function WorkspaceMultiplexerSwitcher(): React.JSX.Element {
  const state = useAppStore((s) => s.workspaceMultiplexer)
  const layouts = getWorkspaceMultiplexerLayouts(state)
  const active = layouts.find((item) => item.id === state.activeLayoutId) ?? layouts[0]!
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const addLabel = translate('multiplexer.addLayout', 'Add multiplexer')
  const deleteLabel = translate('multiplexer.deleteLayout', 'Delete multiplexer')
  const layoutName = (name: string): string => {
    const number = /^Multiplexer (\d+)$/.exec(name)?.[1]
    return number
      ? translate('multiplexer.layoutName', 'Multiplexer {{value0}}', { value0: number })
      : name
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 gap-1.5"
            data-workspace-multiplexer-switcher=""
          >
            <span className="truncate">{layoutName(active.name)}</span>
            <ChevronDown className="size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-xs">
          <DropdownMenuRadioGroup
            value={active.id}
            onValueChange={(id) => useAppStore.getState().selectWorkspaceMultiplexer(id)}
          >
            {layouts.map((item) => (
              <DropdownMenuRadioItem key={item.id} value={item.id}>
                <span className="truncate">{layoutName(item.name)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={layouts.length >= 24}
            onSelect={() => useAppStore.getState().addWorkspaceMultiplexer()}
          >
            <Plus />
            {addLabel}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDeletingId(active.id)}>
            <Trash2 />
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={deletingId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingId(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{deleteLabel}</DialogTitle>
            <DialogDescription>
              {translate(
                'multiplexer.deleteLayoutDescription',
                'Delete this saved layout? Workspaces and running terminals will not be deleted.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingId(null)}>
              {translate('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingId) {
                  useAppStore.getState().removeWorkspaceMultiplexer(deletingId)
                }
                setDeletingId(null)
              }}
            >
              {deleteLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
