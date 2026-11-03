import { profileDirectory } from './ai-vault-account-profiles'
import {
  initializeNativeAccount,
  prepareNativeAccounts,
  type AccountDirectoryEntry as Entry
} from './ai-vault-account-publication'
import { useAppStore } from '../../store'
import { subscribeRuntimeRpc } from '@/runtime/runtime-rpc-subscribe'
import {
  watchProviderAccounts,
  type ProviderAccountsWatcher,
  type ProviderAccountsSnapshot
} from '@/runtime/runtime-provider-accounts-client'
import type { AccountBinding, NativeAccountBinding } from './ai-vault-account-binding'
import {
  NativeAccountInputs,
  NativeAccountEvidence,
  sameNativeAccountDependency,
  nativeEvidenceCovers
} from './ai-vault-native-account-index'

type NativeAttempt = { inputs: NativeAccountInputs; watcher?: ProviderAccountsWatcher }
type DataAttempt = { close?: () => void }
type Directory = {
  entries: Map<string, Entry>
  nativeEntries: Map<string, Entry>
  dataEntries: Map<string, Entry>
  inputs: NativeAccountInputs
  desired: NativeAccountInputs
  evidence: NativeAccountEvidence | null
  native: NativeAttempt | null
  unwatchSettings?: () => void
  data: DataAttempt | null
  profiles: Map<string, string>
}
let directory: Directory | undefined

function publishData(owner: Directory): void {
  const changed: Entry[] = []
  for (const entry of owner.dataEntries.values()) {
    if (entry.binding.kind !== 'opencode') {
      continue
    }
    const value = owner.profiles.get(entry.binding.id) ?? null
    if (value !== entry.value) {
      entry.value = value
      changed.push(entry)
    }
  }
  for (const entry of changed) {
    entry.listeners.forEach((notify) => notify())
  }
}

function drainNative(owner: Directory): void {
  if (directory !== owner || owner.native || owner.nativeEntries.size === 0) {
    return
  }
  const attempt: NativeAttempt = { inputs: owner.desired }
  owner.native = attempt
  const settle = (snapshot?: ProviderAccountsSnapshot): void => {
    if (directory !== owner || owner.native !== attempt) {
      return
    }
    attempt.watcher?.close()
    owner.native = null
    const evidence = snapshot ? new NativeAccountEvidence(attempt.inputs, snapshot) : null
    const publication = prepareNativeAccounts(owner.nativeEntries.values(), owner.inputs, evidence)
    // Response-discovered homes must also be covered before any new label is installed.
    if (evidence && publication.uncovered) {
      owner.desired = owner.inputs
    }
    if (attempt.inputs !== owner.desired) {
      drainNative(owner)
      return
    }
    owner.evidence = evidence
    publication.commit()
  }
  try {
    const watcher = watchProviderAccounts(
      { kind: 'local' },
      { onSnapshot: settle, onError: () => settle() }
    )
    if (owner.native === attempt) {
      attempt.watcher = watcher
    } else {
      watcher.close()
    }
  } catch {
    settle()
  }
}

function observeNative(owner: Directory): void {
  if (!owner.unwatchSettings) {
    owner.inputs = new NativeAccountInputs(useAppStore.getState().settings)
    owner.desired = owner.inputs
    owner.unwatchSettings = useAppStore.subscribe((state) => {
      const previous = owner.inputs
      if (
        directory !== owner ||
        (previous.settings?.claudeManagedAccounts === state.settings?.claudeManagedAccounts &&
          previous.settings?.codexManagedAccounts === state.settings?.codexManagedAccounts)
      ) {
        return
      }
      owner.inputs = new NativeAccountInputs(state.settings, previous)
      const publication = prepareNativeAccounts(
        owner.nativeEntries.values(),
        owner.inputs,
        owner.evidence,
        previous
      )
      if (publication.relevant) {
        owner.desired = owner.inputs
      }
      publication.commit()
      if (publication.relevant) {
        drainNative(owner)
      }
    })
  }
}

