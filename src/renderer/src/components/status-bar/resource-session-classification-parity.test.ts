import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CONTROLLER_PATH = resolve(__dirname, 'use-resource-usage-status-controller.ts')
const DERIVED_MODEL_PATH = resolve(__dirname, 'use-resource-usage-derived-model.ts')

/**
 * Both destructive paths — bulk "kill orphans" and a single row's kill — must classify from the
 * same binding inputs. When the merge call site re-listed the fields instead of reusing the
 * object, it silently omitted deferred SSH sessions: bulk cleanup spared them while the row's
 * kill destroyed them with no confirmation. Same bug, one click over (#8459).
 */
describe('resource session classification parity', () => {
  it('feeds the row merge the same binding inputs as the bulk selector', () => {
    const source = readFileSync(DERIVED_MODEL_PATH, 'utf8')
    const mergeCall = source.slice(
      source.indexOf('mergeSnapshotAndSessions(resourceSnapshot'),
      source.indexOf('worktreeById\n          })')
    )

    expect(mergeCall).toContain('...resourceSessionBindings')
    // Any of these appearing inline means the call site is re-deriving bindings and can drift.
    for (const field of [
      'ptyIdsByTabId,',
      'tabsByWorktree,',
      'terminalLayoutsByTabId,',
      'deferredSshSessionIdsByTabId,',
      'workspaceSessionReady,'
    ]) {
      expect(mergeCall).not.toContain(field)
    }
  })

  it('keeps every binding source in the one object both paths read', () => {
    const source = readFileSync(CONTROLLER_PATH, 'utf8')
    const bindings = source.slice(
      source.indexOf('const resourceSessionBindings = useMemo'),
      source.indexOf('const popoverBodyRef')
    )

    for (const field of [
      'ptyIdsByTabId',
      'tabsByWorktree',
      'terminalLayoutsByTabId',
      'deferredSshSessionIdsByTabId',
      'workspaceSessionReady'
    ]) {
      expect(bindings).toContain(field)
    }
  })
})
