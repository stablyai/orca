import type { KeybindingFileDiagnostic } from './keybindings'
import { copyModeBindingsOverlap, normalizeCopyModeBinding } from './terminal-copy-mode-bindings'

export const TERMINAL_COPY_MODE_VIM_MOTIONS = [
  'lineStart',
  'lineEnd',
  'firstNonBlank',
  'lastNonBlank',
  'wordForward',
  'wordBackward',
  'wordEnd',
  'previousWordEnd',
  'bigWordForward',
  'bigWordBackward',
  'bigWordEnd',
  'previousBigWordEnd',
  'halfPageUp',
  'halfPageDown'
] as const

export const TERMINAL_COPY_MODE_ACTIONS = [
  'left',
  'down',
  'up',
  'right',
  'toggleSelection',
  'copy',
  'exit',
  ...TERMINAL_COPY_MODE_VIM_MOTIONS
] as const

export type TerminalCopyModeAction = (typeof TERMINAL_COPY_MODE_ACTIONS)[number]
export type TerminalCopyModeMotion = Exclude<
  TerminalCopyModeAction,
  'toggleSelection' | 'copy' | 'exit'
>
export type TerminalCopyModeConfig = {
  exitOnCopy: boolean
  bindings: Record<TerminalCopyModeAction, readonly string[]>
}

export const DEFAULT_TERMINAL_COPY_MODE_CONFIG: TerminalCopyModeConfig = {
  exitOnCopy: true,
  bindings: {
    left: ['H', 'ArrowLeft'],
    down: ['J', 'ArrowDown'],
    up: ['K', 'ArrowUp'],
    right: ['L', 'ArrowRight'],
    toggleSelection: ['V'],
    copy: ['Y'],
    exit: ['Escape', 'Q'],
    lineStart: ['0'],
    lineEnd: ['$'],
    firstNonBlank: ['^'],
    lastNonBlank: ['G _'],
    wordForward: ['W'],
    wordBackward: ['B'],
    wordEnd: ['E'],
    previousWordEnd: ['G E'],
    bigWordForward: ['Shift+W'],
    bigWordBackward: ['Shift+B'],
    bigWordEnd: ['Shift+E'],
    previousBigWordEnd: ['G Shift+E'],
    halfPageUp: ['Ctrl+U'],
    halfPageDown: ['Ctrl+D']
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeBindings(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const result: string[] = []
  for (const binding of value) {
    if (typeof binding !== 'string') {
      return null
    }
    const canonical = normalizeCopyModeBinding(binding)
    if (!canonical) {
      return null
    }
    if (!result.includes(canonical)) {
      result.push(canonical)
    }
  }
  return result
}

export function normalizeTerminalCopyModeConfig(
  value: unknown,
  platform: NodeJS.Platform,
  diagnostics: KeybindingFileDiagnostic[] = []
): TerminalCopyModeConfig {
  const defaults = DEFAULT_TERMINAL_COPY_MODE_CONFIG
  const config = { exitOnCopy: defaults.exitOnCopy, bindings: { ...defaults.bindings } }
  const report = (section: string, message: string, severity: 'error' | 'warning' = 'error') => {
    diagnostics.push({ section, message, severity })
  }
  if (value === undefined) {
    return config
  }
  if (!isObject(value)) {
    report('copyMode', 'copyMode must be an object. Defaults are active.')
    return config
  }
  for (const field of Object.keys(value)) {
    if (field !== 'exitOnCopy' && field !== 'bindings') {
      report(`copyMode.${field}`, `Unknown copy-mode field "${field}" was ignored.`, 'warning')
    }
  }
  if (value.exitOnCopy !== undefined) {
    if (typeof value.exitOnCopy === 'boolean') {
      config.exitOnCopy = value.exitOnCopy
    } else {
      report('copyMode.exitOnCopy', 'copyMode.exitOnCopy must be a boolean.')
    }
  }
  if (value.bindings === undefined) {
    return config
  }
  if (!isObject(value.bindings)) {
    report('copyMode.bindings', 'copyMode.bindings must be an object. Default bindings are active.')
    return config
  }
  const actions = new Set<string>(TERMINAL_COPY_MODE_ACTIONS)
  for (const field of Object.keys(value.bindings)) {
    if (!actions.has(field)) {
      report(
        `copyMode.bindings.${field}`,
        `Unknown copy-mode action "${field}" was ignored.`,
        'warning'
      )
    }
  }
  const explicit = new Set<TerminalCopyModeAction>()
  for (const action of TERMINAL_COPY_MODE_ACTIONS) {
    const raw = value.bindings[action]
    if (raw === undefined) {
      continue
    }
    const normalized = normalizeBindings(raw)
    if (!normalized || (action === 'exit' && normalized.length === 0)) {
      report(
        `copyMode.bindings.${action}`,
        `Invalid bindings for "${action}". Use an array of shortcuts or two-stroke sequences; exit needs at least one binding.`
      )
      continue
    }
    config.bindings[action] = normalized
    explicit.add(action)
  }
  // New defaults must not steal a pre-existing user control (for example WASD).
  for (const action of TERMINAL_COPY_MODE_VIM_MOTIONS) {
    if (explicit.has(action)) {
      continue
    }
    config.bindings[action] = config.bindings[action].filter((binding) => {
      const conflict = [...explicit].some((owner) =>
        config.bindings[owner].some((other) => copyModeBindingsOverlap(binding, other, platform))
      )
      if (conflict) {
        report(
          `copyMode.bindings.${action}`,
          `Default binding "${binding}" for "${action}" yields to a custom binding.`,
          'warning'
        )
      }
      return !conflict
    })
  }
  const assigned: { action: TerminalCopyModeAction; binding: string }[] = []
  for (const action of TERMINAL_COPY_MODE_ACTIONS) {
    for (const binding of config.bindings[action]) {
      const previous = assigned.find(
        (owner) =>
          owner.action !== action && copyModeBindingsOverlap(binding, owner.binding, platform)
      )
      if (previous) {
        report(
          'copyMode.bindings',
          `Copy-mode binding "${binding}" conflicts between "${previous.action}" and "${action}". Default bindings are active.`
        )
        config.bindings = { ...defaults.bindings }
        return config
      }
      assigned.push({ action, binding })
    }
  }
  return config
}
