import { useEffect, useState } from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

type BaseRefPickerProps = {
  repoId: string
  currentBaseRef?: string
  onSelect: (ref: string) => void
  onUsePrimary?: () => void
}

export function BaseRefPicker({
  repoId,
  currentBaseRef,
  onSelect,
  onUsePrimary
}: BaseRefPickerProps): React.JSX.Element {
  // Why: null until the IPC resolves (or when the repo has no default base ref
  // available). We avoid seeding with 'origin/main' because that would display
  // a fabricated default in repos that don't actually have origin/main.
  const [defaultBaseRef, setDefaultBaseRef] = useState<string | null>(null)
  // Why: starts at 0 so the multi-remote hint stays suppressed until the IPC
  // resolves. `0` is also the failure sentinel: if the main-process remote
  // count throws, we prefer no hint over a wrong hint (fail-closed per
  // docs/upstream-base-ref-design.md §4).
  const [remoteCount, setRemoteCount] = useState<number>(0)
  const [baseRefQuery, setBaseRefQuery] = useState('')
  const [baseRefResults, setBaseRefResults] = useState<string[]>([])
  const [isSearchingBaseRefs, setIsSearchingBaseRefs] = useState(false)

  useEffect(() => {
    let stale = false

    const loadDefaultBaseRef = async (): Promise<void> => {
      try {
        const result = await window.api.repos.getBaseRefDefault({ repoId })
        if (!stale) {
          setDefaultBaseRef(result.defaultBaseRef)
          setRemoteCount(result.remoteCount)
        }
      } catch {
        if (!stale) {
          setDefaultBaseRef(null)
          setRemoteCount(0)
        }
      }
    }

    setBaseRefQuery('')
    setBaseRefResults([])
    setRemoteCount(0)
    void loadDefaultBaseRef()

    return () => {
      stale = true
    }
  }, [repoId])

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
          repoId,
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
  }, [baseRefQuery, repoId])

  const effectiveBaseRef = currentBaseRef ?? defaultBaseRef

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">
            {effectiveBaseRef ?? 'No default base ref'}
          </div>
          <p className="text-xs text-muted-foreground">
            {currentBaseRef
              ? 'Pinned for this repo'
              : defaultBaseRef
                ? `Following primary branch (${defaultBaseRef})`
                : 'Pick a base branch below'}
          </p>
          {/* Why: passive hint that fork workflows have other remotes worth
              searching (e.g. `upstream`). Host-agnostic and remote-name-agnostic
              by design — we don't hardcode `upstream` because a repo's source
              remote could be named anything (`source`, `canonical`, etc.).
              Suppressed when remoteCount <= 1 or when the IPC failed
              (remoteCount === 0), preserving today's no-hint behavior.
              See docs/upstream-base-ref-design.md §4. */}
          {remoteCount > 1 ? (
            <p className="text-xs text-muted-foreground">
              This repo has multiple remotes. Type a remote name to filter branches (e.g. the remote
              that tracks the source project).
            </p>
          ) : null}
        </div>
        {onUsePrimary && (
          <Button variant="outline" size="sm" onClick={onUsePrimary} disabled={!currentBaseRef}>
            Use Primary
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <Input
          value={baseRefQuery}
          onChange={(e) => setBaseRefQuery(e.target.value)}
          placeholder="Search branches by name..."
          className="max-w-md"
        />
        <p className="text-xs text-muted-foreground">Type at least 2 characters.</p>
      </div>

      {isSearchingBaseRefs ? (
        <p className="text-xs text-muted-foreground">Searching branches...</p>
      ) : null}

      {!isSearchingBaseRefs && baseRefQuery.trim().length >= 2 ? (
        baseRefResults.length > 0 ? (
          <ScrollArea className="h-48 rounded-md border border-border/50">
            <div className="p-1">
              {baseRefResults.map((ref) => (
                <button
                  key={ref}
                  onClick={() => {
                    setBaseRefQuery(ref)
                    setBaseRefResults([])
                    onSelect(ref)
                  }}
                  className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60 ${
                    effectiveBaseRef === ref
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground'
                  }`}
                >
                  <span className="truncate">{ref}</span>
                  {effectiveBaseRef === ref ? (
                    <span className="text-[10px] uppercase tracking-[0.18em]">Current</span>
                  ) : null}
                </button>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <p className="text-xs text-muted-foreground">No matching branches found.</p>
        )
      ) : null}
    </div>
  )
}
