// Home: the org's cloud workspaces (registry on the control plane), filterable by who owns them,
// which repo they are in, Mine/Team and archived, grouped by section, with live presence and cost.
import { useHomeWorkspaces } from './cloud-workspace-local-titles'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type {
  CloudWorkspace,
  CloudWorkspacePatch,
  CloudWorkspacePresence
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useOrgRoster } from '../billing/team/use-org-roster'
import { CloudWorkspaceRow } from './CloudWorkspaceRow'
import { CloudWorkspaceGroupView, rowDragProps } from './CloudWorkspaceGroup'
import { useCloudWorkspaceArrangement } from './use-cloud-workspace-arrangement'
import { NEW_SECTION } from './CloudWorkspaceRowMenu'
import {
  ANY,
  CloudWorkspacesToolbar,
  shouldShowCloudHomeArchivedOnly,
  shouldShowCloudHomeFilters
} from './CloudWorkspacesToolbar'
import { useHomeArchivedCount } from './use-cloud-archived-count'
import { EmptyState, ErrorState, NewSectionDialog, SkeletonRows } from './CloudWorkspacesStates'
import { useCloudHomeFilters } from './use-cloud-home-filters'
import { CloudWorkspaceConfirmDialog, type PendingConfirm } from './CloudWorkspaceConfirmDialog'
import { CloudReadSnapshotSheet } from './CloudReadSnapshotSheet'
import { useCloudReadPanel } from './use-cloud-read-panel'
import type { MemberDirectory } from './cloud-workspace-format'
import { refreshCloudMessageSenders } from '@/lib/cloud-message-sender'
import { describeError } from './cloud-workspace-errors'
import { toastSharedWithTeam } from './shared-with-team-toast'
import { focusCloudChat } from './cloud-chat-focus'
import * as homeArchive from './cloud-workspace-home-archive'
import { focusedKind, frontCloudChat } from './cloud-workspace-links'
import {
  cloudWorkspaceTitle,
  copyCloudWorkspaceLink,
  openCloudWorkspace
} from './open-cloud-workspace'
import { useCloudWorkspaces, useCloudWorkspacesAvailable } from './use-cloud-workspaces'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'

function useMemberDirectory(orgId: string | undefined, workspaces: readonly CloudWorkspace[]) {
  const roster = useOrgRoster(orgId ?? '')
  return useMemo(() => {
    const directory: MemberDirectory = new Map()
    let canAdmin = false
    if (orgId && roster.result?.status === 'ok') {
      for (const m of roster.result.roster.members) {
        if (m.userId) {
          directory.set(m.userId, { name: m.displayName || m.email, email: m.email })
        }
      }
      canAdmin =
        roster.result.roster.viewerRole === 'owner' || roster.result.roster.viewerRole === 'admin'
    }
    // Ids the roster does not cover (still loading, a dev org, a member who left) fall back to the
    // name each member's own token carries, as the control plane reports it.
    for (const w of workspaces) {
      for (const [userId, name] of Object.entries(w.memberNames ?? {})) {
        if (name && !directory.has(userId)) {
          directory.set(userId, { name, email: null })
        }
      }
    }
    return { directory, canAdmin }
  }, [orgId, roster.result, workspaces])
}

/** Whether Home has a cloud section to show (signed in and this build has a control plane). */
export function useCloudWorkspacesPresent(): boolean {
  const signedIn = useAppStore((s) => Boolean(s.orcaProfileAuthStatus?.cloud))
  return useCloudWorkspacesAvailable() === true && signedIn
}

