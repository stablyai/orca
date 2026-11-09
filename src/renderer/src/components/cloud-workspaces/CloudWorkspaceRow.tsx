import React, { useEffect, useId, useRef, useState } from 'react'
import { GitBranch, Loader2, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { type Translate, useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { CloudStateDot } from '../orca-cloud/CloudStateDot'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { MemberAvatar, PresenceStack } from './CloudMemberAvatars'
import { CloudWorkspaceRowMenu, type RowActions } from './CloudWorkspaceRowMenu'
import {
  formatSandboxHours,
  formatRelative,
  formatUsdMicros,
  memberName,
  presenceSummary,
  presentMembers,
  repoLabel,
  sandboxHours,
  type MemberDirectory
} from './cloud-workspace-format'
import { cloudWorkspaceTitle } from './open-cloud-workspace'

/** The shared Orca Cloud dot vocabulary (shape and tone), same as the sidebar and panel. */
function dotState(w: CloudWorkspace): CloudDotState {
  if (w.archivedAt !== null) {
    return 'archived'
  }
  switch (w.status) {
    case 'running':
      return 'running'
    case 'creating':
    case 'resuming':
      return 'waking'
    case 'suspending':
    case 'suspended':
      return 'sleeping'
    case 'failed':
      return 'failed'
    case 'destroying':
    case 'destroyed':
      return 'unresponsive'
  }
}

/** Glossary lifecycle states only: a sandbox going to sleep already reads as Asleep. */
function statusLabel(w: CloudWorkspace, t: Translate): string {
  if (w.archivedAt !== null) {
    return t('auto.components.cloudWorkspaces.statusArchived', 'Archived')
  }
  switch (w.status) {
    case 'running':
      return t('auto.components.cloudWorkspaces.statusRunning', 'Running')
    case 'creating':
      return t('auto.components.cloudWorkspaces.statusStarting', 'Starting')
    case 'resuming':
      return t('auto.components.cloudWorkspaces.statusWaking', 'Waking')
    case 'suspending':
    case 'suspended':
      return t('auto.components.cloudWorkspaces.statusAsleep', 'Asleep')
    case 'failed':
      return t('auto.components.cloudWorkspaces.statusCouldntStart', "Couldn't start")
    case 'destroying':
    case 'destroyed':
      // Home never lists these (see CloudWorkspacesHome); a stray one is not usable.
      return t('auto.components.cloudWorkspaces.statusNotResponding', 'Not responding')
  }
}

export function CloudWorkspaceRow({
  workspace: w,
  directory,
  selfId,
  canAdmin,
  sections,
  members,
  opening,
  highlighted,
  now,
  actions
}: {
  workspace: CloudWorkspace
  directory: MemberDirectory
  selfId: string | null
  canAdmin: boolean
  sections: string[]
  members: { userId: string; name: string }[]
  opening: boolean
  highlighted: boolean
  now: number
  actions: RowActions
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const descriptionId = useId()
  const [menuOpen, setMenuOpen] = useState(false)
  const status = statusLabel(w, t)
  const archived = w.archivedAt !== null
  const showStatus = archived || w.status !== 'running'
  const canManage = w.access === 'owner' || canAdmin
  const title = cloudWorkspaceTitle(w, t)
  const ownerName = memberName(directory, w.ownerUserId, selfId, t)
  const rowRef = useRef<HTMLLIElement>(null)
  // A link brought this row up: make sure it is on screen (the tint fades on its own).
  useEffect(() => {
    if (highlighted) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlighted])
  const canOpen = w.access !== 'none'
  const cost = formatUsdMicros(w.cost.totalUsdMicros, intlLocale)
  const lastActive = formatRelative(w.lastActivityAt, now, t, intlLocale)
  const presence = presenceSummary(
    presentMembers(w.presence, selfId),
    directory,
    selfId,
    t,
    intlLocale
  )
  const revealOpen = opening || menuOpen
  const visibility =
    w.visibility === 'private'
      ? t('auto.components.cloudWorkspaces.private', 'Private')
      : t('auto.components.cloudWorkspaces.sharedWithTeam', 'Shared with team')
  const description = presence
    ? t(
        'auto.components.cloudWorkspaces.rowDescriptionWithPresence',
        'Cost {{cost}}. Last active {{lastActive}}. {{visibility}}. {{presence}}.',
        { cost, lastActive, visibility, presence }
      )
    : t(
        'auto.components.cloudWorkspaces.rowDescription',
        'Cost {{cost}}. Last active {{lastActive}}. {{visibility}}.',
        {
          cost,
          lastActive,
          visibility
        }
      )

  return (
    <li
      ref={rowRef}
      data-cloud-workspace-row=""
      onKeyDown={(event) => {
        // Menu items render in a portal but still bubble through React; only this row's own DOM counts.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) {
          return
        }
        if (
          keybindingMatchesAction(
            'cloudWorkspace.copyLink',
            event.nativeEvent,
            getShortcutPlatform(),
            useAppStore.getState().keybindings
          )
        ) {
          event.preventDefault()
          actions.copyLink(w)
        }
      }}
      className={cn(
        'group relative isolate flex items-center gap-3 rounded-lg pr-2 transition-colors hover:bg-accent',
        menuOpen && 'bg-accent'
      )}
    >
      {/* Opened from a link: an accent tint that fades out (instantly under reduced motion). */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-0 -z-10 rounded-lg bg-accent opacity-0 motion-safe:transition-opacity motion-safe:duration-[2s]',
          highlighted && 'opacity-100'
        )}
      />
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => actions.open(w)}
        aria-label={
          w.ownerUserId === selfId
            ? t('auto.components.cloudWorkspaces.rowLabelOwnedByYou', '{{title}}, {{status}}, owned by you', {
                title,
                status
              })
            : t('auto.components.cloudWorkspaces.rowLabel', '{{value0}}, {{value1}}, owned by {{value2}}', {
                value0: title,
                value1: status,
                value2: ownerName
              })
        }
        aria-describedby={descriptionId}
        className="flex min-w-0 flex-1 cursor-default items-center gap-3 rounded-lg py-2 pl-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
      >
        <span
          role="img"
          aria-label={status}
          className={cn('inline-flex shrink-0', archived && 'opacity-60')}
        >
          <CloudStateDot state={dotState(w)} size="md" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            {/* Archived rows dim only the title and dot, so cost, time and actions stay legible. */}
            <span
              className={cn(
                'truncate text-sm font-medium',
                archived ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {title}
            </span>
            {w.visibility === 'private' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Lock
                    role="img"
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-label={t('auto.components.cloudWorkspaces.private', 'Private')}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">
                  {w.ownerUserId === selfId
                    ? t('auto.components.cloudWorkspaces.privateTooltipYou', 'Private — only you can see it')
                    : t('auto.components.cloudWorkspaces.privateTooltip', 'Private — only {{name}} can open it', {
                        name: ownerName
                      })}
                </TooltipContent>
              </Tooltip>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <MemberAvatar userId={w.ownerUserId} directory={directory} selfId={selfId} size="sm" />
            <span className="shrink-0">{ownerName}</span>
            {showStatus && (
              <>
                <span aria-hidden>·</span>
                <span
                  className={cn(
                    'shrink-0',
                    !archived && w.status === 'failed' && 'text-destructive',
                    !archived &&
                      (w.status === 'destroying' || w.status === 'destroyed') &&
                      'text-status-warning-text'
                  )}
                >
                  {status}
                </span>
              </>
            )}
            {w.repo && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{repoLabel(w.repo.url)}</span>
                {w.repo.branch && (
                  <span className="flex min-w-0 items-center gap-0.5 truncate font-mono text-2xs">
                    <GitBranch className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{w.repo.branch}</span>
                  </span>
                )}
              </>
            )}
          </span>
        </span>
      </button>

      <PresenceStack
        presence={w.presence}
        directory={directory}
        selfId={selfId}
        onGoToChat={canOpen ? (member) => actions.goToChat(w, member) : undefined}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">{cost}</span>
        </TooltipTrigger>
        <TooltipContent side="top">
          <div className="font-medium">{t('auto.components.cloudWorkspaces.cost', 'Cost')}</div>
          <div>
            {t(
              'auto.components.cloudWorkspaces.sandboxHoursCost',
              '{{hours}} sandbox hours × {{rate}}/hour = {{cost}}',
              {
                count: sandboxHours(w.cost.computeMs),
                hours: formatSandboxHours(w.cost.computeMs, intlLocale),
                rate: formatUsdMicros(w.cost.rateUsdMicrosPerHour, intlLocale),
                cost: formatUsdMicros(w.cost.computeUsdMicros, intlLocale),
                defaultValue_one: '{{hours}} sandbox hour × {{rate}}/hour = {{cost}}'
              }
            )}
          </div>
          {w.cost.tokenUsdMicros !== null && (
            <div>
              {t('auto.components.cloudWorkspaces.modelTokensCost', 'Model tokens {{value0}}', {
                value0: formatUsdMicros(w.cost.tokenUsdMicros, intlLocale)
              })}
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      {/* Last activity, with Open fading in over the same slot on hover or keyboard focus. */}
      <span className="relative flex w-20 shrink-0 items-center justify-end">
        <span
          className={cn(
            'text-xs tabular-nums text-muted-foreground transition-opacity motion-reduce:transition-none',
            canOpen &&
              (revealOpen ? 'opacity-0' : 'group-focus-within:opacity-0 group-hover:opacity-0')
          )}
        >
          {lastActive}
        </span>
        {canOpen && (
          <span
            className={cn(
              'absolute inset-y-0 right-0 flex items-center transition-opacity motion-reduce:transition-none',
              revealOpen
                ? 'opacity-100'
                : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
            )}
          >
            {/* Mouse affordance only: the row button already opens (one tab stop per action). */}
            <Button
              size="xs"
              variant="outline"
              tabIndex={-1}
              aria-hidden
              disabled={opening}
              onClick={() => actions.open(w)}
            >
              {opening ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : null}
              {opening
                ? t('auto.components.cloudWorkspaces.opening', 'Opening')
                : t('auto.components.cloudWorkspaces.open', 'Open')}
            </Button>
          </span>
        )}
      </span>
      <CloudWorkspaceRowMenu
        workspace={w}
        title={title}
        canOpen={canOpen}
        canManage={canManage}
        sections={sections}
        members={members}
        directory={directory}
        selfId={selfId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        actions={actions}
      />
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </li>
  )
}
