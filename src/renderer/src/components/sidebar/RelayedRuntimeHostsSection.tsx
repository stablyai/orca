import React from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, GitBranch, Server } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { branchName } from '@/lib/git-utils'
import { selectRelayedRuntimeHostOwners } from '@/store/slices/relayed-runtime-hosts'
import type {
  RelayedRuntimeHost,
  RelayedRuntimeHostOwner,
  RelayedWorkspaceRow
} from '@/runtime/relayed-runtime-hosts'

function workspaceLabel(row: RelayedWorkspaceRow): string {
  return row.displayName.trim() || branchName(row.branch) || row.repo
}

function RelayedWorkspaceItem({ row }: { row: RelayedWorkspaceRow }): React.JSX.Element {
  const Icon = row.workspaceKind === 'folder-workspace' ? Folder : GitBranch
  const label = workspaceLabel(row)
  const branch = branchName(row.branch)
  return (
    <li
      data-testid="relayed-runtime-workspace"
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate text-foreground">{label}</span>
      {branch && branch !== label ? (
        <span className="min-w-0 shrink truncate text-2xs">{branch}</span>
      ) : null}
    </li>
  )
}

function RelayedHost({ host }: { host: RelayedRuntimeHost }): React.JSX.Element {
  return (
    <div data-testid="relayed-runtime-host">
      <div className="flex h-7 min-w-0 items-center gap-1.5 px-1">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate text-[12px] font-semibold leading-none">
          {host.label}
        </div>
      </div>
      {host.worktrees === null ? (
        <div className="truncate px-2 pb-1 text-2xs text-muted-foreground">
          {translate('sidebar.relayedHosts.workspacesUnknown', 'Workspaces not loaded yet')}
        </div>
      ) : host.worktrees.length === 0 ? (
        <div className="truncate px-2 pb-1 text-2xs text-muted-foreground">
          {translate('sidebar.relayedHosts.noWorkspaces', 'No workspaces')}
        </div>
      ) : (
        <ul className="flex flex-col">
          {host.worktrees.map((row) => (
            <RelayedWorkspaceItem key={row.worktreeId} row={row} />
          ))}
        </ul>
      )}
    </div>
  )
}

function RelayedOwner({ owner }: { owner: RelayedRuntimeHostOwner }): React.JSX.Element | null {
  if (owner.state === 'listed' && owner.hosts.length === 0) {
    return null
  }
  return (
    <div data-testid="relayed-runtime-host-owner" className="[&+&]:pt-2">
      <h3 className="truncate px-1 pt-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {translate('sidebar.relayedHosts.title', "On {{owner}}'s servers", {
          owner: owner.label
        })}
      </h3>
      {owner.state === 'unavailable' ? (
        <div className="truncate px-1 pb-1 text-2xs text-muted-foreground">
          {translate('sidebar.relayedHosts.unavailable', "Couldn't read {{owner}}'s servers", {
            owner: owner.label
          })}
        </div>
      ) : (
        // Host ids are unique within an owner; the owner block scopes them.
        owner.hosts.map((host) => <RelayedHost key={host.hostId} host={host} />)
      )}
    </div>
  )
}

/** Managed servers a paired server relays this computer to, listed read-only until opening them from here lands. */
export function RelayedRuntimeHostsList({
  owners
}: {
  owners: readonly RelayedRuntimeHostOwner[]
}): React.JSX.Element | null {
  const listsHosts = owners.some((owner) => owner.state === 'listed' && owner.hosts.length > 0)
  if (!listsHosts && !owners.some((owner) => owner.state === 'unavailable')) {
    return null
  }
  return (
    <section
      data-testid="relayed-runtime-hosts"
      aria-label={translate('sidebar.relayedHosts.label', 'Servers your paired servers manage')}
      className="max-h-[40%] shrink-0 overflow-y-auto border-t border-worktree-sidebar-border px-2 py-1.5 scrollbar-sleek"
    >
      {owners.map((owner) => (
        <RelayedOwner key={owner.environmentId} owner={owner} />
      ))}
      {listsHosts ? (
        <p className="px-1 pt-1 text-2xs text-muted-foreground">
          {translate(
            'sidebar.relayedHosts.readOnly',
            'Opening these from this computer is coming in a later update; use the server or your phone.'
          )}
        </p>
      ) : null}
    </section>
  )
}

const RelayedRuntimeHostsSection = React.memo(function RelayedRuntimeHostsSection() {
  // Own language subscription: this memo boundary would otherwise keep the boot language.
  useTranslation()
  // Owners whose pairing or relay capability went away drop out here, before the next read.
  const owners = useAppStore(useShallow(selectRelayedRuntimeHostOwners))
  return <RelayedRuntimeHostsList owners={owners} />
})

export default RelayedRuntimeHostsSection
