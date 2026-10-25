import { expect, vi } from 'vitest'
import * as shell from './tui-agent-startup-shell'
import type { GlobalSettings } from './global-settings-types'
import { getDefaultVoiceSettings } from './constants'
import { getDefaultNotificationSettings } from './notification-settings-defaults'
import { buildDefaultSettings } from './default-global-settings'

// Why: tests need a complete GlobalSettings without hand-copying every field, so
// new settings only have to be added to buildDefaultSettings, not each fixture.
export function createGlobalSettingsFixture(
  overrides: Partial<GlobalSettings> = {}
): GlobalSettings {
  return {
    ...buildDefaultSettings({
      // Callers supply the real directory; no platform-specific default belongs here.
      workspaceDir: overrides.workspaceDir ?? '',
      appFontFamily: 'Geist',
      editorAutoSaveDelayMs: 1000,
      primarySelectionMiddleClickPaste: false,
      primarySelectionDefaultedForLinux: false,
      terminalFontFamily: 'JetBrains Mono',
      terminalInactivePaneOpacity: 0.5,
      terminalRightClickToPaste: false,
      notifications: getDefaultNotificationSettings(),
      voice: getDefaultVoiceSettings()
    }),
    ...overrides
  }
}

const originalTokenizer = shell.tokenizeStartupCommand

// Native materializations and string outputs; callers add the finite semantic/property passes.
export function measureSettingsWork<T>(call: () => T) {
  const work = {
    entries: 0,
    assignments: 0,
    comparisons: 0,
    bytes: 0,
    chars: 0,
    visits: 0,
    inputs: Array<string>()
  }
  const currentTokenizer = shell.tokenizeStartupCommand
  const existingTokenizerSpy = vi.isMockFunction(currentTokenizer)
  const tokenize = vi.isMockFunction(currentTokenizer)
    ? (currentTokenizer.getMockImplementation() ?? originalTokenizer)
    : currentTokenizer
  const tokenizerSpy = vi.spyOn(shell, 'tokenizeStartupCommand')
  tokenizerSpy.mockImplementation((...args) => {
    work.inputs.push(args[0])
    work.chars += args[0].length
    const parsed = tokenize(...args)
    // Fixed token/span/owner passes; this is not a dynamic index-read counter.
    if (parsed.ok) {
      work.visits += 10 * parsed.tokens.length
    }
    return parsed
  })
  const restores: (() => void)[] = []
  function replace<T, K extends keyof T>(target: T, name: K, wrap: (original: T[K]) => T[K]) {
    const original = target[name]
    target[name] = wrap(original)
    restores.push(() => {
      target[name] = original
    })
  }
  replace(Object, 'entries', (original) => (value) => {
    const result = original(value)
    work.entries += 2 * result.length
    return result
  })
  replace(Object, 'keys', (original) => (value) => {
    const result = original(value)
    work.entries += 2 * result.length
    return result
  })
  replace(Object, 'fromEntries', (original) => (value) => {
    const result = original(value)
    work.entries += Reflect.ownKeys(result).length
    return result
  })
  replace(Object, 'hasOwn', (original) => (value, key) => {
    const result = original(value, key)
    work.entries++
    return result
  })
  replace(Object, 'assign', (original) => (target, ...sources) => {
    const result = original(target, ...sources)
    work.assignments++
    for (const source of sources) {
      work.entries += 2 * Reflect.ownKeys(Object(source)).length
    }
    return result
  })
  replace(
    Map.prototype,
    'get',
    (original) =>
      function (this: Map<unknown, unknown>, key: unknown) {
        const result: unknown = original.call(this, key)
        work.entries++
        return result
      }
  )
  replace(
    Map.prototype,
    'set',
    (original) =>
      function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        const result = original.call(this, key, value)
        work.entries++
        return result
      }
  )
  replace(
    Map.prototype,
    'delete',
    (original) =>
      function (this: Map<unknown, unknown>, key: unknown) {
        const result = original.call(this, key)
        work.entries++
        return result
      }
  )
  replace(
    Set.prototype,
    'add',
    (original) =>
      function (this: Set<unknown>, value: unknown) {
        const result = original.call(this, value)
        work.entries++
        return result
      }
  )
  replace(
    Set.prototype,
    'has',
    (original) =>
      function (this: Set<unknown>, value: unknown) {
        const result = original.call(this, value)
        work.entries++
        return result
      }
  )
  replace(
    Array.prototype,
    'sort',
    (original) =>
      function (this: unknown[], compare?: (a: unknown, b: unknown) => number) {
        return original.call(this, (a, b) => {
          work.comparisons++
          return typeof compare === 'function'
            ? compare(a, b)
            : +(String(a) > String(b)) - +(String(a) < String(b))
        })
      }
  )
  replace(
    Array.prototype,
    'slice',
    (original) =>
      function (this: unknown[], start?: number, end?: number) {
        const result = original.call(this, start, end)
        work.visits += 2 * result.length
        return result
      }
  )
  replace(
    String.prototype,
    'slice',
    (original) =>
      function (this: string, start?: number, end?: number) {
        const result = original.call(this, start, end)
        work.bytes += result.length
        return result
      }
  )
  replace(
    String.prototype,
    'toLowerCase',
    (original) =>
      function (this: string) {
        const result = original.call(this)
        work.bytes += result.length
        return result
      }
  )
  work.entries = 0
  const restore = () => {
    restores.toReversed().forEach((reset) => reset())
    if (existingTokenizerSpy) {
      tokenizerSpy.mockImplementation(tokenize)
    } else {
      tokenizerSpy.mockRestore()
    }
  }
  let pending = false
  try {
    const value = call()
    pending = value instanceof Promise
    if (value instanceof Promise) {
      void value.then(restore, restore)
    }
    return { value, work }
  } finally {
    if (!pending) {
      restore()
    }
  }
}

const workScales = new Map<string, number[]>()
export function expectSettingsWorkScale(key: string, size: number, counts: number[]) {
  if (size === 200) {
    const baseline = workScales.get(key)
    expect(baseline, key).toBeDefined()
    counts.forEach((value, i) => expect(value, key).toBeLessThanOrEqual(12 * baseline![i]))
  }
  workScales.set(key, counts)
}
