import { vi } from 'vitest'
import * as paths from '../../../../shared/cross-platform-path'
import * as equality from '../../../../shared/structural-value-equality'
import * as labels from '@/lib/codex-account-display-label'
import * as native from './ai-vault-native-account-index'
import * as display from './ai-vault-account-display'
import * as directory from './ai-vault-account-directory'
import { useAppStore } from '../../store'
import { SavedAccountComparison } from './ai-vault-saved-account-index'

// Only ordinary arrays are instrumented; forward their own and Array.prototype data properties.
function arrayProperty(array: readonly unknown[], key: PropertyKey): unknown {
  return (
    Object.getOwnPropertyDescriptor(array, key) ??
    Object.getOwnPropertyDescriptor(Array.prototype, key)
  )?.value
}

export function accountWorkCounters() {
  const emptyWork = () => ({
    savedMembers: 0,
    topologyEncodedBytes: 0,
    displayMembers: 0,
    comparedMembers: 0,
    comparedBytes: 0,
    comparisons: 0,
    edges: 0,
    edgeWalks: 0,
    selected: 0,
    resolutions: 0,
    helpers: 0,
    helperMembers: 0,
    notifications: 0,
    settingsCallbacks: 0,
    normalizations: 0,
    normalizationBytes: 0,
    helperFields: 0
  })
  const work = emptyWork()
  let settingsListeners = 0
  const observe = useAppStore.subscribe
  vi.spyOn(useAppStore, 'subscribe').mockImplementation((listener) => {
    settingsListeners++
    const close = observe((...args) => {
      work.settingsCallbacks++
      listener(...args)
    })
    return () => {
      settingsListeners--
      close()
    }
  })
  const normalize = paths.normalizeRuntimePathForComparison
  vi.spyOn(paths, 'normalizeRuntimePathForComparison').mockImplementation((path) => {
    work.normalizations++
    work.normalizationBytes += path.length
    return normalize(path)
  })
  const stringify = JSON.stringify
  vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    const encoded = stringify(value, replacer, space)
    if (Array.isArray(value) && value.length === 8 && Array.isArray(value[2])) {
      work.savedMembers++
    }
    if (Array.isArray(value) && value.length === 2 && Array.isArray(value[1])) {
      work.topologyEncodedBytes += encoded?.length ?? 0
    }
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === 'object' &&
      'id' in value &&
      'email' in value &&
      'workspaceLabel' in value
    ) {
      work.displayMembers++
    }
    return encoded
  })
  const equal = equality.structuralValuesEqual
  vi.spyOn(equality, 'structuralValuesEqual').mockImplementation((left, right) => {
    work.comparisons++
    const consumed = (value: unknown): unknown => {
      if (!Array.isArray(value)) {
        if (typeof value === 'string') {
          work.comparedBytes += value.length
        }
        return value
      }
      return new Proxy(value, {
        get: (target, key) => {
          const member = arrayProperty(target, key)
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            work.comparedMembers++
            return consumed(member)
          }
          return member
        }
      })
    }
    return left === right ? equal(left, right) : equal(consumed(left), consumed(right))
  })
  const same = SavedAccountComparison.prototype.same
  vi.spyOn(SavedAccountComparison.prototype, 'same').mockImplementation(function (
    this: SavedAccountComparison,
    slot,
    key
  ) {
    if (slot === 'scopedProofs' || slot === 'orders') {
      work.edges++
    }
    return same.call(this, slot, key)
  })
  const edges = SavedAccountComparison.prototype.sameEdges
  vi.spyOn(SavedAccountComparison.prototype, 'sameEdges').mockImplementation(function (
    this: SavedAccountComparison,
    evidence,
    key,
    compare
  ) {
    return edges.call(this, evidence, key, () => {
      work.edgeWalks++
      return compare()
    })
  })
  const selected = native.sameNativeAccountDependency
  vi.spyOn(native, 'sameNativeAccountDependency').mockImplementation((...args) => {
    work.selected++
    return selected(...args)
  })
  const covers = native.nativeEvidenceCovers
  vi.spyOn(native, 'nativeEvidenceCovers').mockImplementation((...args) => {
    work.selected++
    return covers(...args)
  })
  const resolve = display.resolveNativeAccountDisplay
  vi.spyOn(display, 'resolveNativeAccountDisplay').mockImplementation((value) => {
    work.resolutions++
    return resolve(value)
  })
  const label = labels.getCodexAccountDisplayLabel
  vi.spyOn(labels, 'getCodexAccountDisplayLabel').mockImplementation((account, accounts) => {
    work.helpers++
    const peers = new WeakMap<labels.CodexDisplayAccount, labels.CodexDisplayAccount>()
    const consumed = (value: labels.CodexDisplayAccount) => {
      let peer = peers.get(value)
      if (!peer) {
        peer = new Proxy(value, {
          get: (target, key) => {
            work.helperFields++
            return Object.getOwnPropertyDescriptor(target, key)?.value
          }
        })
        peers.set(value, peer)
      }
      return peer
    }
    return label(
      consumed(account),
      new Proxy(accounts, {
        get: (target, key) => {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            work.helperMembers++
            return consumed(target[Number(key)]!)
          }
          return arrayProperty(target, key)
        }
      })
    )
  })
  const subscribe = directory.subscribeSessionAccount
  vi.spyOn(directory, 'subscribeSessionAccount').mockImplementation((key, binding, notify) =>
    subscribe(key, binding, () => {
      work.notifications++
      notify()
    })
  )
  return {
    work,
    settingsListeners: () => settingsListeners,
    reset: () => Object.assign(work, emptyWork())
  }
}
