import { isDeepStrictEqual } from 'node:util'
import type { HookListenerState } from './listener-state'
import {
  clearJcodePaneSessions,
  lookupJcodeSessionBinding,
  type JcodeSessionRegistry
} from './jcode-session-registry'

const JCODE_MAPS = [
  'lastPromptByPaneKey',
  'lastToolByPaneKey',
  'jcodeTurnPromptByPaneKey',
  'jcodeTurnByPaneKey',
  'jcodeSubagentRosterByPaneKey',
  'jcodeRootPayloadByPaneKey'
] as const

function copyPaneEntry<T>(map: Map<string, T>, paneKey: string): Map<string, T> {
  const copy = new Map(map)
  const value = map.get(paneKey)
  if (value !== undefined) {
    copy.set(paneKey, structuredClone(value))
  }
  return copy
}

function commitPaneEntry<T>(target: Map<string, T>, draft: Map<string, T>, paneKey: string): void {
  const value = draft.get(paneKey)
  if (isDeepStrictEqual(target.get(paneKey), value)) {
    return
  }
  if (value === undefined) {
    target.delete(paneKey)
  } else {
    target.set(paneKey, value)
  }
}

function registryPaneKeys(registry: JcodeSessionRegistry): Set<string> {
  return new Set([
    ...registry.roots.keys(),
    ...Array.from(registry.bindings.values(), (binding) => binding.paneKey),
    ...registry.pending.map((event) => event.paneKey),
    ...registry.tombstones.values(),
    ...registry.overflowPanes
  ])
}

function rebaseAfterPaneEviction(
  state: HookListenerState,
  before: JcodeSessionRegistry,
  draft: HookListenerState,
  paneKey: string
): JcodeSessionRegistry | null {
  const remaining = registryPaneKeys(state.jcodeSessions)
  const evicted = Array.from(registryPaneKeys(before)).filter(
    (key) => key !== paneKey && !remaining.has(key)
  )
  if (!evicted.length) {
    return null
  }
  const expected = { ...state, jcodeSessions: before }
  const rebased = { ...draft }
  for (const key of evicted) {
    clearJcodePaneSessions(expected, key)
    clearJcodePaneSessions(rebased, key)
  }
  // Cache admission may remove other panes, but cannot authorize a changed owner or draft.
  return isDeepStrictEqual(expected.jcodeSessions, state.jcodeSessions)
    ? rebased.jcodeSessions
    : null
}

export function prepareJcodeState(
  state: HookListenerState,
  paneKey: string,
  warnings?: Pick<HookListenerState, 'warnedVersions' | 'warnedEnvs'>
): {
  draft: HookListenerState
  commit: () => void
} {
  const registry = state.jcodeSessions
  const turn = state.jcodeTurnByPaneKey.get(paneKey)
  const roster = state.jcodeSubagentRosterByPaneKey.get(paneKey)
  const rootPayload = state.jcodeRootPayloadByPaneKey.get(paneKey)
  const draft: HookListenerState = {
    ...state,
    warnedVersions: warnings?.warnedVersions ?? new Set(state.warnedVersions),
    warnedEnvs: warnings?.warnedEnvs ?? new Set(state.warnedEnvs),
    lastPromptByPaneKey: new Map(state.lastPromptByPaneKey),
    lastToolByPaneKey: copyPaneEntry(state.lastToolByPaneKey, paneKey),
    jcodeTurnPromptByPaneKey: copyPaneEntry(state.jcodeTurnPromptByPaneKey, paneKey),
    jcodeTurnByPaneKey: copyPaneEntry(state.jcodeTurnByPaneKey, paneKey),
    jcodeSubagentRosterByPaneKey: copyPaneEntry(state.jcodeSubagentRosterByPaneKey, paneKey),
    jcodeRootPayloadByPaneKey: copyPaneEntry(state.jcodeRootPayloadByPaneKey, paneKey),
    jcodeTurnRevision: { ...state.jcodeTurnRevision }
  }
  let committed = false
  return {
    draft,
    commit: () => {
      // Settlement can replace a turn without changing the session registry.
      if (
        committed ||
        state.jcodeTurnByPaneKey.get(paneKey) !== turn ||
        state.jcodeSubagentRosterByPaneKey.get(paneKey) !== roster ||
        state.jcodeRootPayloadByPaneKey.get(paneKey) !== rootPayload
      ) {
        return
      }
      const nextRegistry =
        state.jcodeSessions === registry
          ? draft.jcodeSessions
          : rebaseAfterPaneEviction(state, registry, draft, paneKey)
      if (!nextRegistry) {
        return
      }
      committed = true
      state.jcodeSessions = nextRegistry
      for (const version of draft.warnedVersions) {
        state.warnedVersions.add(version)
      }
      for (const env of draft.warnedEnvs) {
        state.warnedEnvs.add(env)
      }
      commitPaneEntry(state.lastPromptByPaneKey, draft.lastPromptByPaneKey, paneKey)
      commitPaneEntry(state.lastToolByPaneKey, draft.lastToolByPaneKey, paneKey)
      commitPaneEntry(state.jcodeTurnPromptByPaneKey, draft.jcodeTurnPromptByPaneKey, paneKey)
      commitPaneEntry(state.jcodeTurnByPaneKey, draft.jcodeTurnByPaneKey, paneKey)
      commitPaneEntry(
        state.jcodeSubagentRosterByPaneKey,
        draft.jcodeSubagentRosterByPaneKey,
        paneKey
      )
      commitPaneEntry(state.jcodeRootPayloadByPaneKey, draft.jcodeRootPayloadByPaneKey, paneKey)
      state.jcodeTurnRevision.current = Math.max(
        state.jcodeTurnRevision.current,
        draft.jcodeTurnRevision.current
      )
    }
  }
}

export function clearReplacedJcodeRoot(
  state: HookListenerState,
  paneKey: string,
  sessionId: string
): void {
  const previous =
    state.jcodeTurnByPaneKey.get(paneKey)?.sessionId ??
    state.lastStatusByPaneKey.get(paneKey)?.providerSession?.id
  // Missing worker bindings reveal replacement before any root turn or row exists.
  const retiredWorkers = Array.from(state.jcodeSubagentRosterByPaneKey.get(paneKey) ?? []).some(
    ([id, worker]) =>
      worker.restoredFromSnapshot !== true &&
      lookupJcodeSessionBinding(state, paneKey, id)?.rootSessionId !== sessionId
  )
  if ((previous && previous !== sessionId) || retiredWorkers) {
    for (const key of JCODE_MAPS) {
      state[key].delete(paneKey)
    }
  }
}
