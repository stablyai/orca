import { useRef, useState } from 'react'
import { FolderPlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAddRepoHostSelection } from '../project-admission/host-selection/use-add-repo-host-selection'
import { AddProjectHostSubmenu } from '../project-admission/menu/AddProjectHostSubmenu'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '../host-admission/ssh/AddRemoteHostDialog'
import { createChatWorkspace } from '../project-admission/create/create-chat-workspace'

const NOOP = (): void => {}

export function NewChatWorkspaceMenu(): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [hostSubOpen, setHostSubOpen] = useState(false)
  const [addHostMode, setAddHostMode] = useState<AddRemoteHostMode | null>(null)
  const actionRef = useRef<HTMLDivElement>(null)
  const hostSelection = useAddRepoHostSelection({ isOpen: open, setStep: NOOP })
  const label = t('sidebar.chats.create', 'New chat workspace')

  const create = (): void => {
    const hostId = hostSelection.selectedHostId
    if (!hostId) {
      return
    }
    setOpen(false)
    setCreating(true)
    void createChatWorkspace(hostId)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setCreating(false))
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={creating}
                aria-label={label}
                aria-busy={creating}
              >
                {creating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FolderPlus className="size-3.5" strokeWidth={2.25} />
                )}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-60"
          data-add-project-menu=""
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            actionRef.current?.focus()
          }}
        >
          <div className="flex min-h-[26px] items-center justify-between gap-2 py-0.5 pr-1 pl-2.5">
            <span className="shrink-0 text-2xs font-semibold text-muted-foreground select-none">
              {t('sidebar.chats.title', 'Chats')}
            </span>
            <AddProjectHostSubmenu
              hostSelection={hostSelection}
              subOpen={hostSubOpen}
              onSubOpenChange={setHostSubOpen}
              onOpenRemoteHostDialog={(mode) => {
                setOpen(false)
                setAddHostMode(mode)
              }}
              onHostPicked={() => requestAnimationFrame(() => actionRef.current?.focus())}
            />
          </div>
          <DropdownMenuItem
            ref={actionRef}
            disabled={!hostSelection.selectedHostId}
            onSelect={create}
            onPointerMove={() => setHostSubOpen(false)}
          >
            <FolderPlus />
            <span className="truncate">{label}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddRemoteHostDialog mode={addHostMode} onOpenChange={setAddHostMode} />
    </>
  )
}
