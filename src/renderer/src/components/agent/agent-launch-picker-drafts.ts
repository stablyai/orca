import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore
} from 'react'
import { sameSourceControlSetupSelection } from '../../lib/source-control-agent-launch-picker'
import { shallow } from 'zustand/shallow'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerDraftOwner,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

import {
  type AgentPickerRetainedSetup as RetainedSetup,
  currentAgentPickerDraft
} from '../../../../shared/agent-launch-picker-authority'
import { retireAgentPickerSetups } from './agent-launch-picker-retirement'
import {
  launchDraftSource,
  nativeChatLaunchPromptDraftScopeKey
} from '../native-chat/native-chat-launch-draft-source'
import {
  subscribeToNativeChatComposerDraft,
  writeLaunchSetupOptions
} from '../native-chat/native-chat-composer-draft-store'

export type { AgentPickerDraftOwner } from '../../../../shared/agent-launch-picker'
export type AgentPickerSetupIdentity = { model: string; effort?: string }
const appSession: AgentPickerDraftOwner = {}
const sessionDrafts = new WeakMap<AgentPickerDraftOwner, Map<string, RetainedSetup>>()

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

function sameSource(before?: AgentPickerDraft, after?: AgentPickerDraft) {
  if (before === after) {
    return true
  }
  if (!before || !after || before.agent !== after.agent) {
    return false
  }
  const a = before.recipeEdits?.selection
  const b = after.recipeEdits?.selection
  if (a && b) {
    return sameSourceControlSetupSelection(
      { ...a, current: { ...a.current, surface: b.current.surface } },
      b
    )
  }
  return (
    !a &&
    !b &&
    before.arguments === after.arguments &&
    before.choices.model === after.choices.model &&
    before.choices.permissionMode === after.choices.permissionMode &&
    shallow(before.choices.options, after.choices.options) &&
    shallow(before.delegated, after.delegated)
  )
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
  const key = JSON.stringify([entry.draftTarget?.key, entry.agent, draftId])
  const launchKey = nativeChatLaunchPromptDraftScopeKey(
    entry.worktreeId ?? '',
    entry.agent,
    entry.rows[0]?.executionHostId ?? 'local'
  )
  const originalPreset = useMemo(
    () =>
      preset ??
      (mode === 'launch' && initial?.choices.model
        ? { model: initial.choices.model, effort: initial.choices.options?.effort ?? undefined }
        : undefined),
    [preset, mode, initial?.choices.model, initial?.choices.options?.effort]
  )
  // Original parsed preset identity is independent of edited choices and changing defaults.
  const slot = preset
    ? JSON.stringify({
        model: preset.model,
        ...(preset.effort !== undefined ? { options: { effort: preset.effort } } : {})
      })
    : initial && mode === 'launch'
      ? JSON.stringify(initial.choices)
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
  const matches = useCallback(
    (record: RetainedSetup) => sameSource(record.source, initial),
    [initial]
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
          draft: authored ?? seed ?? agentPickerDraft(entry),
          active: open
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
    if ((mode === 'launch' || !open) && !read()) {
      return
    }
    const activeRecord = acquire()
    activeRecord.active = open
    if (activeRecord !== retained) {
      publish()
    }
    return () => {
      activeRecord.active = false
    }
  }, [open, read, acquire, retained, mode])
  let record = retained && matches(retained) ? retained : undefined
  const currentDraft = (draft: AgentPickerDraft) => {
    const current = currentAgentPickerDraft(entry, draft)
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
    accept: (draft: AgentPickerDraft) => {
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
      return true
    }
  }
}
