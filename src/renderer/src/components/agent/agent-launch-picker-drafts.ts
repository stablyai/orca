import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { sameAgentPickerSetupSource as sameSource } from './agent-launch-picker-setup-source'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerDraftOwner,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

import {
  type AgentPickerRetainedSetup as RetainedSetup,
  currentAgentPickerDraft,
  launchAgentPickerDraft
} from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import { retireAgentPickerSetups } from './agent-launch-picker-retirement'
import {
  launchDraftSource,
  nativeChatLaunchPromptDraftScopeKey
} from '../native-chat/drafts/native-chat-launch-draft-source'
import { subscribeToNativeChatComposerDraft } from '../native-chat/drafts/native-chat-composer-draft-store'
import { writeLaunchSetupOptions } from '../native-chat/drafts/native-chat-composer-draft-memory'

export type AgentPickerSetupIdentity = {
  model: string
  effort?: string
  surface?: AgentPickerDraft['surface']
}
const appSession: AgentPickerDraftOwner = {}
const sessionDrafts = new WeakMap<AgentPickerDraftOwner, Map<string, RetainedSetup>>()
// Why: a form re-derives its source (and may reset its scope) from each pick; the open panel stays the authority.
const pickedSetups = new WeakSet<RetainedSetup>()

export function invalidateAgentPickerDrafts(scope: AgentPickerDraftOwner) {
  sessionDrafts.set(scope, new Map())
}

export function useAgentPickerDraftScope(resetSignal?: unknown) {
  const scope = useMemo(() => ({ resetSignal }), [resetSignal])
  useEffect(
    () => () => {
      sessionDrafts.delete(scope)
    },
    [scope]
  )
  return scope
}

export function retireAgentPickerDrafts(
  entries: readonly AgentPickerEntry[],
  scope = appSession,
  targetAlive?: (target: NonNullable<AgentPickerEntry['draftTarget']>) => boolean,
  mode: 'launch' | 'select' = 'launch'
) {
  retireAgentPickerSetups(
    entries,
    mode === 'select' ? sessionDrafts.get(scope) : undefined,
    targetAlive,
    mode
  )
}

