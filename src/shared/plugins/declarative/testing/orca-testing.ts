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
import {
  mountWorker as mountTestWorker,
  type MountWorkerOptions,
  type WorkerModule
} from './testing-worker'

export { hostError } from './testing-host'
// Node's runner and strict asserts, so a test needs no @types/node to type-check. Under vitest, use
// vitest's own `test` and `expect` instead.
export { test, describe, beforeEach, afterEach } from 'node:test'
export { default as assert } from 'node:assert/strict'
export { stored } from './testing-panel'
export type { MockHost, MockHostOptions, MockHostRefusal } from './testing-host'
export type { TestWorker, WorkerModule } from './testing-worker'
export type { TestPanel, PanelIssue, PersistedState } from './testing-panel'
export type { TestElement, TestQuery, TreeSnapshot } from './testing-tree'

/** The nearest orca-plugin.json, from the working directory up; null when there is none. */
function nearestManifest(): Record<string, unknown> | null {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(dir, 'orca-plugin.json'), 'utf8'))
      return isRecord(manifest) ? manifest : null
    } catch {
      if (dirname(dir) === dir) {
        return null
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `field` of each entry of a manifest list, e.g. `capabilities[].kind`. */
function fieldsOf(list: unknown, field: string): string[] {
  return Array.isArray(list)
    ? list.flatMap((entry: unknown) =>
        isRecord(entry) && typeof entry[field] === 'string' ? [entry[field]] : []
      )
    : []
}

function contributes(manifest: Record<string, unknown> | null): Record<string, unknown> {
  return manifest && isRecord(manifest.contributes) ? manifest.contributes : {}
}

/** A stand-in Orca host; capabilities default to the plugin manifest's. */
export function mockHost(options: MockHostOptions = {}): MockHost {
  return createMockHost(options, fieldsOf(nearestManifest()?.capabilities, 'kind'))
}

/**
 * Runs a worker module's default-exported `activate(orca)` against a stand-in host. Events and
 * commands default to those the manifest lists; `emit`, `command` and `deactivate` drive it.
 */
export function mountWorker(
  module: WorkerModule,
  options: Partial<MountWorkerOptions> = {}
): ReturnType<typeof mountTestWorker> {
  const manifest = nearestManifest()
  return mountTestWorker(module, {
    host: options.host ?? mockHost(),
    events: options.events ?? fieldsOf(contributes(manifest).events, 'on'),
    commands: options.commands ?? (manifest ? fieldsOf(contributes(manifest).commands, 'id') : null)
  })
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

/** Scenarios for `orca plugin check`: export them as the default of `<entry>.check.ts` beside the
 *  panel. Check renders the panel once per scenario, each on its own mock host. */
export function defineCheck<S extends Record<string, Record<string, unknown>>>(scenarios: S): S {
  return scenarios
}
