import React, { useRef } from 'react'
import { ArchiveSnapshotTooltip } from '@/components/orca-cloud/ArchiveSnapshotTooltip'
import {
  Archive,
  ArchiveRestore,
  Moon,
  Trash2,
  ArrowUpRight,
  BookOpen,
  MoreHorizontal,
  Play,
  RotateCw,
  UserRoundCog
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudWorkspace,
  CloudWorkspacePatch
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { MemberAvatar } from './CloudMemberAvatars'
import type { MemberDirectory } from './cloud-workspace-format'
import {
  cloudWorkspaceActionGroups,
  type CloudWorkspaceAction
} from './cloud-workspace-action-groups'

export type RowActions = {
  /** Opens it, waking it first when it is asleep. */
  open: (w: CloudWorkspace) => void
  /** Asleep: the read-only copy it saved when it went to sleep (never wakes it). */
  read: (w: CloudWorkspace) => void
  patch: (w: CloudWorkspace, patch: CloudWorkspacePatch) => void
  /** Sleep and archive with a snapshot (Undo for 5 s); never just a label. */
  archive: (w: CloudWorkspace) => void
  unarchive: (w: CloudWorkspace) => void
  /** Put a running sandbox to sleep (frees a running slot). */
  sleep: (w: CloudWorkspace) => void
  /** Restart it; only offered where this desktop runs it (the sidebar has the same action). */
  restart?: (w: CloudWorkspace) => void
  /** Delete the sandbox and its disk, after a confirmation. */
  remove: (w: CloudWorkspace) => void
}

// Keeps submenus off the window edge when the row sits near the bottom of the list.
const SUBMENU_COLLISION_PADDING = 8

/** An Asleep workspace this account can open: its row reads the saved copy instead of waking. */
export function isReadableAsleep(w: CloudWorkspace): boolean {
  return (
    w.archivedAt === null &&
    w.access !== 'none' &&
    (w.status === 'suspended' || w.status === 'suspending')
  )
}

export function CloudWorkspaceRowMenu({
  workspace: w,
  title,
  canOpen,
  canManage,
  members,
  directory,
  selfId,
  open,
  onOpenChange,
  actions
}: {
  workspace: CloudWorkspace
  title: string
  canOpen: boolean
  canManage: boolean
  members: { userId: string; name: string }[]
  directory: MemberDirectory
  selfId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: RowActions
}): React.JSX.Element {
  const t = useTranslate()
  // Focus returns to ⋯ on close; after a mouse open that would leave a ring nobody asked for.
  const openedByPointer = useRef(false)
  // The same action list the sidebar menu renders (JA-14).
  const groups = cloudWorkspaceActionGroups({
    surface: 'list',
    status: w.status,
    archivedAt: w.archivedAt,
    canOpen,
    canManage,
    readableAsleep: isReadableAsleep(w),
    canRestart:
      actions.restart !== undefined &&
      w.access === 'owner' &&
      (w.status === 'running' || w.status === 'failed'),
    hasMembers: members.length > 0
  })
  const has = (action: CloudWorkspaceAction): boolean =>
    groups.some((group) => group.actions.includes(action))
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        asChild
        onPointerDown={() => {
          openedByPointer.current = true
        }}
        onKeyDown={() => {
          openedByPointer.current = false
        }}
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('auto.components.cloudWorkspaces.rowActions', 'Actions for {{value0}}', {
            value0: title
          })}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-60"
        onCloseAutoFocus={(event) => {
          if (openedByPointer.current) {
            event.preventDefault()
          }
        }}
      >
        {canOpen && isReadableAsleep(w) && (
          <>
            <DropdownMenuItem onSelect={() => actions.read(w)}>
              <BookOpen />
              {t('auto.components.cloudWorkspaces.viewAsleep', 'View read-only copy')}
              <DropdownMenuShortcut>↵</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.open(w)}>
              <Play />
              {t('components.orcaCloud.read.wakeToContinue', 'Wake to continue')}
            </DropdownMenuItem>
          </>
        )}
        {canOpen && !isReadableAsleep(w) && (
          <DropdownMenuItem onSelect={() => actions.open(w)}>
            <ArrowUpRight />
            {t('auto.components.cloudWorkspaces.open', 'Open')}
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {canManage && (
          <>
            {members.length > 0 && <DropdownMenuSeparator />}
            {members.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UserRoundCog />
                  {t('auto.components.cloudWorkspaces.reassignOwner', 'Reassign owner')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className="w-56"
                  collisionPadding={SUBMENU_COLLISION_PADDING}
                >
                  {/* The list scrolls inside the submenu so the primitive keeps its own styling. */}
                  <div className="scrollbar-sleek max-h-72 overflow-y-auto">
                    <DropdownMenuRadioGroup
                      value={w.ownerUserId}
                      onValueChange={(ownerUserId) =>
                        ownerUserId !== w.ownerUserId && actions.patch(w, { ownerUserId })
                      }
                    >
                      {members.map((m) => (
                        <DropdownMenuRadioItem key={m.userId} value={m.userId}>
                          <MemberAvatar
                            userId={m.userId}
                            directory={directory}
                            selfId={selfId}
                            size="sm"
                          />
                          <span className="truncate">{m.name}</span>
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </div>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            {has('restart') && actions.restart ? (
              <DropdownMenuItem onSelect={() => actions.restart?.(w)}>
                <RotateCw />
                {t('orcaCloudWorkspace.restart', 'Restart')}
              </DropdownMenuItem>
            ) : null}
            {has('sleep') ? (
              <DropdownMenuItem onSelect={() => actions.sleep(w)}>
                <Moon />
                {t('auto.components.cloudWorkspaces.sleep', 'Sleep')}
              </DropdownMenuItem>
            ) : null}
            {w.archivedAt === null ? (
              <ArchiveSnapshotTooltip side="left">
                <DropdownMenuItem onSelect={() => actions.archive(w)}>
                  <Archive />
                  {t('auto.components.cloudWorkspaces.archive', 'Archive')}
                </DropdownMenuItem>
              </ArchiveSnapshotTooltip>
            ) : (
              <DropdownMenuItem onSelect={() => actions.unarchive(w)}>
                <ArchiveRestore />
                {t('auto.components.cloudWorkspaces.unarchive', 'Unarchive')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onSelect={() => actions.remove(w)}>
              <Trash2 />
              {t('auto.components.cloudWorkspaces.deleteWorkspace', 'Delete…')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
