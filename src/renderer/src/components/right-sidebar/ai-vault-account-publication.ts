import type { AccountBinding, NativeAccountBinding } from './ai-vault-account-binding'
import type { NativeAccountInputs, NativeAccountEvidence } from './ai-vault-native-account-index'
import {
  nativeAccountDisplay,
  nativeEvidenceCovers,
  sameNativeAccountDependency
} from './ai-vault-native-account-index'
import {
  resolveNativeAccountDisplay,
  sameNativeAccountDisplay,
  type NativeAccountDisplay
} from './ai-vault-account-display'

export type AccountDirectoryEntry = {
  binding: AccountBinding
  value: string | null
  display?: NativeAccountDisplay
  listeners: Set<() => void>
}
function selectDisplay(
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
) {
  const covered = evidence !== null && nativeEvidenceCovers(binding, inputs, evidence)
  return { covered, display: nativeAccountDisplay(binding, inputs, covered ? evidence : null) }
}
function installDisplay(entry: AccountDirectoryEntry, display: NativeAccountDisplay): boolean {
  const same = entry.display !== undefined && sameNativeAccountDisplay(entry.display, display)
  entry.display = display
  if (same) {
    return false
  }
  const value = resolveNativeAccountDisplay(display)
  const changed = value !== entry.value
  entry.value = value
  return changed
}
export function initializeNativeAccount(
  entry: AccountDirectoryEntry,
  binding: NativeAccountBinding,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null
): void {
  installDisplay(entry, selectDisplay(binding, inputs, evidence).display)
}
export function prepareNativeAccounts(
  entries: Iterable<AccountDirectoryEntry>,
  inputs: NativeAccountInputs,
  evidence: NativeAccountEvidence | null,
  previous?: NativeAccountInputs
) {
  const selections: { entry: AccountDirectoryEntry; display: NativeAccountDisplay }[] = []
  let uncovered = false
  let relevant = false
  for (const entry of entries) {
    if (entry.binding.kind === 'opencode') {
      continue
    }
    if (previous && !sameNativeAccountDependency(entry.binding, previous, inputs, evidence)) {
      relevant = true
    }
    const selected = selectDisplay(entry.binding, inputs, evidence)
    uncovered ||= !selected.covered
    selections.push({ entry, display: selected.display })
  }
  return {
    uncovered,
    relevant,
    commit: () => {
      const changed: AccountDirectoryEntry[] = []
      for (const { entry, display } of selections) {
        if (installDisplay(entry, display)) {
          changed.push(entry)
        }
      }
      // Install all scalar/descriptor baselines before a callback can acquire or mutate inputs.
      for (const entry of changed) {
        entry.listeners.forEach((notify) => notify())
      }
    }
  }
}
