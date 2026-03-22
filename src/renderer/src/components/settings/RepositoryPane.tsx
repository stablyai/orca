import { useEffect, useState } from 'react'
import type { OrcaHooks, Repo, RepoHookSettings } from '../../../../shared/types'
import { REPO_COLORS } from '../../../../shared/constants'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Trash2 } from 'lucide-react'
import { HookEditor } from './HookEditor'
import { DEFAULT_REPO_HOOK_SETTINGS } from './SettingsConstants'
import type { HookName } from './SettingsConstants'

type RepositoryPaneProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  updateRepo: (repoId: string, updates: Partial<Repo>) => void
  removeRepo: (repoId: string) => void
}

export function RepositoryPane({
  repo,
  yamlHooks,
  updateRepo,
  removeRepo
}: RepositoryPaneProps): React.JSX.Element {
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null)
  const [defaultBaseRef, setDefaultBaseRef] = useState('origin/main')
  const [baseRefQuery, setBaseRefQuery] = useState('')
  const [baseRefResults, setBaseRefResults] = useState<string[]>([])
  const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false)

  useEffect(() => {
    let stale = false

    const loadDefaultBaseRef = async (repoId: string) => {
      try {
        const result = await window.api.repos.getBaseRefDefault({ repoId })
        if (stale) {
          return
        }
        setDefaultBaseRef(result)
      } catch {
        if (stale) {
          return
        }
        setDefaultBaseRef('origin/main')
      }
    }

    setBaseRefQuery('')
    setBaseRefResults([])
    void loadDefaultBaseRef(repo.id)

    return () => {
      stale = true
    }
  }, [repo.id])

  useEffect(() => {
    const trimmedQuery = baseRefQuery.trim()
    if (trimmedQuery.length < 2) {
      setBaseRefResults([])
      setIsSearchingBaseRefs(false)
      return
    }

    let stale = false
    setIsSearchingBaseRefs(true)

    const timer = window.setTimeout(() => {
      void window.api.repos
        .searchBaseRefs({
          repoId: repo.id,
          query: trimmedQuery,
          limit: 20
        })
        .then((results) => {
          if (!stale) {
            setBaseRefResults(results)
          }
        })
        .catch(() => {
          if (!stale) {
            setBaseRefResults([])
          }
        })
        .finally(() => {
          if (!stale) {
            setIsSearchingBaseRefs(false)
          }
        })
    }, 200)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [repo.id, baseRefQuery])

  const effectiveBaseRef = repo.worktreeBaseRef ?? defaultBaseRef

  const handleRemoveRepo = (repoId: string) => {
    if (confirmingRemove === repoId) {
      removeRepo(repoId)
      setConfirmingRemove(null)
      return
    }

    setConfirmingRemove(repoId)
  }

  const updateSelectedRepoHookSettings = (
    updates: Omit<Partial<RepoHookSettings>, 'scripts'> & {
      scripts?: Partial<RepoHookSettings['scripts']>
    }
  ) => {
    const nextSettings: RepoHookSettings = {
      ...DEFAULT_REPO_HOOK_SETTINGS,
      ...repo.hookSettings,
      ...updates,
      scripts: {
        ...DEFAULT_REPO_HOOK_SETTINGS.scripts,
        ...repo.hookSettings?.scripts,
        ...updates.scripts
      }
    }

    updateRepo(repo.id, {
      hookSettings: nextSettings
    })
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">Identity</h2>
            <p className="text-xs text-muted-foreground">
              Repo-specific display details for the sidebar and tabs.
            </p>
          </div>

          <Button
            variant={confirmingRemove === repo.id ? 'destructive' : 'outline'}
            size="sm"
            onClick={() => handleRemoveRepo(repo.id)}
            onBlur={() => setConfirmingRemove(null)}
            className="gap-2"
          >
            <Trash2 className="size-3.5" />
            {confirmingRemove === repo.id ? 'Confirm Remove' : 'Remove Repo'}
          </Button>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Display Name</Label>
          <Input
            value={repo.displayName}
            onChange={(e) =>
              updateRepo(repo.id, {
                displayName: e.target.value
              })
            }
            className="h-9 text-sm"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Badge Color</Label>
          <div className="flex flex-wrap gap-2">
            {REPO_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => updateRepo(repo.id, { badgeColor: color })}
                className={`size-7 rounded-full transition-all ${
                  repo.badgeColor === color
                    ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
                    : 'hover:ring-1 hover:ring-muted-foreground hover:ring-offset-2 hover:ring-offset-background'
                }`}
                style={{ backgroundColor: color }}
                title={color}
              />
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">Default Worktree Base</Label>
          <div className="rounded-xl border bg-background/80 p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-foreground">{effectiveBaseRef}</div>
                <p className="text-xs text-muted-foreground">
                  {repo.worktreeBaseRef
                    ? 'Pinned for this repo'
                    : `Following primary branch (${defaultBaseRef})`}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBaseRefQuery('')
                  setBaseRefResults([])
                  updateRepo(repo.id, {
                    worktreeBaseRef: undefined
                  })
                }}
                disabled={!repo.worktreeBaseRef}
              >
                Use Primary
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              <Input
                value={baseRefQuery}
                onChange={(e) => setBaseRefQuery(e.target.value)}
                placeholder="Search branches by name..."
                className="max-w-md"
              />
              <p className="text-xs text-muted-foreground">Type at least 2 characters.</p>
            </div>

            {isSearchingBaseRefs ? (
              <p className="mt-3 text-xs text-muted-foreground">Searching branches...</p>
            ) : null}

            {!isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (
              baseRefResults.length > 0 ? (
                <ScrollArea className="mt-3 h-48 rounded-md border">
                  <div className="p-1">
                    {baseRefResults.map((ref) => (
                      <button
                        key={ref}
                        onClick={() => {
                          setBaseRefQuery(ref)
                          setBaseRefResults([])
                          updateRepo(repo.id, {
                            worktreeBaseRef: ref
                          })
                        }}
                        className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                          repo.worktreeBaseRef === ref
                            ? 'bg-accent text-accent-foreground'
                            : 'text-foreground'
                        }`}
                      >
                        <span className="truncate">{ref}</span>
                        {repo.worktreeBaseRef === ref ? (
                          <span className="text-[10px] uppercase tracking-[0.18em]">Current</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">No matching branches found.</p>
              )
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            New worktrees default to the repo primary branch unless you pin a different base here.
          </p>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Hook Source</h2>
          <p className="text-xs text-muted-foreground">
            Auto prefers `orca.yaml` when present, then falls back to the UI script. Override
            ignores YAML and only uses the UI script.
          </p>
        </div>

        <div className="flex w-fit gap-1 rounded-xl border p-1">
          {(['auto', 'override'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => updateSelectedRepoHookSettings({ mode })}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                repo.hookSettings?.mode === mode
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {mode === 'auto' ? 'Use YAML First' : 'Override in UI'}
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
          {yamlHooks ? (
            <div className="space-y-2">
              <p className="font-medium text-foreground">YAML hooks detected in `orca.yaml`</p>
              <div className="flex flex-wrap gap-2">
                {(['setup', 'archive'] as HookName[]).map((hookName) =>
                  yamlHooks.scripts[hookName] ? (
                    <span
                      key={hookName}
                      className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300"
                    >
                      {hookName}
                    </span>
                  ) : null
                )}
              </div>
            </div>
          ) : (
            <p>No YAML hooks detected for this repo.</p>
          )}
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Lifecycle Hooks</h2>
          <p className="text-xs text-muted-foreground">
            Write scripts directly in the UI. Each repo stores its own setup and archive hook
            script.
          </p>
        </div>

        <div className="space-y-4">
          {(['setup', 'archive'] as HookName[]).map((hookName) => (
            <HookEditor
              key={hookName}
              hookName={hookName}
              repo={repo}
              yamlHooks={yamlHooks}
              onScriptChange={(script) =>
                updateSelectedRepoHookSettings({
                  scripts: hookName === 'setup' ? { setup: script } : { archive: script }
                })
              }
            />
          ))}
        </div>
      </section>
    </div>
  )
}
