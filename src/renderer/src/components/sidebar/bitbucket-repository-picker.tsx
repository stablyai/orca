import { useEffect, useRef, useState } from 'react'
import { ChevronsUpDown, Lock } from 'lucide-react'
import type {
  BitbucketRepositoryListResult,
  BitbucketRepositorySummary
} from '../../../../shared/bitbucket-repositories'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'

const SEARCH_DEBOUNCE_MS = 250

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; repositories: BitbucketRepositorySummary[] }
  | { status: 'error' }

// Web clients have no Bitbucket bridge and resolve to undefined.
function isListResult(value: unknown): value is BitbucketRepositoryListResult {
  return typeof value === 'object' && value !== null && 'ok' in value
}

// SSH needs no extra git credential setup once a key is registered with Bitbucket.
function preferredCloneUrl(repository: BitbucketRepositorySummary): string {
  return repository.sshCloneUrl ?? repository.httpsCloneUrl ?? ''
}

function useBitbucketConfigured(): boolean {
  const [configured, setConfigured] = useState(false)
  useEffect(() => {
    let cancelled = false
    void Promise.resolve<unknown>(window.api.bitbucket.status())
      .then((status) => {
        if (!cancelled) {
          setConfigured(
            typeof status === 'object' &&
              status !== null &&
              'configured' in status &&
              status.configured === true
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return configured
}

export function BitbucketRepositoryPicker({
  disabled,
  onSelect
}: {
  disabled?: boolean
  onSelect: (cloneUrl: string) => void
}): React.JSX.Element | null {
  const configured = useBitbucketConfigured()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const requestId = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }
    const id = ++requestId.current
    setState({ status: 'loading' })
    const timer = window.setTimeout(
      () => {
        void Promise.resolve<unknown>(window.api.bitbucket.listRepositories({ search }))
          .then((result) => {
            if (id !== requestId.current) {
              return
            }
            setState(
              isListResult(result) && result.ok
                ? { status: 'ready', repositories: result.repositories }
                : { status: 'error' }
            )
          })
          .catch(() => {
            if (id === requestId.current) {
              setState({ status: 'error' })
            }
          })
      },
      search ? SEARCH_DEBOUNCE_MS : 0
    )
    return () => window.clearTimeout(timer)
  }, [open, search])

  if (!configured) {
    return null
  }

  const select = (repository: BitbucketRepositorySummary): void => {
    onSelect(preferredCloneUrl(repository))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setSearch('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" role="combobox" aria-expanded={open} disabled={disabled}>
          {translate('components.sidebar.bitbucketRepositoryPicker.trigger', 'Browse Bitbucket')}
          <ChevronsUpDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={translate(
              'components.sidebar.bitbucketRepositoryPicker.search',
              'Search Bitbucket repositories'
            )}
          />
          <CommandList>
            {state.status === 'loading' ? (
              <div role="status" className="px-3 py-4 text-center text-xs text-muted-foreground">
                {translate('components.sidebar.bitbucketRepositoryPicker.loading', 'Loading…')}
              </div>
            ) : null}
            {state.status === 'error' ? (
              <div role="alert" className="px-3 py-4 text-center text-xs text-destructive">
                {translate(
                  'components.sidebar.bitbucketRepositoryPicker.error',
                  'Could not load repositories. Check your Bitbucket connection in Settings.'
                )}
              </div>
            ) : null}
            {state.status === 'ready' ? (
              <>
                <CommandEmpty>
                  {translate(
                    'components.sidebar.bitbucketRepositoryPicker.empty',
                    'No repositories found.'
                  )}
                </CommandEmpty>
                {state.repositories.map((repository) => (
                  <CommandItem
                    key={repository.fullName}
                    value={repository.fullName}
                    onSelect={() => select(repository)}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">{repository.fullName}</span>
                    {repository.isPrivate ? (
                      <Lock className="size-3 shrink-0 text-muted-foreground" />
                    ) : null}
                  </CommandItem>
                ))}
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
