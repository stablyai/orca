import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { aiVaultAgentLabel } from '../../../../shared/ai-vault-types'
import type { AiVaultProjectSuggestion } from '../../../../shared/ai-vault-project-suggestions'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  addSelectedProjectsLabel,
  dismissProjectSuggestionsLabel,
  projectSuggestionSessions,
  projectSuggestionsAddFailed,
  projectSuggestionsDescription,
  projectSuggestionsTitle
} from './ai-vault-project-suggestions-copy'

// Why local-only: the suggested path is registered on this desktop, so remote-host cwds don't apply.
function localSessionSources(sessions: readonly AiVaultSession[]) {
  return sessions.flatMap((s) =>
    s.executionHostId === LOCAL_EXECUTION_HOST_ID && s.cwd && !s.subagent
      ? [{ cwd: s.cwd, agent: s.agent }]
      : []
  )
}

export function AiVaultProjectSuggestions({
  sessions
}: {
  sessions: readonly AiVaultSession[]
}): React.JSX.Element | null {
  // Why paths, not a count: a catalog refresh can change a repo's path without changing the count.
  const repoPathsKey = useAppStore((s) =>
    s.repos
      .filter((repo) => !repo.connectionId)
      .map((repo) => repo.path)
      .sort()
      .join('\n')
  )
  const dismissed = useAppStore((s) => s.settings?.dismissedSessionProjectSuggestions)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const [suggestions, setSuggestions] = useState<AiVaultProjectSuggestion[]>([])
  const [unselected, setUnselected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failedNames, setFailedNames] = useState<string[]>([])
  // Why: an added project leaves the list only when the catalog refresh lands; hide it now so it cannot be added twice.
  const [addedPaths, setAddedPaths] = useState<ReadonlySet<string>>(new Set())
  const latestSources = useMemo(() => localSessionSources(sessions), [sessions])
  // Why a content key: every history refresh is a new array, and git discovery should rerun only
  // when the set of session folders actually changed.
  const sourcesKey = useMemo(
    () =>
      latestSources
        .map((source) => `${source.agent}\t${source.cwd}`)
        .sort()
        .join('\n'),
    [latestSources]
  )
  const sourcesRef = useRef(latestSources)
  useEffect(() => {
    sourcesRef.current = latestSources
  }, [latestSources])

  useEffect(() => {
    const sources = sourcesRef.current
    if (sources.length === 0) {
      setSuggestions([])
      return
    }
    let cancelled = false
    // Why wrapped: a host API without this method (older web/test shims) must mean "no suggestions".
    void Promise.resolve()
      .then(() => window.api.aiVault.suggestProjects({ sources }))
      .then((next) => {
        if (!cancelled) {
          setSuggestions(next)
          // Why prune, not clear: an added path stays hidden until a refresh stops suggesting it,
          // and a project removed later can be suggested again.
          setAddedPaths((current) => {
            const still = new Set(next.map((suggestion) => suggestion.path))
            const kept = [...current].filter((path) => still.has(path))
            return kept.length === current.size ? current : new Set(kept)
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSuggestions([])
        }
      })
    return () => {
      cancelled = true
    }
    // Why repoPathsKey/dismissed: a project added, moved or declined elsewhere must drop out of the card.
  }, [sourcesKey, repoPathsKey, dismissed])

  const visible = suggestions.filter((s) => !addedPaths.has(s.path))
  if (visible.length === 0) {
    return null
  }
  const selected = visible.filter((s) => !unselected.has(s.path))

  const toggle = (path: string): void => {
    setUnselected((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const addSelected = async (): Promise<void> => {
    setBusy(true)
    const failed: string[] = []
    const added: string[] = []
    try {
      // Why per item: one repo that can't be added must not stop the rest.
      for (const suggestion of selected) {
        try {
          if (
            !(
              // Why pinned local: suggestions are this desktop's folders even when a remote runtime is focused.
              (await addRepoPath(suggestion.path, 'git', { runtimeEnvironmentId: null }))
            )
          ) {
            failed.push(suggestion.name)
          } else {
            added.push(suggestion.path)
          }
        } catch {
          failed.push(suggestion.name)
        }
      }
    } finally {
      setAddedPaths((current) => new Set([...current, ...added]))
      setFailedNames(failed)
      setBusy(false)
    }
  }

  const dismissSelected = async (): Promise<void> => {
    setBusy(true)
    try {
      await updateSettings({
        dismissedSessionProjectSuggestions: [
          ...new Set([...(dismissed ?? []), ...selected.map((s) => s.path)])
        ]
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-sidebar-border px-3 py-2 text-xs">
      <div className="font-medium text-foreground">{projectSuggestionsTitle(visible.length)}</div>
      <p className="mt-0.5 text-muted-foreground">{projectSuggestionsDescription()}</p>
      <ul className="mt-2 space-y-1.5">
        {visible.map((suggestion) => (
          <li key={suggestion.path} className="flex items-start gap-2">
            <Checkbox
              className="mt-0.5"
              checked={!unselected.has(suggestion.path)}
              onCheckedChange={() => toggle(suggestion.path)}
              aria-label={suggestion.name}
            />
            <div className="min-w-0">
              <div className="truncate text-foreground" title={suggestion.path}>
                {suggestion.name}
              </div>
              <div className="truncate text-muted-foreground">
                {projectSuggestionSessions(
                  suggestion.sessionCount,
                  suggestion.agents.map(aiVaultAgentLabel).join(', ')
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {failedNames.length > 0 ? (
        <p className="mt-2 text-destructive">
          {projectSuggestionsAddFailed(failedNames.join(', '))}
        </p>
      ) : null}
      <div className="mt-2 flex gap-2">
        <Button
          size="xs"
          disabled={busy || selected.length === 0}
          onClick={() => void addSelected()}
        >
          {addSelectedProjectsLabel(selected.length)}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || selected.length === 0}
          onClick={() => void dismissSelected()}
        >
          {dismissProjectSuggestionsLabel()}
        </Button>
      </div>
    </div>
  )
}