export function useAgentPickerSetup({
  entry,
  initial,
  seed = initial,
  surface,
  draftScope = appSession,
  draftId = 'agent',
  preset,
  mode = 'launch',
  open
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  seed?: AgentPickerDraft
  surface?: AgentPickerDraft['surface']
  draftScope?: AgentPickerDraftOwner
  draftId?: string
  preset?: AgentPickerSetupIdentity
  mode?: 'launch' | 'select'
  open: boolean
}) {
  const currentSurface = surface ?? initial?.surface
  const [, publish] = useReducer((version: number) => version + 1, 0)
  const key = JSON.stringify([entry.draftTarget?.key, entry.agent, draftId, preset?.surface])
  const launchKey = nativeChatLaunchPromptDraftScopeKey(
    entry.worktreeId ?? '',
    entry.agent,
    entry.rows[0]?.executionHostId ?? 'local'
  )
  const originalPreset = useMemo(
    () =>
      preset ??
      (mode === 'launch' && initial?.choices.model
        ? {
            model: initial.choices.model,
            effort: initial.choices.options?.effort ?? undefined,
            surface: initial.surface
          }
        : undefined),
    [preset, mode, initial?.choices.model, initial?.choices.options?.effort, initial?.surface]
  )
  // Original parsed preset identity is independent of edited choices and changing defaults.
  const slot = preset
    ? JSON.stringify({
        model: preset.model,
        ...(preset.surface ? { surface: preset.surface } : {}),
        ...(preset.effort !== undefined ? { options: { effort: preset.effort } } : {})
      })
    : initial && mode === 'launch'
      ? JSON.stringify({ surface: initial.surface, ...initial.choices })
      : ''
  const read = useCallback(
    () =>
      mode === 'launch'
        ? launchDraftSource(launchKey)?.options?.get(slot)
        : sessionDrafts.get(draftScope)?.get(key),
    [mode, launchKey, slot, draftScope, key]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      mode === 'launch' && open
        ? subscribeToNativeChatComposerDraft(launchKey, listener)
        : () => {},
    [mode, open, launchKey]
  )
  useSyncExternalStore(subscribe, () => read()?.draft)
  // The last pick the form took while this panel is open, carried into a record its scope reset recreates.
  const [picked, setPicked] = useState<AgentPickerDraft>()
  const matches = useCallback(
    (record: RetainedSetup) =>
      (open && pickedSetups.has(record)) || sameSource(record.source, initial),
    [open, initial]
  )
  const lifetime = useMemo(
    () => ({
      draftScope,
      key,
      launchKey,
      slot,
      mode,
      authority: entry.ownerKey,
      surface: currentSurface
    }),
    [draftScope, key, launchKey, slot, mode, entry.ownerKey, currentSurface]
  )
  const live = useRef<typeof lifetime | undefined>(undefined)
  const collection = sessionDrafts.get(draftScope)
  const retained = read()
  const acquire = useCallback(
    (authored?: AgentPickerDraft) => {
      let record = read()
      if (!record || !matches(record)) {
        record = {
          target: entry.draftTarget,
          agent: entry.agent,
          preset: originalPreset,
          source: initial,
          draft: authored ?? (open ? picked : undefined) ?? seed ?? agentPickerDraft(entry),
          active: open
        }
        if (open && picked) {
          pickedSetups.add(record)
        }
        if (mode === 'launch') {
          writeLaunchSetupOptions(launchKey, record.draft, slot, record)
        } else {
          let drafts = sessionDrafts.get(draftScope)
          if (!drafts) {
            drafts = new Map()
            sessionDrafts.set(draftScope, drafts)
          }
          drafts.set(key, record)
        }
      }
      return record
    },
    [
      read,
      matches,
      entry,
      originalPreset,
      initial,
      seed,
      open,
      picked,
      mode,
      launchKey,
      slot,
      draftScope,
      key
    ]
  )
  useLayoutEffect(() => {
    live.current = lifetime
    return () => {
      live.current = undefined
    }
  }, [lifetime])
  useLayoutEffect(() => {
    const current = read()
    if (!open && current) {
      pickedSetups.delete(current)
    }
    if ((mode === 'launch' || !open) && !current) {
      return
    }
    const activeRecord = acquire()
    activeRecord.active = open
    if (open && pickedSetups.has(activeRecord)) {
      // The form now derives its source from this record's pick, so later edits survive a close.
      activeRecord.source = initial
    }
    if (activeRecord !== retained) {
      publish()
    }
    return () => {
      activeRecord.active = false
    }
  }, [open, read, acquire, retained, mode, initial])
  let record = retained && matches(retained) ? retained : undefined
  const currentDraft = (draft: AgentPickerDraft) => {
    const current =
      mode === 'launch'
        ? launchAgentPickerDraft(entry, draft)
        : currentAgentPickerDraft(entry, draft)
    return currentSurface && currentSurface !== current.surface
      ? { ...current, surface: currentSurface }
      : current
  }
  const getDraft = () =>
    live.current === lifetime &&
    read() === record &&
    (!record || matches(record)) &&
    (record || mode === 'launch')
      ? currentDraft(record?.draft ?? seed ?? agentPickerDraft(entry))
      : undefined
  const store = (draft: AgentPickerDraft) => {
    if (!record) {
      record = acquire(draft)
    } else {
      record.draft = draft
      if (mode === 'launch') {
        writeLaunchSetupOptions(launchKey, draft, slot, record)
      }
    }
    publish()
  }
  const change = (draft: AgentPickerDraft) => {
    if (getDraft()) {
      store(draft)
    }
  }
  return {
    ready: mode === 'launch' || !!record,
    draft: currentDraft(record?.draft ?? seed ?? agentPickerDraft(entry)),
    getDraft,
    change,
    activate: () => {
      setPicked(undefined)
      if (
        live.current === lifetime &&
        sessionDrafts.get(draftScope) === collection &&
        (!retained || read() === retained)
      ) {
        if (mode === 'select' || read()) {
          acquire().active = true
        }
        publish()
      }
    },
    /** `pick`: the form applies this while the panel stays open (select mode). */
    accept: (draft: AgentPickerDraft, pick = false) => {
      if (!getDraft()) {
        return false
      }
      if (mode === 'launch' && !record) {
        return true
      }
      record!.source = draft.recipeEdits ? draft : initial
      const accepted = draft.recipeEdits
        ? {
            ...draft,
            recipeEdits: { ...draft.recipeEdits, changed: false, argumentsAuthored: false }
          }
        : draft
      store(accepted)
      if (pick) {
        pickedSetups.add(record!)
        setPicked(accepted)
      }
      return true
    }
  }
}
