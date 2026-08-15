import { useState } from 'react'
import { ChevronsUpDown, Github, Loader2, LockKeyhole, RefreshCw } from 'lucide-react'
import type { GitHubRepositoryCatalogItem } from '../../../../shared/github-repository-catalog'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

export function GitHubRepositoryPicker({
  currentUrl,
  disabled,
  onSelect
}: {
  currentUrl: string
  disabled: boolean
  onSelect: (url: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [repositories, setRepositories] = useState<GitHubRepositoryCatalogItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadRepositories = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setRepositories(await window.api.gh.listRepositories())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }

  const prefersSsh = /^(?:ssh:\/\/|[^@\s]+@[^:\s]+:)/.test(currentUrl.trim())

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen && repositories === null && !loading) {
          void loadRepositories()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
        >
          <Github className="size-3.5" />
          {translate(
            'auto.components.settings.GitHubRepositoryPicker.dbbe08840d',
            'Choose from GitHub'
          )}
          <ChevronsUpDown className="size-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] max-w-[85vw] p-0">
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.components.settings.GitHubRepositoryPicker.35722ed29c',
              'Search repositories…'
            )}
          />
          <CommandList className="max-h-80">
            {loading ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"
              >
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                {translate(
                  'auto.components.settings.GitHubRepositoryPicker.610e020ba9',
                  'Loading GitHub repositories…'
                )}
              </div>
            ) : error ? (
              <div role="alert" className="space-y-3 px-4 py-5 text-center">
                <p className="text-xs text-destructive">{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadRepositories()}
                >
                  <RefreshCw className="size-3.5" />
                  {translate('auto.components.settings.GitHubRepositoryPicker.f22b38fcca', 'Retry')}
                </Button>
              </div>
            ) : (
              <>
                <CommandEmpty>
                  {translate(
                    'auto.components.settings.GitHubRepositoryPicker.b306b325d2',
                    'No repositories found.'
                  )}
                </CommandEmpty>
                {(repositories ?? []).map((repository) => (
                  <CommandItem
                    key={repository.nameWithOwner}
                    value={`${repository.nameWithOwner} ${repository.description ?? ''}`}
                    onSelect={() => {
                      onSelect(prefersSsh ? repository.sshUrl : repository.httpsUrl)
                      setOpen(false)
                    }}
                    className="items-start gap-2.5 py-2.5"
                  >
                    <Github className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-sm font-medium">
                          {repository.nameWithOwner}
                        </span>
                        {repository.isPrivate ? (
                          <>
                            <LockKeyhole
                              aria-hidden="true"
                              className="size-3 shrink-0 text-muted-foreground"
                            />
                            <span className="sr-only">
                              {translate(
                                'auto.components.settings.GitHubRepositoryPicker.f1cd6dcccf',
                                'Private repository'
                              )}
                            </span>
                          </>
                        ) : null}
                      </span>
                      {repository.description ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {repository.description}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
