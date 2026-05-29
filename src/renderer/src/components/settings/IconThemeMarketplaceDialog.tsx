import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, Loader2, Search, Store } from 'lucide-react'
import type { MarketplaceIconTheme, StoredUserIconTheme } from '../../../../preload/api-types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/dialog'
import { Input } from '../ui/input'
import { registerUserIconTheme } from '@/lib/icon-themes'

type Props = {
  /** Called with the registered theme id when the user installs one. */
  onInstalled: (themeId: string) => void
  /** Set of theme ids already present locally so we can show "Installed". */
  installedIds: Set<string>
  /** Optional trigger override; defaults to a "Browse marketplace" outline button. */
  trigger?: React.ReactNode
}

function makeInstalledId(publisher: string, name: string): string {
  const id = `${publisher}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return id === 'default' ? 'user-default' : id
}

export function IconThemeMarketplaceDialog({
  onInstalled,
  installedIds,
  trigger
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MarketplaceIconTheme[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installingKey, setInstallingKey] = useState<string | null>(null)
  const searchTokenRef = useRef(0)

  const runSearch = useCallback(async (q: string): Promise<void> => {
    setError(null)
    setLoading(true)
    const token = ++searchTokenRef.current
    try {
      const list = (await window.api.iconThemes.searchMarketplace(q)) as MarketplaceIconTheme[]
      if (searchTokenRef.current !== token) {
        return
      }
      // Why: Open VSX ignores the query for category=Themes and always returns
      // the same popular results. We filter client-side so the user actually
      // sees relevant results when they type a search term.
      const trimmed = q.trim().toLowerCase()
      const filtered = trimmed
        ? list.filter((ext) => {
            const haystack = `${ext.displayName} ${ext.description} ${ext.publisher}`.toLowerCase()
            return trimmed.split(/\s+/).every((word) => haystack.includes(word))
          })
        : list
      setResults(filtered)
    } catch (err) {
      if (searchTokenRef.current !== token) {
        return
      }
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (searchTokenRef.current === token) {
        setLoading(false)
      }
    }
  }, [])

  // Why: trigger a default search when the dialog first opens so the user sees
  // the most-popular icon themes (Material, vscode-icons, Seti, etc.) without
  // having to type anything.
  useEffect(() => {
    if (open && results.length === 0 && !loading) {
      void runSearch('')
    }
  }, [open, results.length, loading, runSearch])

  const handleInstall = async (ext: MarketplaceIconTheme): Promise<void> => {
    const key = `${ext.publisher}.${ext.name}`
    setInstallingKey(key)
    setError(null)
    try {
      const stored = (await window.api.iconThemes.installFromMarketplace({
        publisher: ext.publisher,
        name: ext.name,
        downloadUrl: ext.downloadUrl,
        displayName: ext.displayName
      })) as StoredUserIconTheme
      const name = (stored.json?.name as string | undefined) ?? stored.sourceFolderName
      const registered = registerUserIconTheme({
        id: stored.id,
        name,
        shape: stored.json
      })
      if (!registered) {
        await window.api.iconThemes.remove(stored.id)
        setError(
          `Downloaded ${ext.displayName}, but the icon-theme JSON could not be parsed. The extension may not actually contribute an icon theme.`
        )
        return
      }
      onInstalled(stored.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstallingKey(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <Store className="mr-1 size-3" />
            Browse marketplace…
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Browse icon themes</DialogTitle>
          <DialogDescription>
            Install a VS Code icon theme from the Open VSX marketplace. The .vsix is downloaded and
            unpacked on this machine — no extension host runs.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch(query)
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search icon themes…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-7"
              autoFocus
            />
          </div>
          <Button type="submit" size="sm" disabled={loading}>
            {loading ? <Loader2 className="size-3 animate-spin" /> : 'Search'}
          </Button>
        </form>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="scrollbar-sleek max-h-[420px] space-y-1 overflow-y-auto rounded-md border border-border/50 p-1">
          {loading && results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No results yet. Try a different query.
            </p>
          ) : (
            results.map((ext) => {
              const key = `${ext.publisher}.${ext.name}`
              const isInstalled = installedIds.has(makeInstalledId(ext.publisher, ext.name))
              const isInstalling = installingKey === key
              return (
                <div key={key} className="flex items-start gap-3 rounded-md p-2 hover:bg-muted/40">
                  {ext.iconUrl ? (
                    <img
                      src={ext.iconUrl}
                      alt=""
                      className="size-10 shrink-0 rounded bg-muted object-contain"
                      loading="lazy"
                    />
                  ) : (
                    <div className="size-10 shrink-0 rounded bg-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate text-sm font-medium">{ext.displayName}</p>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {ext.publisher} · v{ext.version}
                      </span>
                    </div>
                    <p className="line-clamp-2 text-xs text-muted-foreground">{ext.description}</p>
                    {ext.downloadCount > 0 ? (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {ext.downloadCount.toLocaleString()} downloads
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={isInstalled ? 'ghost' : 'outline'}
                    disabled={isInstalled || isInstalling}
                    onClick={() => void handleInstall(ext)}
                    className="shrink-0"
                  >
                    {isInstalled ? (
                      <>
                        <Check className="mr-1 size-3" />
                        Installed
                      </>
                    ) : isInstalling ? (
                      <>
                        <Loader2 className="mr-1 size-3 animate-spin" />
                        Installing…
                      </>
                    ) : (
                      <>
                        <Download className="mr-1 size-3" />
                        Install
                      </>
                    )}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
