import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import {
  SSH_CONFIG_HOST_RESULT_LIMIT,
  type SshConfigHostSummary
} from '../../../../shared/ssh-types'
import { cn } from '@/lib/utils'

const EMPTY_CONFIG_HOSTS: SshConfigHostSummary[] = []

export function AddRemoteHostSshConfigPicker({
  hosts = EMPTY_CONFIG_HOSTS,
  totalHostCount = 0,
  newHostCount = 0,
  matchesTruncated = false,
  isLoading,
  isBulkImporting,
  resolvingAlias = null,
  loadError,
  onSelect,
  onQueryChange,
  onRetry,
  onBack,
  onAddAllToOrca
}: {
  hosts: SshConfigHostSummary[]
  totalHostCount: number
  newHostCount: number
  matchesTruncated: boolean
  isLoading: boolean
  isBulkImporting: boolean
  /** Alias whose `ssh -G` resolve is in flight; picking is frozen until it settles. */
  resolvingAlias: string | null
  loadError: string | null
  onSelect: (host: SshConfigHostSummary) => void
  onQueryChange: (query: string) => void
  onRetry: () => void
  onBack: () => void
  onAddAllToOrca: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const queryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (queryTimer.current) {
        clearTimeout(queryTimer.current)
      }
    },
    []
  )
  const isResolving = resolvingAlias != null
  // Why: filtering re-runs against a cached parse, so keep the field usable while a
  // refresh (or a failed load the user can retry) is outstanding.
  const filterDisabled = isBulkImporting || isResolving
  const picksDisabled = isBulkImporting || isResolving
  const canAddAll =
    !isLoading && !isBulkImporting && !isResolving && loadError == null && newHostCount > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <DialogHeader className="text-left">
        <DialogTitle>
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerTitle',
            'Choose from ~/.ssh/config'
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerDescription',
            'Pick a host to fill the form, or add every new host to Orca’s host list.'
          )}
        </DialogDescription>
      </DialogHeader>

      <Input
        value={query}
        onChange={(event) => {
          const value = event.target.value
          setQuery(value)
          if (queryTimer.current) {
            clearTimeout(queryTimer.current)
          }
          queryTimer.current = setTimeout(() => onQueryChange(value), 200)
        }}
        placeholder={translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerFilter',
          'Filter hosts…'
        )}
        autoFocus
        disabled={filterDisabled}
        aria-label={translate(
          'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerFilter',
          'Filter hosts…'
        )}
      />

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-card">
        {loadError != null ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onRetry}
              disabled={isLoading || isBulkImporting}
            >
              {translate(
                'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerRetry',
                'Try again'
              )}
            </Button>
          </div>
        ) : isLoading && hosts.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerLoading',
              'Reading ~/.ssh/config…'
            )}
          </p>
        ) : hosts.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              {totalHostCount === 0
                ? translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerEmpty',
                    'No hosts in ~/.ssh/config'
                  )
                : translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerNoMatch',
                    'No matching hosts'
                  )}
            </p>
            <p className="mt-1">
              {totalHostCount === 0
                ? translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerEmptyHint',
                    'Add a Host entry there, or go back and type the details manually.'
                  )
                : translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerNoMatchHint',
                    'Try another filter, or go back and type manually.'
                  )}
            </p>
          </div>
        ) : (
          // Why: these rows act on click and there is no selected row to track, so they stay
          // plain buttons rather than a listbox whose aria-selected would always be a lie.
          <ul
            aria-label={translate(
              'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerHostsLabel',
              'SSH config hosts'
            )}
            aria-busy={isLoading || isResolving}
            className={cn('divide-y divide-border/70', isLoading && 'opacity-60')}
          >
            {hosts.map((host) => (
              <li key={host.alias}>
                <button
                  type="button"
                  disabled={picksDisabled || host.alreadyInOrca}
                  className={cn(
                    'flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left',
                    'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                    'disabled:cursor-not-allowed disabled:opacity-50'
                  )}
                  onClick={() => onSelect(host)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{host.alias}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {host.username
                        ? `${host.username}@${host.hostname}:${host.port}`
                        : `${host.hostname}:${host.port}`}
                    </div>
                    {host.identityFile != null && host.identityFile !== '' ? (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
                        {host.identityFile}
                      </div>
                    ) : null}
                  </div>
                  {resolvingAlias === host.alias ? (
                    <span className="mt-0.5 shrink-0 text-[10.5px] text-muted-foreground">
                      {translate(
                        'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerResolving',
                        'Reading…'
                      )}
                    </span>
                  ) : host.alreadyInOrca ? (
                    <Badge
                      variant="outline"
                      className="mt-0.5 shrink-0 border-emerald-500/40 text-[10.5px] text-emerald-400"
                    >
                      {translate(
                        'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerInOrca',
                        'In Orca'
                      )}
                    </Badge>
                  ) : host.previouslyRemoved ? (
                    <Badge
                      variant="outline"
                      className="mt-0.5 shrink-0 text-[10.5px] text-muted-foreground"
                    >
                      {translate(
                        'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerPreviouslyRemoved',
                        'Removed from Orca'
                      )}
                    </Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {matchesTruncated ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerMoreResults',
            'Showing the first {{value0}} matches. Narrow your filter to find more.',
            { value0: SSH_CONFIG_HOST_RESULT_LIMIT }
          )}
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="secondary"
          disabled={!canAddAll}
          onClick={onAddAllToOrca}
          className="w-full sm:w-auto"
        >
          {isBulkImporting
            ? translate(
                'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerAddingAll',
                'Adding hosts…'
              )
            : newHostCount > 0
              ? translate(
                  'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerAddAll',
                  'Add all {{value0}} to Orca',
                  { value0: newHostCount }
                )
              : // Why: the remainder can be already-in-Orca or merely tombstoned, so the
                // label cannot claim either one specifically.
                totalHostCount > 0
                ? translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerNoNewHosts',
                    'No new hosts to add'
                  )
                : translate(
                    'auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerAddAllEmpty',
                    'Add all to Orca'
                  )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onBack}
          disabled={isBulkImporting}
          className="w-full sm:w-auto"
        >
          {translate('auto.components.sidebar.AddRemoteHostDialog.sshConfigPickerBack', 'Back')}
        </Button>
      </div>
    </div>
  )
}
