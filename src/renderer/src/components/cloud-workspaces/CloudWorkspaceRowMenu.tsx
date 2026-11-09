import React, { useRef } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  FolderInput,
  FolderPlus,
  Link2,
  Lock,
  MoreHorizontal,
  UserRoundCog,
  Users
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
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type {
  CloudWorkspace,
  CloudWorkspacePatch,
  CloudWorkspacePresence
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { MemberAvatar } from './CloudMemberAvatars'
import { memberName, presentMembers, type MemberDirectory } from './cloud-workspace-format'

export type RowActions = {
  open: (w: CloudWorkspace) => void
  /** The link to the chat you have in front when this workspace is in front, else the workspace. */
  copyLink: (w: CloudWorkspace) => void
  copyWorkspaceLink: (w: CloudWorkspace) => void
  /** One-time jump: open the workspace on the chat this teammate has in front. */
  goToChat: (w: CloudWorkspace, member: CloudWorkspacePresence) => void
  patch: (w: CloudWorkspace, patch: CloudWorkspacePatch) => void
}

/** Placeholder replaced by the inline section editor in CloudWorkspacesHome. */
export const NEW_SECTION = '\u0000new-section'
// Radio value for "no section"; section names are user text, so a control character cannot clash.
const NO_SECTION = '\u0000none'
// Keeps submenus off the window edge when the row sits near the bottom of Home.
const SUBMENU_COLLISION_PADDING = 8

export function CloudWorkspaceRowMenu({
  workspace: w,
  title,
  canOpen,
  canManage,
  sections,
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
  sections: string[]
  members: { userId: string; name: string }[]
  directory: MemberDirectory
  selfId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  actions: RowActions
}): React.JSX.Element {
  const t = useTranslate()
  const keybindings = useAppStore((state) => state.keybindings)
  const copyShortcut = formatOptionalPrimaryShortcutLabel('cloudWorkspace.copyLink', keybindings)
  const teammatesHere = canOpen
    ? presentMembers(w.presence, selfId).filter((p) => p.userId !== selfId)
    : []
  // Focus returns to ⋯ on close; after a mouse open that would leave a ring nobody asked for.
  const openedByPointer = useRef(false)
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
        {canOpen && (
          <DropdownMenuItem onSelect={() => actions.open(w)}>
            <ArrowUpRight />
            {t('auto.components.cloudWorkspaces.open', 'Open')}
            <DropdownMenuShortcut>↵</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => actions.copyLink(w)}>
          <Link2 />
          {t('auto.components.cloudWorkspaces.copyLink', 'Copy link')}
          {copyShortcut ? <DropdownMenuShortcut>{copyShortcut}</DropdownMenuShortcut> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => actions.copyWorkspaceLink(w)}>
          <Link2 />
          {t('auto.components.cloudWorkspaces.copyWorkspaceLink', 'Copy workspace link')}
        </DropdownMenuItem>
        {teammatesHere.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowUpRight />
              {t('auto.components.cloudWorkspaces.goToTeammateChat', "Go to a teammate's chat")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56" collisionPadding={SUBMENU_COLLISION_PADDING}>
              {teammatesHere.map((member) => (
                <DropdownMenuItem key={member.userId} onSelect={() => actions.goToChat(w, member)}>
                  <MemberAvatar
                    userId={member.userId}
                    directory={directory}
                    selfId={selfId}
                    size="sm"
                  />
                  <span className="truncate">
                    {t('auto.components.cloudWorkspaces.goToChat', "Go to {{value0}}'s chat", {
                      value0: memberName(directory, member.userId, selfId, t)
                    })}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {canManage && (
          <>
            <DropdownMenuSeparator />
            {w.visibility === 'private' ? (
              <DropdownMenuItem onSelect={() => actions.patch(w, { visibility: 'team' })}>
                <Users />
                {t('auto.components.cloudWorkspaces.shareWithTeam', 'Share with team')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => actions.patch(w, { visibility: 'private' })}>
                <Lock />
                {t('auto.components.cloudWorkspaces.makePrivate', 'Make private')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <FolderInput />
                {t('auto.components.cloudWorkspaces.moveToSection', 'Move to section')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48" collisionPadding={SUBMENU_COLLISION_PADDING}>
                <DropdownMenuRadioGroup
                  value={w.section ?? NO_SECTION}
                  onValueChange={(value) => {
                    const section = value === NO_SECTION ? null : value
                    if (section !== w.section) {
                      actions.patch(w, { section })
                    }
                  }}
                >
                  {sections.map((section) => (
                    <DropdownMenuRadioItem key={section} value={section}>
                      <span className="truncate">{section}</span>
                    </DropdownMenuRadioItem>
                  ))}
                  <DropdownMenuRadioItem value={NO_SECTION}>
                    {t('auto.components.cloudWorkspaces.noSection', 'No section')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => actions.patch(w, { section: NEW_SECTION })}>
                  <FolderPlus />
                  {t('auto.components.cloudWorkspaces.newSectionEllipsis', 'New section…')}
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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
            {w.archivedAt === null ? (
              <DropdownMenuItem onSelect={() => actions.patch(w, { archived: true })}>
                <Archive />
                {t('auto.components.cloudWorkspaces.archive', 'Archive')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => actions.patch(w, { archived: false })}>
                <ArchiveRestore />
                {t('auto.components.cloudWorkspaces.unarchive', 'Unarchive')}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
