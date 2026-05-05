/* eslint-disable max-lines -- Why: project picker handles pinned, recent, browse-all listing, paste-to-add, view selection, and accessibility-related orchestration in one place to keep the entry-point flow coherent. */
// Why: the picker is the only v1 entry point for switching projects (no
// header tab strip). Pinned + Recent come from settings; Browse all lazy-loads
// from `listAccessibleProjects` and is cached for 5 minutes. Paste-to-add
// accepts org/user project URLs and `owner/number` shorthand.
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, Copy, Loader, Pin, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import type {
  GitHubProjectOwnerType,
  GitHubProjectSettings,
  GitHubProjectSummary,
  GitHubProjectViewError,
  GitHubProjectViewSummary
} from '../../../../shared/github-project-types'

export type ResolvedProjectSelection = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  viewId?: string
}

type Props = {
  activeProject: {
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    title?: string
  } | null
  onSelect: (selection: ResolvedProjectSelection) => void
}

const BROWSE_CACHE_TTL_MS = 5 * 60_000
let browseCache: {
  fetchedAt: number
  projects: GitHubProjectSummary[]
  partialFailures?: { owner: string; message: string }[]
} | null = null

export default function ProjectPicker({ activeProject, onSelect }: Props): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const projectSettings: GitHubProjectSettings = settings?.githubProjects ?? {
    pinned: [],
    recent: [],
    lastViewByProject: {},
    activeProject: null
  }

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<GitHubProjectViewError | null>(null)
  const [browseProjects, setBrowseProjects] = useState<GitHubProjectSummary[]>(
    () => browseCache?.projects ?? []
  )
  // Why: partial-failures are cached alongside projects so dismissing the
  // popover and reopening within the 5min window doesn't flicker the
  // banner back. Populated only when discovery succeeded but a subset of
  // orgs failed (the 504 path the user reported).
  const [partialFailures, setPartialFailures] = useState<{ owner: string; message: string }[]>(
    () => browseCache?.partialFailures ?? []
  )
  const [pasteInput, setPasteInput] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)

  // View-pick step state.
  const [viewPickFor, setViewPickFor] = useState<ResolvedProjectSelection | null>(null)
  const [viewList, setViewList] = useState<GitHubProjectViewSummary[]>([])
  const [viewLoading, setViewLoading] = useState(false)

  const loadBrowse = useCallback(async () => {
    if (browseCache && Date.now() - browseCache.fetchedAt < BROWSE_CACHE_TTL_MS) {
      setBrowseProjects(browseCache.projects)
      setPartialFailures(browseCache.partialFailures ?? [])
      return
    }
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const res = await window.api.gh.listAccessibleProjects()
      if (res.ok) {
        browseCache = {
          fetchedAt: Date.now(),
          projects: res.projects,
          partialFailures: res.partialFailures
        }
        setBrowseProjects(res.projects)
        setPartialFailures(res.partialFailures ?? [])
      } else {
        setBrowseError(res.error)
      }
    } catch (err) {
      setBrowseError({
        type: 'unknown',
        message: err instanceof Error ? err.message : 'Failed to list projects'
      })
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && !viewPickFor) {
      void loadBrowse()
    }
  }, [open, viewPickFor, loadBrowse])

  const updateProjectSettings = useCallback(
    async (mutate: (prev: GitHubProjectSettings) => GitHubProjectSettings) => {
      const prev = projectSettings
      const next = mutate(prev)
      // Why: settings deep-merges only notifications; write the full
      // githubProjects object so sibling fields (pinned/recent/lastView/active)
      // are not clobbered by a partial write.
      await updateSettings({ githubProjects: next })
    },
    [projectSettings, updateSettings]
  )

  const commitSelection = useCallback(
    async (selection: ResolvedProjectSelection, title: string | null) => {
      const key = `${selection.ownerType}:${selection.owner}:${selection.projectNumber}`
      await updateProjectSettings((prev) => {
        const recent = [
          {
            owner: selection.owner,
            ownerType: selection.ownerType,
            number: selection.projectNumber,
            lastOpenedAt: new Date().toISOString()
          },
          ...prev.recent.filter((r) => `${r.ownerType}:${r.owner}:${r.number}` !== key)
        ].slice(0, 10)
        const lastViewByProject = { ...prev.lastViewByProject }
        if (selection.viewId) {
          lastViewByProject[key] = { viewId: selection.viewId }
        }
        return {
          ...prev,
          recent,
          lastViewByProject,
          activeProject: {
            owner: selection.owner,
            ownerType: selection.ownerType,
            number: selection.projectNumber
          }
        }
      })
      onSelect(selection)
      setOpen(false)
      setQuery('')
      setViewPickFor(null)
      void title
    },
    [onSelect, updateProjectSettings]
  )

  const handleChooseProject = useCallback(
    async (selection: {
      owner: string
      ownerType: GitHubProjectOwnerType
      number: number
      title?: string
      // Why: when the paste resolver parsed a /views/{n} URL, the caller
      // passes the view number through so we can skip the view-pick step
      // and commit directly once listProjectViews returns the matching id.
      viewNumber?: number
    }) => {
      const key = `${selection.ownerType}:${selection.owner}:${selection.number}`
      const lastView = projectSettings.lastViewByProject[key]?.viewId
      // Why: an explicit viewNumber from the URL takes precedence over the
      // remembered last view — the user's intent (paste this exact view) wins
      // over the heuristic (re-open the last view they used).
      if (lastView && selection.viewNumber === undefined) {
        await commitSelection(
          {
            owner: selection.owner,
            ownerType: selection.ownerType,
            projectNumber: selection.number,
            viewId: lastView
          },
          selection.title ?? null
        )
        return
      }
      // No prior view (or explicit viewNumber from URL) — load views.
      setViewPickFor({
        owner: selection.owner,
        ownerType: selection.ownerType,
        projectNumber: selection.number
      })
      setViewLoading(true)
      try {
        const res = await window.api.gh.listProjectViews({
          owner: selection.owner,
          ownerType: selection.ownerType,
          projectNumber: selection.number
        })
        if (res.ok) {
          setViewList(res.views)
          if (selection.viewNumber !== undefined) {
            // Why: the URL pinned a specific view number — find its id and
            // commit directly, bypassing the view-pick step. If the number
            // doesn't match any view (deleted/renumbered), fall through to
            // the picker so the user can choose another view.
            const match = res.views.find((v) => v.number === selection.viewNumber)
            if (match) {
              await commitSelection(
                {
                  owner: selection.owner,
                  ownerType: selection.ownerType,
                  projectNumber: selection.number,
                  viewId: match.id
                },
                selection.title ?? null
              )
            }
          }
        } else {
          setViewList([])
          toast.error(res.error.message)
        }
      } catch (err) {
        // Why: IPC transport errors (channel disconnect, serialization
        // failure) propagate as rejected promises and would otherwise become
        // unhandled rejections — leaving the picker stuck on the view-pick
        // step with a perpetual spinner. Treat as an empty result and toast
        // a transport-level message so the user can retry or paste again.
        setViewList([])
        toast.error(`Failed to load views: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setViewLoading(false)
      }
    },
    [commitSelection, projectSettings.lastViewByProject]
  )

  const handlePaste = useCallback(async () => {
    const parsed = parseProjectInput(pasteInput.trim())
    if (!parsed) {
      setPasteError('Expected a project URL or owner/number')
      return
    }
    setPasteError(null)
    setPasteBusy(true)
    try {
      const res = await window.api.gh.resolveProjectRef({ input: pasteInput.trim() })
      if (!res.ok) {
        setPasteError(res.error.message)
        return
      }
      setPasteInput('')
      await handleChooseProject({
        owner: res.owner,
        ownerType: res.ownerType,
        number: res.number,
        title: res.title,
        // Why: forward the parsed view number from /views/{n} URLs so the
        // chooser can skip the view-pick step and commit directly.
        ...(res.viewNumber !== undefined ? { viewNumber: res.viewNumber } : {})
      })
    } finally {
      setPasteBusy(false)
    }
  }, [handleChooseProject, pasteInput])

  const filteredBrowse = useMemo(() => {
    const q = query.trim().toLowerCase()
    const pinnedKeys = new Set(
      projectSettings.pinned.map((p) => `${p.ownerType}:${p.owner}:${p.number}`)
    )
    const recentKeys = new Set(
      projectSettings.recent.map((r) => `${r.ownerType}:${r.owner}:${r.number}`)
    )
    return browseProjects.filter((p) => {
      const key = `${p.ownerType}:${p.owner}:${p.number}`
      if (pinnedKeys.has(key) || recentKeys.has(key)) {
        return false
      }
      if (!q) {
        return true
      }
      return (
        p.title.toLowerCase().includes(q) ||
        p.owner.toLowerCase().includes(q) ||
        String(p.number).includes(q)
      )
    })
  }, [browseProjects, projectSettings.pinned, projectSettings.recent, query])

  const buttonLabel = activeProject
    ? `${activeProject.owner} / ${activeProject.title ?? `#${activeProject.number}`}`
    : 'Choose a project'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 border-border/50 bg-transparent text-xs"
        >
          <span className="truncate">{buttonLabel}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[360px] p-0" align="start">
        {viewPickFor ? (
          <ViewPickStep
            loading={viewLoading}
            views={viewList}
            onPick={async (view) => {
              await commitSelection({ ...viewPickFor, viewId: view.id }, null)
            }}
            onBack={() => setViewPickFor(null)}
          />
        ) : (
          <div className="flex flex-col">
            <div className="border-b border-border/50 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects"
                  className="h-8 pl-7 text-xs"
                />
              </div>
            </div>
            {browseError ? <AuthErrorBanner error={browseError} /> : null}
            {!browseError && partialFailures.length > 0 ? (
              <PartialFailuresBanner failures={partialFailures} />
            ) : null}
            <div className="max-h-[340px] overflow-y-auto p-1">
              {projectSettings.pinned.length > 0 ? (
                <Section label="Pinned">
                  {projectSettings.pinned.map((p) => {
                    const key = `${p.ownerType}:${p.owner}:${p.number}`
                    const knownGood = projectSettings.lastViewByProject[key]?.viewId != null
                    const match = browseProjects.find(
                      (bp) => `${bp.ownerType}:${bp.owner}:${bp.number}` === key
                    )
                    return (
                      <PickerRow
                        key={key}
                        title={match?.title ?? `#${p.number}`}
                        subtitle={`${p.owner}`}
                        zombie={!knownGood}
                        onClick={() =>
                          handleChooseProject({
                            owner: p.owner,
                            ownerType: p.ownerType,
                            number: p.number,
                            title: match?.title
                          })
                        }
                        onRemovePin={async () => {
                          await updateProjectSettings((prev) => ({
                            ...prev,
                            pinned: prev.pinned.filter(
                              (x) => `${x.ownerType}:${x.owner}:${x.number}` !== key
                            )
                          }))
                        }}
                      />
                    )
                  })}
                </Section>
              ) : null}
              {projectSettings.recent.length > 0 ? (
                <Section label="Recent">
                  {projectSettings.recent
                    .filter(
                      (r) =>
                        !projectSettings.pinned.some(
                          (p) =>
                            p.ownerType === r.ownerType &&
                            p.owner === r.owner &&
                            p.number === r.number
                        )
                    )
                    .map((r) => {
                      const key = `${r.ownerType}:${r.owner}:${r.number}`
                      const match = browseProjects.find(
                        (bp) => `${bp.ownerType}:${bp.owner}:${bp.number}` === key
                      )
                      const pinnable = projectSettings.lastViewByProject[key]?.viewId != null
                      return (
                        <PickerRow
                          key={key}
                          title={match?.title ?? `#${r.number}`}
                          subtitle={r.owner}
                          canPin={pinnable}
                          onPin={async () => {
                            await updateProjectSettings((prev) => ({
                              ...prev,
                              pinned: [
                                ...prev.pinned,
                                { owner: r.owner, ownerType: r.ownerType, number: r.number }
                              ].slice(0, 20)
                            }))
                          }}
                          onClick={() =>
                            handleChooseProject({
                              owner: r.owner,
                              ownerType: r.ownerType,
                              number: r.number,
                              title: match?.title
                            })
                          }
                        />
                      )
                    })}
                </Section>
              ) : null}
              <Section label={browseLoading ? 'Browse all (loading…)' : 'Browse all'}>
                {browseLoading ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                    <Loader className="size-3 animate-spin" /> Loading…
                  </div>
                ) : null}
                {filteredBrowse.map((p) => (
                  <PickerRow
                    key={`${p.ownerType}:${p.owner}:${p.number}`}
                    title={p.title}
                    subtitle={p.owner}
                    onClick={() =>
                      handleChooseProject({
                        owner: p.owner,
                        ownerType: p.ownerType,
                        number: p.number,
                        title: p.title
                      })
                    }
                  />
                ))}
              </Section>
            </div>
            <div className="border-t border-border/50 p-2">
              <div className="flex gap-2">
                <Input
                  value={pasteInput}
                  onChange={(e) => {
                    setPasteInput(e.target.value)
                    setPasteError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void handlePaste()
                    }
                  }}
                  placeholder="Add by URL or owner/number"
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  onClick={() => void handlePaste()}
                  disabled={pasteBusy || !pasteInput.trim()}
                  className="h-8"
                >
                  Add
                </Button>
              </div>
              {pasteError ? (
                <div className="mt-1 text-[11px] text-destructive">{pasteError}</div>
              ) : null}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Section({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="py-1">
      <div className="px-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

function PickerRow({
  title,
  subtitle,
  onClick,
  zombie,
  canPin,
  onPin,
  onRemovePin
}: {
  title: string
  subtitle: string
  onClick: () => void
  zombie?: boolean
  canPin?: boolean
  onPin?: () => void
  onRemovePin?: () => void
}): React.JSX.Element {
  return (
    <div className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
      <button type="button" onClick={onClick} className="flex flex-1 min-w-0 flex-col text-left">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-[10px] text-muted-foreground">{subtitle}</span>
      </button>
      {zombie ? (
        <div className="flex items-center gap-1">
          <AlertTriangle className="size-3.5 text-amber-500" />
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onRemovePin}
          >
            Remove pin
          </button>
        </div>
      ) : null}
      {canPin ? (
        <button
          type="button"
          title="Pin"
          className="opacity-0 group-hover:opacity-100"
          onClick={onPin}
        >
          <Pin className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function ViewPickStep({
  loading,
  views,
  onPick,
  onBack
}: {
  loading: boolean
  views: GitHubProjectViewSummary[]
  onPick: (view: GitHubProjectViewSummary) => void | Promise<void>
  onBack: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border/50 p-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back
        </button>
        <span className="text-xs font-medium">Choose a view</span>
        <span />
      </div>
      <div className="max-h-[340px] overflow-y-auto p-1">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
            <Loader className="size-3 animate-spin" /> Loading views…
          </div>
        ) : views.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No views found.</div>
        ) : (
          views.map((v) => {
            const supported = v.layout === 'TABLE_LAYOUT'
            return (
              <button
                key={v.id}
                type="button"
                disabled={!supported}
                onClick={() => void onPick(v)}
                className={cn(
                  'flex w-full flex-col items-start rounded px-2 py-1 text-left',
                  supported ? 'hover:bg-muted/50' : 'cursor-not-allowed opacity-50'
                )}
              >
                <span className="text-sm">{v.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {v.layout === 'TABLE_LAYOUT'
                    ? 'Table'
                    : v.layout === 'BOARD_LAYOUT'
                      ? 'Board (unsupported)'
                      : 'Roadmap (unsupported)'}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function PartialFailuresBanner({
  failures
}: {
  failures: { owner: string; message: string }[]
}): React.JSX.Element {
  // Why: a single generic sentence is preferable to enumerating every failed
  // owner inline — the list is unbounded and the user only needs to know
  // (1) their list is incomplete and (2) paste-to-add is the escape hatch.
  // Hover exposes the underlying error messages for debugging.
  const summary =
    failures.length === 1 && failures[0].owner !== '*'
      ? `Couldn't load projects from ${failures[0].owner}.`
      : `Some organizations didn't load (${failures.length}).`
  const detail = failures
    .map((f) => `${f.owner === '*' ? 'orgs' : f.owner}: ${f.message}`)
    .join('\n')
  return (
    <div
      className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
      title={detail}
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
        <div>
          <div>{summary}</div>
          <div className="mt-0.5 text-[11px] opacity-80">
            Paste a project URL below to reach missing ones.
          </div>
        </div>
      </div>
    </div>
  )
}

function AuthErrorBanner({ error }: { error: GitHubProjectViewError }): React.JSX.Element {
  const command =
    error.type === 'auth_required'
      ? 'gh auth login'
      : error.type === 'scope_missing'
        ? 'gh auth refresh -s project -s read:org -s repo'
        : null
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
      <div>{error.message}</div>
      {command ? (
        <button
          type="button"
          onClick={async () => {
            try {
              await window.api.ui.writeClipboardText(command)
              toast.success('Command copied')
            } catch {
              toast.error('Failed to copy')
            }
          }}
          className="mt-1 inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
        >
          <Copy className="size-3" /> Copy command
        </button>
      ) : null}
    </div>
  )
}

function parseProjectInput(
  input: string
): { owner: string; number: number; viewNumber?: number } | null {
  if (!input) {
    return null
  }
  // owner/number
  const short = /^([A-Za-z0-9][A-Za-z0-9-]*)\/(\d+)$/.exec(input)
  if (short) {
    return { owner: short[1], number: Number(short[2]) }
  }
  try {
    const url = new URL(input)
    if (url.hostname !== 'github.com') {
      return null
    }
    const parts = url.pathname.split('/').filter(Boolean)
    // /orgs/{owner}/projects/{n} or /users/{owner}/projects/{n}[/views/{viewNumber}]
    if ((parts[0] === 'orgs' || parts[0] === 'users') && parts[2] === 'projects' && parts[3]) {
      const owner = parts[1]
      const number = Number(parts[3])
      if (Number.isNaN(number)) {
        return null
      }
      let viewNumber: number | undefined
      if (parts[4] === 'views' && parts[5]) {
        const v = Number(parts[5])
        if (!Number.isNaN(v)) {
          viewNumber = v
        }
      }
      return { owner, number, viewNumber }
    }
  } catch {
    return null
  }
  return null
}