function acquireNative(
  owner: Directory,
  entry: Entry,
  binding: NativeAccountBinding,
  initialize: boolean
): void {
  observeNative(owner)
  if (initialize) {
    initializeNativeAccount(entry, binding, owner.inputs, owner.evidence)
  }
  const failed = !owner.evidence || !!owner.evidence.snapshot.failedProviders?.length
  if (!initialize && (owner.native || !failed)) {
    return
  }
  const uncovered = !owner.evidence || !nativeEvidenceCovers(binding, owner.inputs, owner.evidence)
  if (uncovered || (!owner.native && failed)) {
    if (
      !owner.native ||
      !sameNativeAccountDependency(binding, owner.native.inputs, owner.inputs, owner.evidence)
    ) {
      owner.desired = owner.inputs
    }
    drainNative(owner)
  }
}

function observeData(owner: Directory): void {
  if (owner.data) {
    return
  }
  const attempt: DataAttempt = {}
  owner.data = attempt
  const live = () => directory === owner && owner.data === attempt
  const lose = (): void => {
    if (!live()) {
      return
    }
    owner.data = null
    owner.profiles = new Map()
    attempt.close?.()
    publishData(owner)
  }
  void subscribeRuntimeRpc({ kind: 'local' }, 'accounts.subscribe', null, {
    onEvent: (frame) => {
      if (!live() || typeof frame !== 'object' || frame === null || !('type' in frame)) {
        return
      }
      if (frame.type === 'end') {
        lose()
      } else if (frame.type === 'ready' || frame.type === 'snapshot') {
        owner.profiles = profileDirectory(frame)
        publishData(owner)
      }
    },
    onError: lose,
    onClose: lose
  }).then((handle) => {
    if (live()) {
      attempt.close = handle.unsubscribe
    } else {
      handle.unsubscribe()
    }
  }, lose)
}

export function readSessionAccount(key: string): string | null {
  return directory?.entries.get(key)?.value ?? null
}

export function subscribeSessionAccount(
  key: string,
  binding: AccountBinding,
  listener: () => void
): () => void {
  const owner: Directory = (directory ??= {
    entries: new Map(),
    nativeEntries: new Map(),
    dataEntries: new Map(),
    inputs: new NativeAccountInputs(null),
    desired: new NativeAccountInputs(null),
    evidence: null,
    native: null,
    data: null,
    profiles: new Map()
  })
  let entry = owner.entries.get(key)
  if (!entry) {
    entry = { binding, value: null, listeners: new Set() }
    owner.entries.set(key, entry)
  }
  const held = entry
  const initialize = held.listeners.size === 0
  held.listeners.add(listener)
  const active = binding.kind === 'opencode' ? owner.dataEntries : owner.nativeEntries
  active.set(key, held)
  if (binding.kind === 'opencode') {
    observeData(owner)
    if (initialize) {
      held.value = owner.profiles.get(binding.id) ?? null
    }
  } else {
    acquireNative(owner, held, binding, initialize)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    held.listeners.delete(listener)
    if (held.listeners.size === 0) {
      active.delete(key)
      held.display = undefined
    }
    queueMicrotask(() => {
      if (directory !== owner || owner.entries.get(key) !== held || held.listeners.size > 0) {
        return
      }
      owner.entries.delete(key)
      if (owner.dataEntries.size === 0) {
        const attempt = owner.data
        owner.data = null
        owner.profiles.clear()
        attempt?.close?.()
      }
      if (owner.nativeEntries.size === 0) {
        const attempt = owner.native
        owner.native = null
        attempt?.watcher?.close()
        owner.unwatchSettings?.()
        owner.unwatchSettings = undefined
        owner.evidence = null
        owner.inputs = owner.desired = new NativeAccountInputs(null)
      }
      if (owner.entries.size === 0) {
        directory = undefined
      }
    })
  }
}
