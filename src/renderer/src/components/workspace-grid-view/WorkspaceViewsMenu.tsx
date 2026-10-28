import { useState } from 'react'
import { ChevronDown, LayoutGrid, Plus, Pencil, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { showWorkspaceView } from '@/lib/workspace-view-actions'
import { WORKSPACE_VIEW_MAX_SAVED } from '@/lib/workspace-view-layout'
import type { WorkspaceView } from '@/lib/workspace-view-layout'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
const EMPTY_VIEWS: readonly WorkspaceView[] = []

export function WorkspaceViewsMenu({ compact = false }: { compact?: boolean }): React.JSX.Element {
  useTranslation()
  const views = useAppStore((state) => state.workspaceViews ?? EMPTY_VIEWS)
  const activeId = useAppStore((state) => state.activeWorkspaceViewId)
  const active = views.find((view) => view.id === activeId)
  const [editing, setEditing] = useState<'new' | 'rename' | null>(null)
  const [name, setName] = useState('')
  const viewsLabel = translate('workspaceViews.views', 'Views')
  function submit(): void {
    if (!name.trim()) {
      return
    }
    const state = useAppStore.getState()
    if (editing === 'rename' && active) {
      state.renameWorkspaceView(active.id, name)
    } else {
      const id = state.createWorkspaceView(name)
      if (!id) {
        return
      }
      state.setActiveView('terminal')
      state.setWorkspaceViewPicker({})
    }
    setEditing(null)
  }
  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size={compact ? 'icon-xs' : 'sm'} aria-label={viewsLabel}>
                <LayoutGrid />
                {compact ? null : (
                  <>
                    <span className="max-w-48 truncate">{active?.name ?? viewsLabel}</span>
                    <ChevronDown />
                  </>
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{viewsLabel}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            {views.map((view) => (
              <DropdownMenuItem key={view.id} onSelect={() => showWorkspaceView(view.id)}>
                <LayoutGrid />
                <span className="max-w-64 truncate">{view.name}</span>
                <span className="ml-auto text-muted-foreground">{view.panels.length}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              disabled={views.length >= WORKSPACE_VIEW_MAX_SAVED}
              onSelect={() => {
                setName('')
                setEditing('new')
              }}
            >
              <Plus />
              {translate('workspaceViews.newView', 'New view…')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          {active ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  onSelect={() => {
                    setName(active.name)
                    setEditing('rename')
                  }}
                >
                  <Pencil />
                  {translate('workspaceViews.renameView', 'Rename view…')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => useAppStore.getState().removeWorkspaceView(active.id)}
                >
                  <X />
                  {translate('workspaceViews.removeView', 'Remove saved view')}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>
                {editing === 'rename'
                  ? translate('workspaceViews.renameView', 'Rename view…')
                  : translate('workspaceViews.newView', 'New view…')}
              </DialogTitle>
              <DialogDescription>
                {translate(
                  'workspaceViews.nameDescription',
                  'Save an arrangement of panels from any project on this device.'
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-view-name">
                {translate('workspaceViews.name', 'Name')}
              </Label>
              <Input
                id="workspace-view-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={80}
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button variant="ghost" type="button" onClick={() => setEditing(null)}>
                {translate('workspaceViews.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim()}>
                {translate('workspaceViews.save', 'Save view')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
