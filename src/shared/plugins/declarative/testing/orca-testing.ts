/**
 * `orca/testing`: mount a components panel in plain Node (node:test, vitest, bun) against a
 * stand-in Orca, with the real runtime and the real tree validator. Bundled to
 * resources/plugins/declarative/orca-testing.mjs, which imports the runtime from its own folder so
 * the panel and the kit share one `orca` module.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createMockHost, type MockHost, type MockHostOptions } from './testing-host'
import { mountPanel, type MountOptions } from './testing-panel'

export { hostError } from './testing-host'
// Node's runner and strict asserts, so a test needs no @types/node to type-check. Under vitest, use
// vitest's own `test` and `expect` instead.
export { test, describe, beforeEach, afterEach } from 'node:test'
export { default as assert } from 'node:assert/strict'
export { stored } from './testing-panel'
export type { MockHost, MockHostOptions } from './testing-host'
export type { TestPanel, PanelIssue, PersistedState } from './testing-panel'
export type { TestElement, TestQuery, TreeSnapshot } from './testing-tree'

/** Capabilities the nearest orca-plugin.json (from the working directory up) declares. */
function declaredCapabilities(): string[] {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, 'orca-plugin.json'), 'utf8'))
      const capabilities =
        typeof manifest === 'object' && manifest !== null && 'capabilities' in manifest
          ? manifest.capabilities
          : []
      return Array.isArray(capabilities)
        ? capabilities.flatMap((entry: unknown) =>
            typeof entry === 'object' &&
            entry !== null &&
            'kind' in entry &&
            typeof entry.kind === 'string'
              ? [entry.kind]
              : []
          )
        : []
    } catch {
      if (dirname(dir) === dir) {
        return []
      }
    }
  }
}

/** A stand-in Orca host; capabilities default to the plugin manifest's. */
export function mockHost(options: MockHostOptions = {}): MockHost {
  return createMockHost(options, declaredCapabilities())
}

/**
 * Mounts a panel module (or its default component) and waits until it has rendered. One panel is
 * mounted at a time; mounting again unmounts the last one and puts every atom back to its initial
 * value.
 */
export function mount(
  target: Parameters<typeof mountPanel>[0],
  options: Partial<MountOptions> = {}
): ReturnType<typeof mountPanel> {
  return mountPanel(target, { ...options, host: options.host ?? mockHost() })
}
