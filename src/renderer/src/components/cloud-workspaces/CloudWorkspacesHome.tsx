// Home: the org's cloud workspaces (registry on the control plane), filterable by who owns them,
// which repo they are in, Mine/Team and archived, grouped by section, with live presence and cost.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type {
  CloudWorkspace,
  CloudWorkspacePatch,
  CloudWorkspacePresence
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useOrgRoster } from '../billing/team/use-org-roster'
import { CloudWorkspaceRow } from './CloudWorkspaceRow'
import { NEW_SECTION } from './CloudWorkspaceRowMenu'
import { ANY, CloudWorkspacesToolbar, type CloudWorkspacesFilters } from './CloudWorkspacesToolbar'
import { EmptyState, ErrorState, NewSectionDialog, SkeletonRows } from './CloudWorkspacesStates'
import { CloudWorkspaceConfirmDialog, type PendingConfirm } from './CloudWorkspaceConfirmDialog'
import { formatUsdMicros, type MemberDirectory } from './cloud-workspace-format'
import { refreshCloudMessageSenders } from '@/lib/cloud-message-sender'
import { describeError } from './cloud-workspace-errors'
import { focusCloudChat } from './cloud-chat-focus'
import { frontCloudChat } from './cloud-workspace-links'
import {
  cloudWorkspaceTitle,
  copyCloudWorkspaceLink,
  openCloudWorkspace
} from './open-cloud-workspace'
import { useCloudWorkspaces, useCloudWorkspacesAvailable } from './use-cloud-workspaces'

const INITIAL_FILTERS: CloudWorkspacesFilters = {
  scope: 'team',
  by: ANY,
  repo: ANY,
  archived: false
}

