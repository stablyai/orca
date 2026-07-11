export type TerminalScrollIntentKey = string

export type TerminalScrollIntent = {
  kind: 'followOutput' | 'pinnedViewport'
  bufferType: 'normal' | 'alternate'
  viewportY: number
  baseY: number
}

type TerminalScrollIntentKeyBinding = {
  key: TerminalScrollIntentKey
  retired: boolean
}

const bindingByTerminal = new WeakMap<object, TerminalScrollIntentKeyBinding>()
const activeBindingByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntentKeyBinding>()
const intentByKey = new Map<TerminalScrollIntentKey, TerminalScrollIntent>()

export function writeTerminalScrollIntentKey(terminal: object, intent: TerminalScrollIntent): void {
  const binding = bindingByTerminal.get(terminal)
  if (binding && !binding.retired && activeBindingByKey.get(binding.key) === binding) {
    intentByKey.set(binding.key, intent)
  }
}

export function readTerminalScrollIntentKey(terminal: object): TerminalScrollIntent | undefined {
  const binding = bindingByTerminal.get(terminal)
  if (!binding || binding.retired || activeBindingByKey.get(binding.key) !== binding) {
    return undefined
  }
  return intentByKey.get(binding.key)
}

export function bindTerminalScrollIntentKey(
  terminal: object,
  key: TerminalScrollIntentKey | undefined
): TerminalScrollIntent | undefined {
  if (!key) {
    return undefined
  }
  let binding = activeBindingByKey.get(key)
  if (!binding) {
    binding = { key, retired: false }
    activeBindingByKey.set(key, binding)
  }
  bindingByTerminal.set(terminal, binding)
  return intentByKey.get(key)
}

export function clearTerminalScrollIntentKey(key: TerminalScrollIntentKey): void {
  const binding = activeBindingByKey.get(key)
  if (binding) {
    // Why: queued scroll samplers cannot be cancelled uniformly, so retire their
    // binding before deleting state to prevent key resurrection and ABA writes.
    binding.retired = true
    if (activeBindingByKey.get(key) === binding) {
      activeBindingByKey.delete(key)
    }
  }
  intentByKey.delete(key)
}

export function _getTerminalScrollIntentKeyCountForTest(): number {
  return activeBindingByKey.size
}

export function _getTerminalScrollIntentSnapshotCountForTest(): number {
  return intentByKey.size
}

export function _clearTerminalScrollIntentKeysForTest(): void {
  for (const binding of activeBindingByKey.values()) {
    binding.retired = true
  }
  activeBindingByKey.clear()
  intentByKey.clear()
}
