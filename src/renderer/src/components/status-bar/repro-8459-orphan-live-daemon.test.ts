/**
 * Issue #8459 — Resource Manager misclassifies live daemon sessions as orphans
 * and force-kills them without confirmation.
 *
 * "Orphan" is defined only as absence from the renderer's binding index
 * (tabs / ptyIdsByTabId / layout wake hints). A recovering or incomplete
 * renderer can leave live daemon sessions unbound → bulk kill skips confirm.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/status-bar/repro-8459-orphan-live-daemon.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildResourceSessionBindingIndex,
  countUnboundDaemonSessions
} from './resource-session-bindings'
import type { DaemonSession } from './resource-usage-merge-types'
import type { TerminalTab } from '../../../../shared/types'

/** Mirrors ResourceUsageStatusSegment.handleKillSession / handleKillOrphans. */
function shouldSkipKillConfirmation(bound: boolean): boolean {
  // Unbound (orphan) rows kill immediately; bound rows open confirm.
  return !bound
}

function selectOrphanSessions(
  sessions: readonly DaemonSession[],
  boundPtyIds: ReadonlySet<string>
): DaemonSession[] {
  return sessions.filter((s) => !boundPtyIds.has(s.id))
}

describe('issue #8459 live daemon sessions classified as kill-safe orphans', () => {
  const liveDaemonSessions: DaemonSession[] = [
    { id: 'pty-daemon-claude', cwd: '/Users/me/ws', title: 'claude' },
    { id: 'pty-daemon-codex', cwd: '/Users/me/ws', title: 'codex' },
    { id: 'pty-daemon-shell', cwd: '/tmp', title: 'bash' }
  ]

  it('counts every live daemon session as unbound when the renderer binding index is empty', () => {
    // workspaceSessionReady=true with empty tabs is a recovering/mismatched
    // renderer: Resource Manager still treats all daemon sessions as orphans.
    const incompleteBindings = {
      ptyIdsByTabId: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      workspaceSessionReady: true
    }

    expect(countUnboundDaemonSessions(liveDaemonSessions, incompleteBindings)).toBe(3)

    const index = buildResourceSessionBindingIndex(incompleteBindings)
    expect(index.boundPtyIds.size).toBe(0)
    const orphans = selectOrphanSessions(liveDaemonSessions, index.boundPtyIds)
    expect(orphans.map((s) => s.id)).toEqual([
      'pty-daemon-claude',
      'pty-daemon-codex',
      'pty-daemon-shell'
    ])
    // Every "orphan" skips the bound-session confirm dialog.
    for (const orphan of orphans) {
      expect(shouldSkipKillConfirmation(false)).toBe(true)
      expect(index.boundPtyIds.has(orphan.id)).toBe(false)
    }
  })

  it('does not revalidate daemon ownership/liveness before labeling unbound', () => {
    // Even if the session list came from a live daemon inventory, classification
    // only checks the renderer map — no pid / owner / generation check.
    const partialBindings = {
      ptyIdsByTabId: { 'tab-1': ['pty-daemon-shell'] },
      tabsByWorktree: {
        'repo::/Users/me/ws': [
          {
            id: 'tab-1',
            ptyId: 'pty-daemon-shell',
            worktreeId: 'repo::/Users/me/ws',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            type: 'terminal',
            paneCount: 1
          } as unknown as TerminalTab
        ]
      },
      terminalLayoutsByTabId: {},
      workspaceSessionReady: true
    }

    const unbound = countUnboundDaemonSessions(liveDaemonSessions, partialBindings)
    // Two live agent PTYs remain "orphans" solely because the renderer map
    // does not reference them — not because they lack a process.
    expect(unbound).toBe(2)
  })

  it('UI kill paths skip confirmation for unbound sessions and bulk-kill without revalidation', () => {
    const src = readFileSync(join(__dirname, 'ResourceUsageStatusSegment.tsx'), 'utf8')
    expect(src).toMatch(/Skip the confirm dialog for orphans/)
    expect(src).toMatch(/if \(!session\.bound\)/)
    expect(src).toMatch(/const orphans = sessions\.filter\(\(s\) => !bound\.has\(s\.id\)\)/)
    // Bulk kill fires immediately — no confirm setState for orphans.
    expect(src).toMatch(
      /Promise\.allSettled\(orphans\.map\(\(s\) => window\.api\.pty\.kill\(s\.id\)\)\)/
    )
    // Classification helper has no daemon-ownership or pid liveness check.
    const bindingsSrc = readFileSync(join(__dirname, 'resource-session-bindings.ts'), 'utf8')
    expect(bindingsSrc).not.toMatch(/pid|foreground|owner|generation/i)
    expect(bindingsSrc).toMatch(/boundPtyIds\.has\(session\.id\)/)
  })
})
