import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import { sameSourceControlSetupSelection } from '../settings/source-control-agent-launch-picker'
import { shallow } from 'zustand/shallow'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

export type AgentPickerSetupIdentity = { model: string; effort?: string }
export type AgentPickerDraftOwner = object
type RetainedSetup = {
  target: AgentPickerEntry['draftTarget']
  agent: AgentPickerEntry['agent']
  preset?: AgentPickerSetupIdentity
  authority: string | undefined
  source: AgentPickerDraft | undefined
  draft: AgentPickerDraft
  active: boolean
}
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
  if (!before || !after || before.surface !== after.surface || before.agent !== after.agent) {
    return false
  }
  const a = before.recipeEdits?.selection
  const b = after.recipeEdits?.selection
  if (a && b) {
    return sameSourceControlSetupSelection(a, b)
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
  targetAlive?: (target: NonNullable<AgentPickerEntry['draftTarget']>) => boolean
) {
  const drafts = sessionDrafts.get(scope)
  if (!drafts) {
    return
  }
  const membership = new Map(
    entries.map((entry) => [
      JSON.stringify([entry.draftTarget?.key, entry.agent]),
      {
        entry,
        models:
          entry.catalog.origin === 'unknown' || entry.catalog.listingInProgress
            ? undefined
            : new Map(
                entry.catalog.models.map((model) => [
                  model.id,
                  model.effortsKnown === false
                    ? undefined
                    : new Set(model.efforts.map((effort) => effort.value))
                ])
              )
      }
    ])
  )
  for (const [key, retained] of drafts) {
    const current = membership.get(JSON.stringify([retained.target?.key, retained.agent]))
    if (retained.target && targetAlive && !targetAlive(retained.target)) {
      drafts.delete(key)
    } else if (current && current.entry.ownerKey !== retained.authority) {
      drafts.delete(key)
    } else if (current?.models && retained.preset && !retained.active) {
      const { model, effort } = retained.preset
      if (
        !current.models.has(model) ||
        (effort !== undefined && current.models.get(model)?.has(effort) === false)
      ) {
        drafts.delete(key)
      }
    }
  }
}

export function useAgentPickerSetup({
  entry,
  initial,
  draftScope = appSession,
  draftId = 'agent',
  preset,
  open
}: {
  entry: AgentPickerEntry
  initial?: AgentPickerDraft
  draftScope?: AgentPickerDraftOwner
  draftId?: string
  preset?: AgentPickerSetupIdentity
  open: boolean
}) {
  const [, publish] = useReducer((version: number) => version + 1, 0)
  const key = JSON.stringify([entry.draftTarget?.key, entry.agent, draftId])
  const read = useCallback(() => sessionDrafts.get(draftScope)?.get(key), [draftScope, key])
  const matches = useCallback(
    (record: RetainedSetup) =>
      record.authority === entry.ownerKey && sameSource(record.source, initial),
    [entry.ownerKey, initial]
  )
  const lifetime = useMemo(
    () => ({ draftScope, key, authority: entry.ownerKey }),
    [draftScope, key, entry.ownerKey]
  )
  const live = useRef<typeof lifetime | undefined>(undefined)
  const collection = sessionDrafts.get(draftScope)
  const retained = read()
  const acquire = useCallback(() => {
    let drafts = sessionDrafts.get(draftScope)
    if (!drafts) {
      drafts = new Map()
      sessionDrafts.set(draftScope, drafts)
    }
    let record = drafts.get(key)
    if (!record || !matches(record)) {
      record = {
        target: entry.draftTarget,
        agent: entry.agent,
        preset,
        authority: entry.ownerKey,
        source: initial,
        draft: initial ?? agentPickerDraft(entry),
        active: open
      }
      drafts.set(key, record)
    }
    return record
  }, [draftScope, key, matches, entry, preset, initial, open])
  useLayoutEffect(() => {
    live.current = lifetime
    return () => {
      live.current = undefined
    }
  }, [lifetime])
  useLayoutEffect(() => {
    if (!open && !read()) {
      return
    }
    const record = acquire()
    record.active = open
    if (record !== retained) {
      publish()
    }
    return () => {
      record.active = false
    }
  }, [open, read, acquire, retained])
  const record = retained && matches(retained) ? retained : undefined
  const getDraft = () =>
    live.current === lifetime && record && read() === record && matches(record)
      ? record.draft
      : undefined
  const change = (draft: AgentPickerDraft) => {
    if (getDraft()) {
      record!.draft = draft
      publish()
    }
  }
  return {
    ready: !!record,
    draft: record?.draft ?? initial ?? agentPickerDraft(entry),
    getDraft,
    change,
    activate: () => {
      if (
        live.current === lifetime &&
        sessionDrafts.get(draftScope) === collection &&
        (!retained || read() === retained)
      ) {
        acquire().active = true
        publish()
      }
    },
    accept: (draft: AgentPickerDraft) => {
      if (!getDraft()) {
        return false
      }
      record!.source = draft.recipeEdits ? draft : initial
      record!.draft = draft.recipeEdits
        ? {
            ...draft,
            recipeEdits: { ...draft.recipeEdits, changed: false, argumentsAuthored: false }
          }
        : draft
      publish()
      return true
    }
  }
}