export function CloudWorkspacesHome({
  highlightId
}: {
  highlightId?: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const available = useCloudWorkspacesAvailable()
  const orgId = cloud?.activeOrgId
  const selfId = cloud?.userId ?? null
  const account = useOrcaAccountKey()
  const { filters, changeFilters } = useCloudHomeFilters(account)
  const [opening, setOpening] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sectionFor, setSectionFor] = useState<CloudWorkspace | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const { readingId, readingRef, setReadingId, readWake, setReadWake } = useCloudReadPanel()
  const signIn = useAppStore((s) => s.connectCurrentOrcaProfile)
  const scope = orgId ? filters.scope : 'mine'
  const { state, stale, reading, refresh, replace } = useCloudWorkspaces(
    {
      scope,
      archived: filters.archived ? 'only' : 'exclude',
      ...(filters.routines ? { routines: 'include' as const } : {})
    },
    Boolean(cloud),
    account
  )

  // Relative "last active" times tick while the window is visible; hidden windows skip the work.
  useEffect(
    () => installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 }),
    []
  )

  // A workspace being deleted (or gone) is not something to open or manage; Home leaves it out.
  const all = useHomeWorkspaces(state.status === 'ready' ? state.workspaces : null)
  // ARCHIVE-REACH: archived ones are always reachable, however few workspaces are active.
  const { archivedRead, archivedCount } = useHomeArchivedCount({
    account,
    scope,
    shown: state.status === 'ready' && !stale ? all : null,
    archivedOn: filters.archived,
    enabled: Boolean(cloud)
  })
  const showFilters = shouldShowCloudHomeFilters(all.length, filters, Boolean(orgId))
  const { directory, canAdmin } = useMemberDirectory(orgId, all)
  const repos = useMemo(
    () => [...new Set(all.flatMap((w) => (w.repo ? [w.repo.url] : [])))].sort(),
    [all]
  )
  const owners = useMemo(() => [...new Set(all.map((w) => w.ownerUserId))], [all])
  const sections = useMemo(
    () => [...new Set(all.flatMap((w) => (w.section ? [w.section] : [])))].sort(),
    [all]
  )
  // Owner filtering only exists in the team view; a repo that left the list stops filtering.
  const by = scope === 'team' ? filters.by : ANY
  const repo = repos.includes(filters.repo) ? filters.repo : ANY
  // A row a link opened always shows, even when the owner/repo filters would hide it.
  const visible = useMemo(
    () =>
      all.filter(
        (w) =>
          w.id === highlightId ||
          ((by === ANY || w.ownerUserId === by || w.createdBy === by) &&
            (repo === ANY || w.repo?.url === repo) &&
            (!filters.running || w.status === 'running'))
      ),
    [all, by, repo, highlightId, filters.running]
  )
  const highlighted = highlightId ? visible.find((w) => w.id === highlightId) : undefined
  // Pinned first, then sections, in the order you arranged them on any of your devices.
  const arrangement = useCloudWorkspaceArrangement(visible)
  const { groups } = arrangement
  const members = useMemo(
    () =>
      [...directory.entries()].map(([userId, m]) => ({
        userId,
        name:
          userId === selfId
            ? t('auto.components.cloudWorkspaces.memberYou', '{{value0}} (you)', { value0: m.name })
            : m.name
      })),
    [directory, selfId, t]
  )
  const routineRuns = state.status === 'ready' ? state.routineRuns : undefined

  /** Opens the workspace, then (going to a teammate's chat) the chat they have in front. */
  const open = useCallback(
    async (w: CloudWorkspace, chatId?: string | null) => {
      setOpening(w.id)
      const fromPanel = readingRef.current === w.id
      if (fromPanel) {
        setReadWake({ phase: 'waking', startedAt: Date.now() })
      }
      try {
        const outcome = await openCloudWorkspace(w)
        if (!outcome.ok) {
          if (fromPanel && readingRef.current === w.id) {
            // The panel shows the failure in place (with the reason) instead of a toast.
            setReadWake({ ...outcome, phase: 'failed' })
          } else {
            toast.error(outcome.message)
          }
          return
        }
        // Woken from its read-only copy: the live workspace replaces it.
        setReadingId((current) => (current === w.id ? null : current))
        if (chatId) {
          await focusCloudChat(outcome.worktreeId, chatId)
        }
      } finally {
        setOpening((current) => (current === w.id ? null : current))
      }
    },
    [readingRef, setReadWake, setReadingId]
  )

  const patch = useCallback(
    async (w: CloudWorkspace, change: CloudWorkspacePatch, confirmed = false) => {
      if (change.section === NEW_SECTION) {
        setSectionFor(w)
        return
      }
      // Making private and handing over ownership take access away; both ask first.
      if (!confirmed && change.visibility === 'private') {
        setConfirm({ kind: 'private', workspace: w })
        return
      }
      if (!confirmed && change.ownerUserId) {
        setConfirm({ kind: 'owner', workspace: w, ownerUserId: change.ownerUserId })
        return
      }
      const result = await window.api.cloudWorkspaces.patch(w.id, change)
      if (!result.ok) {
        toast.error(describeError(result.error, result.reason, t))
        return
      }
      replace(result.value)
      if (change.visibility !== undefined) {
        // Shared or private changes whether messages there carry the sender line.
        void refreshCloudMessageSenders().catch(() => undefined)
      }
      if (change.visibility === 'team') {
        toastSharedWithTeam(t)
      } else if (change.visibility === 'private') {
        toast.success(
          t(
            'auto.components.cloudWorkspaces.nowPrivate',
            'Now private. Teammates’ devices were disconnected.'
          )
        )
      } else if (change.ownerUserId) {
        toast.success(t('auto.components.cloudWorkspaces.ownerChanged', 'Owner changed'))
      }
      refresh()
    },
    [refresh, replace, t]
  )

  const actions = useMemo(
    () => ({
      open: (w: CloudWorkspace) => void open(w),
      read: (w: CloudWorkspace) => setReadingId(w.id),
      copyLink: (w: CloudWorkspace) => void copyCloudWorkspaceLink(w.id),
      copyWorkspaceLink: (w: CloudWorkspace) => {
        const front = frontCloudChat()
        if (front?.sandboxId === w.id && front.chatId) {
          void copyCloudWorkspaceLink(w.id, front.chatId)
        }
      },
      focusedItem: (w: CloudWorkspace) => {
        const front = frontCloudChat()
        return front?.sandboxId === w.id ? focusedKind(front.chatId) : null
      },
      goToChat: (w: CloudWorkspace, member: CloudWorkspacePresence) => void open(w, member.chatId),
      patch: (w: CloudWorkspace, change: CloudWorkspacePatch) => void patch(w, change),
      setPinned: arrangement.pin,
      move: arrangement.move,
      ...homeArchive.homeArchiveActions({ selfId, t, refresh, confirmArchive: setConfirm })
    }),
    [open, patch, refresh, selfId, setReadingId, t, arrangement.pin, arrangement.move]
  )

  // Nothing (not even a skeleton) until we know this build has a control plane and you are in.
  if (available !== true || state.status === 'unavailable' || !cloud) {
    return null
  }

  return (
    <section aria-labelledby="cloud-workspaces-heading" className="w-full">
      <CloudWorkspacesToolbar
        filters={{ ...filters, by, repo }}
        onFiltersChange={changeFilters}
        hasOrg={Boolean(orgId)}
        owners={owners}
        repos={repos}
        directory={directory}
        selfId={selfId}
        metaStale={stale}
        meta={
          state.status === 'ready' && visible.length > 0
            ? // Why: no hours here. Empty: the empty card says so; no "0 workspaces" (JA-30). A sum over the listed workspaces isn't the team's month, and it
              // disagreed with Plan & billing and the account menu (JA-07).
              t('auto.components.cloudWorkspaces.listMetaCount', '{{count}} workspaces', {
                count: visible.length,
                defaultValue_one: '{{count}} workspace'
              })
            : null
        }
        reading={reading}
        onRefresh={refresh}
        routineRuns={routineRuns}
        showFilters={showFilters}
        archivedOnly={shouldShowCloudHomeArchivedOnly({
          showFilters,
          archivedCount,
          archivedOn: filters.archived,
          activeCount: all.length
        })}
        archivedCount={archivedCount}
      />

      <div
        aria-busy={stale || state.status === 'loading'}
        className={cn(
          'rounded-xl border border-border bg-card p-1 transition-opacity motion-reduce:transition-none',
          stale && 'opacity-60'
        )}
      >
        {state.status === 'loading' && <SkeletonRows />}
        {state.status === 'error' && (
          <ErrorState
            error={state.error}
            reason={state.reason}
            retrying={reading}
            onRetry={refresh}
            onSignIn={() => {
              void signIn().then(refresh)
            }}
          />
        )}
        {state.status === 'ready' && visible.length === 0 && (
          <EmptyState
            scope={scope}
            archived={filters.archived}
            filtered={by !== ANY || repo !== ANY}
            hasOrg={Boolean(orgId)}
            archivedCount={filters.archived ? 0 : (archivedRead ?? 0)}
            onShowArchived={() => changeFilters({ archived: true })}
          />
        )}
        {state.status === 'ready' &&
          groups.map((group, index) => {
            const sectionIndex = group.section
              ? arrangement.shownSections.indexOf(group.section)
              : -1
            return (
              <CloudWorkspaceGroupView
                key={group.key}
                group={group}
                index={index}
                showHeading={groups.length > 1 || group.kind !== 'none'}
                canMoveUp={sectionIndex > 0}
                canMoveDown={
                  sectionIndex >= 0 && sectionIndex < arrangement.shownSections.length - 1
                }
                onToggleCollapsed={(collapsed) =>
                  group.section && arrangement.toggleCollapsed(group.section, collapsed)
                }
                onMoveSection={(delta) =>
                  group.section && arrangement.moveSection(group.section, delta)
                }
              >
                {group.rows.map((w, rowIndex) => (
                  <CloudWorkspaceRow
                    key={w.id}
                    workspace={w}
                    directory={directory}
                    selfId={selfId}
                    canAdmin={canAdmin}
                    sections={sections}
                    members={members}
                    opening={opening === w.id}
                    highlighted={highlightId === w.id}
                    now={now}
                    actions={actions}
                    arrangement={arrangement.arrangementFor(group, rowIndex)}
                    dragProps={rowDragProps(arrangement.drag, group, w.id)}
                    dragging={arrangement.drag.dragging?.id === w.id}
                  />
                ))}
              </CloudWorkspaceGroupView>
            )
          })}
      </div>

      {/* Polite, so opening from a link is announced without stealing focus. */}
      <div aria-live="polite" className="sr-only">
        {arrangement.announcement}
      </div>
      <div aria-live="polite" className="sr-only">
        {highlighted
          ? t('auto.components.cloudWorkspaces.openedFromLink', 'Opened from link: {{title}}', {
              title: cloudWorkspaceTitle(highlighted, t)
            })
          : null}
      </div>

      <CloudReadSnapshotSheet
        // The list row (refreshed by polling) so a wake elsewhere shows up; gone rows close it.
        workspace={readingId ? (all.find((w) => w.id === readingId) ?? null) : null}
        wake={readWake}
        onWake={(w) => void open(w)}
        onClose={() => setReadingId(null)}
      />

      {confirm && (
        <CloudWorkspaceConfirmDialog
          pending={confirm}
          directory={directory}
          selfId={selfId}
          canAdmin={canAdmin}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === 'archive' || confirm.kind === 'delete') {
              setConfirm(null)
              homeArchive.runConfirmed(confirm, t, refresh)
              return
            }
            const change: CloudWorkspacePatch =
              confirm.kind === 'private'
                ? { visibility: 'private' }
                : { ownerUserId: confirm.ownerUserId }
            setConfirm(null)
            void patch(confirm.workspace, change, true)
          }}
        />
      )}

      {sectionFor && (
        <NewSectionDialog
          onCancel={() => setSectionFor(null)}
          onSubmit={(name) => {
            void patch(sectionFor, { section: name })
            setSectionFor(null)
          }}
        />
      )}
    </section>
  )
}
