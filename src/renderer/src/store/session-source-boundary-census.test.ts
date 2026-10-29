import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_SOURCE_FIELDS, SESSION_SOURCE_KINDS } from '../lib/session-source-fields'
import { composeSessionSourceWrites } from './session-source-compose'
import { editSessionSource, unwrapSessionSourceWrite } from './session-source-edits'

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? /test-support|fixtures/.test(entry.name)
        ? []
        : productionFiles(path)
      : /\.tsx?$/.test(entry.name) &&
          !/\.test\.|\.spec\.|test-fixture|test-harness|store-test-helpers/.test(entry.name)
        ? [path]
        : []
  })
}

describe('session source boundary completeness', () => {
  it('classifies every source field exactly once', () => {
    expect(Object.keys(SESSION_SOURCE_KINDS).sort()).toEqual([...SESSION_SOURCE_FIELDS].sort())
  })

  it('keeps receipt-symbol access and write assertions inside the boundary', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const boundaries = new Set([
      'store/session-source-edits.ts',
      'store/session-source-write-boundary.ts',
      'store/editor-buffer-record-lifecycle.ts',
      'store/slices/agent-status/agent-status-runtime.ts'
    ])
    const violations = productionFiles(root).flatMap((path) => {
      if (boundaries.has(relative(root, path))) {
        return []
      }
      return /unwrapSessionSourceWrite|SESSION_SOURCE_RECEIPT|withSessionSourceReceipt|SessionSourceSnapshot|\bas\s+(?:unknown\s+as\s+)?SessionSourceWrite\b/.test(
        readFileSync(path, 'utf8')
      )
        ? [relative(root, path)]
        : []
    })
    expect(violations).toEqual([])
  })

  it('restricts complete source replacements to named full boundaries', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const replacements = new Set([
      'store/session-source-edits.ts',
      'store/session-source-write-boundary.ts',
      // A secondary window receives the main window's complete catalog snapshot.
      'space.tsx',
      'store/project-groups/project-group-catalog-actions.ts',
      'store/repos/runtime-repo-catalog-actions.ts',
      'store/repos/all-host-repo-catalog-actions.ts',
      'store/repos/repo-catalog-actions.ts',
      'store/repos/repo-ordering.ts',
      'store/folder-workspaces/folder-workspace-catalog-actions.ts',
      'store/terminals/workspace-terminal-hydration.ts',
      'store/slices/editor/actions/hydrate-editor-session.ts',
      'store/slices/tabs/tabs-session-actions.ts',
      'store/slices/browser/browser-hydration-actions.ts',
      'hooks/ipc-events/ssh-managed-server-state-effects.ts'
    ])
    const editReplacements = new Set([
      'store/session-source-edits.ts',
      // Persisted UI hydration reapplies the complete desktop-owned repo order.
      'store/slices/ui/ui-slice-hydration-actions.ts',
      // Rekeying preserves native insertion order through the order-only boundary.
      'store/slices/editor/actions/rekey-open-files-action.ts',
      'store/slices/editor/actions/restored-editor-owner-transition.ts',
      'store/slices/worktrees/teardown/purge-stale-runtime-host-state.ts'
    ])
    const violations = productionFiles(root).flatMap((path) => {
      const name = relative(root, path)
      const source = readFileSync(path, 'utf8')
      return (/\breplaceSessionSourceFields\b/.test(source) && !replacements.has(name)) ||
        (/\.replace\(\s*['"](?:editorDrafts|markdownFrontmatterVisible|repos|projectGroups|folderWorkspaces|worktreesByRepo|restoredRuntimeHostIdByWorkspaceSessionKey)['"]/.test(
          source
        ) &&
          !editReplacements.has(name))
        ? [name]
        : []
    })
    expect(violations).toEqual([])
  })

  it('refuses parallel whole-map partials and permits a sequential middleware chain', () => {
    const before = { editorDrafts: { a: 'A', b: 'B' } }
    const first = editSessionSource(before).set('editorDrafts', 'a', 'next').finish()
    const competing = editSessionSource(before).set('editorDrafts', 'b', 'next').finish()
    expect(() => composeSessionSourceWrites([first, competing])).toThrow(
      'Composed source writes overlap: editorDrafts'
    )
    const next = { ...before, ...unwrapSessionSourceWrite(first).partial }
    const middleware = editSessionSource(next).set('editorDrafts', 'b', 'joined').finish()
    expect(
      unwrapSessionSourceWrite(composeSessionSourceWrites([first, middleware], true)).partial
        .editorDrafts
    ).toEqual({
      a: 'next',
      b: 'joined'
    })
  })
})