function useMemberDirectory(orgId: string | undefined) {
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
    return { directory, canAdmin }
  }, [orgId, roster.result])
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
  const intlLocale = useIntlLocale()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const available = useCloudWorkspacesAvailable()
  const orgId = cloud?.activeOrgId
  const selfId = cloud?.userId ?? null
  const [filters, setFilters] = useState(INITIAL_FILTERS)
  const [opening, setOpening] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sectionFor, setSectionFor] = useState<CloudWorkspace | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const signIn = useAppStore((s) => s.connectCurrentOrcaProfile)
  const { directory, canAdmin } = useMemberDirectory(orgId)
  const scope = orgId ? filters.scope : 'mine'
  const { state, stale, reading, refresh, replace } = useCloudWorkspaces(
    { scope, archived: filters.archived ? 'only' : 'exclude' },
    Boolean(cloud)
  )

  // Relative "last active" times tick while the window is visible; hidden windows skip the work.
  useEffect(
    () => installWindowVisibilityInterval({ run: () => setNow(Date.now()), intervalMs: 30_000 }),
    []
  )

  const changeFilters = useCallback((next: Partial<CloudWorkspacesFilters>) => {
    setFilters((previous) => {
      // A different list (scope or archived) has different owners and repos; start unfiltered.
      const reset =
        (next.scope !== undefined && next.scope !== previous.scope) ||
        (next.archived !== undefined && next.archived !== previous.archived)
      return { ...previous, ...(reset ? { by: ANY, repo: ANY } : {}), ...next }
    })
  }, [])

  // A workspace being deleted (or gone) is not something to open or manage; Home leaves it out.
  const all = useMemo(
    () =>
      state.status === 'ready'
        ? state.workspaces.filter((w) => w.status !== 'destroying' && w.status !== 'destroyed')
        : [],
    [state]
  )
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
            (repo === ANY || w.repo?.url === repo))
      ),
    [all, by, repo, highlightId]
  )
  const highlighted = highlightId ? visible.find((w) => w.id === highlightId) : undefined
  const groups = useMemo(() => {
    const out = new Map<string, CloudWorkspace[]>()
    for (const w of visible) {
      const key = w.section ?? ''
      out.set(key, [...(out.get(key) ?? []), w])
    }
    return [...out.entries()].sort(([a], [b]) =>
      a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)
    )
  }, [visible])
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
  const totalCost = visible.reduce((sum, w) => sum + w.cost.totalUsdMicros, 0)

  /** Opens the workspace, then (going to a teammate's chat) the chat they have in front. */
  const open = useCallback(async (w: CloudWorkspace, chatId?: string | null) => {
    setOpening(w.id)
    try {
      const outcome = await openCloudWorkspace(w)
      if (!outcome.ok) {
        toast.error(outcome.message)
      } else if (chatId) {
        await focusCloudChat(outcome.worktreeId, chatId)
      }
    } finally {
      setOpening((current) => (current === w.id ? null : current))
    }
  }, [])

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
        toast.success(
          t('auto.components.cloudWorkspaces.sharedWithYourTeam', 'Shared with your team')
        )
      } else if (change.visibility === 'private') {
        toast.success(
          t(
            'auto.components.cloudWorkspaces.nowPrivate',
            'Now private. Teammates’ devices were disconnected.'
          )
        )
      } else if (change.ownerUserId) {
        toast.success(t('auto.components.cloudWorkspaces.ownerChanged', 'Owner changed'))
      } else if (change.archived !== undefined) {
        toast.success(
          change.archived
            ? t('auto.components.cloudWorkspaces.archived', 'Archived')
            : t('auto.components.cloudWorkspaces.restored', 'Restored')
        )
      }
      refresh()
    },
    [refresh, replace, t]
  )

  const actions = useMemo(
    () => ({
      open: (w: CloudWorkspace) => void open(w),
      copyLink: (w: CloudWorkspace) => {
        const front = frontCloudChat()
        void copyCloudWorkspaceLink(w.id, front?.sandboxId === w.id ? front.chatId : null)
      },
      copyWorkspaceLink: (w: CloudWorkspace) => void copyCloudWorkspaceLink(w.id),
      goToChat: (w: CloudWorkspace, member: CloudWorkspacePresence) => void open(w, member.chatId),
      patch: (w: CloudWorkspace, change: CloudWorkspacePatch) => void patch(w, change)
    }),
    [open, patch]
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
          state.status === 'ready'
            ? t('auto.components.cloudWorkspaces.listMeta', '{{count}} workspaces · {{cost}}', {
                count: visible.length,
                cost: formatUsdMicros(totalCost, intlLocale),
                defaultValue_one: '{{count}} workspace · {{cost}}'
              })
            : null
        }
        reading={reading}
        onRefresh={refresh}
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
          />
        )}
        {state.status === 'ready' &&
          groups.map(([section, rows], index) => {
            // Section names are free text (spaces), so the id uses the position instead.
            const headingId = `cloud-workspaces-section-${index}`
            const showHeading = groups.length > 1 || section !== ''
            return (
              <div key={section || '—'} className="py-0.5">
                {showHeading && (
                  <h3
                    id={headingId}
                    className="px-3 py-2 text-2xs font-medium text-muted-foreground"
                  >
                    {section || t('auto.components.cloudWorkspaces.noSection', 'No section')}
                    {/* The bare number is visual; screen readers get the counted phrase. */}
                    <span aria-hidden className="ml-1.5 tabular-nums text-muted-foreground">
                      {rows.length}
                    </span>{' '}
                    <span className="sr-only">
                      {t('auto.components.cloudWorkspaces.sectionCount', '{{count}} workspaces', {
                        count: rows.length,
                        defaultValue_one: '{{count}} workspace'
                      })}
                    </span>
                  </h3>
                )}
                <ul
                  role="list"
                  aria-labelledby={showHeading ? headingId : 'cloud-workspaces-heading'}
                >
                  {rows.map((w) => (
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
                    />
                  ))}
                </ul>
              </div>
            )
          })}
      </div>

      {/* Polite, so opening from a link is announced without stealing focus. */}
      <div aria-live="polite" className="sr-only">
        {highlighted
          ? t('auto.components.cloudWorkspaces.openedFromLink', 'Opened from link: {{title}}', {
              title: cloudWorkspaceTitle(highlighted, t)
            })
          : null}
      </div>

      {confirm && (
        <CloudWorkspaceConfirmDialog
          pending={confirm}
          directory={directory}
          selfId={selfId}
          canAdmin={canAdmin}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
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
