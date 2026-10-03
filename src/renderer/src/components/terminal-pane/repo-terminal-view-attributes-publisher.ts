/**
 * Renderer→main `pty:repoTerminalViewAttributes` publication: the per-project
 * counterpart of the app-global snapshot in terminal-view-attributes-publisher,
 * keyed by execution host then repo id, so hidden PTYs on this host and on SSH
 * hosts answer OSC 10/11 (from their owner) and OSC 4/12 and ?996n (from
 * main's responder) with the project's terminal theme, not the global one.
 */
import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { RepoTerminalViewAttributesPayload } from '../../../../shared/terminal-view-attributes'
import type { TerminalViewAttributesRepo } from '../../../../shared/terminal-view-attributes-composition'
import {
  resolveRepoTerminalViewAttributesByHost,
  type RepoTerminalViewAttributesByHost
} from '../../../../shared/repo-terminal-view-attributes-by-host'
import {
  getSystemPrefersDarkSnapshot,
  subscribeToSystemPrefersDarkChange
} from './use-system-prefers-dark'

export type RepoTerminalViewAttributesSource = {
  settings: GlobalSettings | null | undefined
  repos: readonly TerminalViewAttributesRepo[]
}

/** Why shared: main pre-loads the same map from persisted projects before this publishes. */
export function composeRepoTerminalViewAttributesByHost(
  source: RepoTerminalViewAttributesSource,
  systemPrefersDark: boolean
): RepoTerminalViewAttributesByHost {
  if (!source.settings) {
    return {}
  }
  return resolveRepoTerminalViewAttributesByHost(source.settings, source.repos, systemPrefersDark)
}

let lastPublishedSnapshot: string | null = null

type RepoTerminalViewAttributesSend = 'sent' | 'no-bridge'

function sendViaPreload(
  payload: RepoTerminalViewAttributesPayload
): RepoTerminalViewAttributesSend {
  // Guarded: unit tests and the web client run without the preload bridge.
  if (typeof window === 'undefined' || !window.api?.pty?.publishRepoTerminalViewAttributes) {
    return 'no-bridge'
  }
  window.api.pty.publishRepoTerminalViewAttributes(payload)
  return 'sent'
}

/** Publishes the per-host project map once per actual change (JSON-deduped). */
export function publishRepoTerminalViewAttributes(
  byHostId: RepoTerminalViewAttributesByHost,
  send: (
    payload: RepoTerminalViewAttributesPayload
  ) => RepoTerminalViewAttributesSend = sendViaPreload
): 'published' | 'deduped' | 'no-bridge' {
  const serialized = JSON.stringify(byHostId)
  if (serialized === lastPublishedSnapshot) {
    return 'deduped'
  }
  if (send({ byHostId }) === 'no-bridge') {
    // Not recorded: a later call with a working bridge must still publish.
    return 'no-bridge'
  }
  lastPublishedSnapshot = serialized
  return 'published'
}

type RepoPublisherPhase = 'awaiting-catalog' | 'settling' | 'armed' | 'disposed'

/** Why store-driven, not pane-driven: repo themes must reach main for PTYs with no mounted
 *  pane (hidden tabs, parked worktrees, background/CLI launches). */
export function installRepoTerminalViewAttributesPublisher(): () => void {
  // Why gated on a settled LOCAL catalog fetch: a reloaded renderer's pre-hydration `{}` would wipe
  // main's (and a surviving daemon's or relay's) map and every hidden themed PTY's OSC SET overlays
  // until repos load. That fetch is the persisted catalog, so it carries SSH projects too.
  let phase: RepoPublisherPhase = 'awaiting-catalog'
  let failedGeneration = 0
  const publish = (): void => {
    const state = useAppStore.getState()
    // Why: settings go null mid-session (runtime focus switch); an empty map there is not "no themes".
    if (phase !== 'armed' || !state.settings) {
      return
    }
    publishRepoTerminalViewAttributes(
      composeRepoTerminalViewAttributesByHost(
        { settings: state.settings, repos: state.repos },
        getSystemPrefersDarkSnapshot()
      )
    )
  }
  const armAfterCatalogSettles = (): void => {
    const state = useAppStore.getState()
    const generation = state.reposFetchGeneration
    // Generation 0: no catalog fetch has started yet.
    if (phase !== 'awaiting-catalog' || generation === 0 || generation === failedGeneration) {
      return
    }
    phase = 'settling'
    // Waits out runtime-only fetches (they bump the generation too) until a local fetch settles.
    state.awaitLocalRepoCatalogSettlement().then(
      () => {
        if (phase === 'settling') {
          phase = 'armed'
          publish()
        }
      },
      () => {
        if (phase === 'settling') {
          // Failed fetch = stale/empty repos; retry on the next fetch (one that started meanwhile counts).
          phase = 'awaiting-catalog'
          failedGeneration = generation
          armAfterCatalogSettles()
        }
      }
    )
  }
  armAfterCatalogSettles()
  const unsubscribeStore = useAppStore.subscribe((state, prev) => {
    if (phase !== 'armed') {
      armAfterCatalogSettles()
    } else if (state.settings !== prev.settings || state.repos !== prev.repos) {
      publish()
    }
  })
  const unsubscribeMedia = subscribeToSystemPrefersDarkChange(publish)
  return () => {
    phase = 'disposed'
    unsubscribeStore()
    unsubscribeMedia()
  }
}

/** App-lifetime mount point; see installRepoTerminalViewAttributesPublisher. */
export function useRepoTerminalViewAttributesPublisher(): void {
  useEffect(() => installRepoTerminalViewAttributesPublisher(), [])
}

/** Test seam: reset the dedupe state between tests. */
export function _resetRepoTerminalViewAttributesPublisherForTest(): void {
  lastPublishedSnapshot = null
}
