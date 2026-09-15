import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(process.cwd(), 'src/renderer/src')

function productionSourceFiles(directory = rendererRoot): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      return productionSourceFiles(path)
    }
    return /\.(?:ts|tsx)$/.test(path) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path) ? [path] : []
  })
}

function callerCounts(identifier: string): Record<string, number> {
  const counts: Record<string, number> = {}
  const call = new RegExp(`\\b${identifier}\\s*\\(`, 'g')
  for (const path of productionSourceFiles()) {
    const count = [...readFileSync(path, 'utf8').matchAll(call)].length
    if (count > 0) {
      counts[relative(process.cwd(), path)] = count
    }
  }
  return counts
}

const stateOnlySetActiveWorktreeCallers = {
  'src/renderer/src/components/settings/McpConfigSection.tsx': 2,
  'src/renderer/src/components/sidebar/hovered-workspace-delete.ts': 1,
  'src/renderer/src/components/sidebar/sleep-worktree-flow.ts': 2,
  'src/renderer/src/components/sidebar/use-worktree-card-workspace-actions.ts': 1,
  'src/renderer/src/components/sidebar/worktree-context-menu-delete-intent.ts': 1,
  'src/renderer/src/components/tab-group/workspace-tab-close-commands.ts': 1,
  'src/renderer/src/components/terminal-pane/TerminalPaneOverlayLayer.tsx': 1,
  'src/renderer/src/components/terminal-pane/terminal-handle-links.ts': 1,
  'src/renderer/src/components/terminal/terminal-tab-actions.ts': 1,
  'src/renderer/src/components/use-terminal-editor-close-queue.ts': 1,
  'src/renderer/src/hooks/automation-dispatch-handler.ts': 1,
  'src/renderer/src/hooks/ipc-events/mobile-terminal-close-ipc-bridge.ts': 2,
  'src/renderer/src/hooks/ipc-events/terminal-command-state.ts': 1,
  'src/renderer/src/hooks/ipc-events/terminal-ui-routing-ipc-bridge.ts': 2,
  'src/renderer/src/hooks/ipc-events/worktree-event-runtime.ts': 1,
  'src/renderer/src/lib/file-preview.ts': 2,
  'src/renderer/src/lib/http-link-routing.ts': 1,
  'src/renderer/src/runtime/web-runtime-session-workspace-selection.ts': 3,
  'src/renderer/src/store/slices/editor/actions/restored-editor-owner.ts': 1
}

function selectionCouplingViolations(source: string): string[] {
  const violations: string[] = []
  if (/providesInitialSurface|callerProvidesSurface|callerWillProvideSurface/.test(source)) {
    violations.push('legacy surface promise')
  }
  if (/recoverWorkspaceActivation\s*\(\s*\{[\s\S]{0,160}\.\.\.(?!identity\b)/.test(source)) {
    violations.push('options spread into recovery')
  }
  if (
    /(?:agent|picker|selection)[^\n]{0,120}(?:recoverWorkspaceActivation|registerWorkspaceSurfaceProducer)/i.test(
      source
    )
  ) {
    violations.push('selection controls recovery ownership')
  }
  if (/\.find\s*\([\s\S]{0,240}\blaunchAgent\b/.test(source)) {
    violations.push('selection-stamped legacy tab controls recovery')
  }
  return violations
}

describe('activation recovery architecture census', () => {
  it('classifies every general setter caller', () => {
    expect(callerCounts('setActiveWorktree')).toEqual({
      ...stateOnlySetActiveWorktreeCallers,
      'src/renderer/src/lib/worktree-activation.ts': 1
    })
  })

  it('keeps the folder setter distinct and owned only by the public activation service', () => {
    expect(callerCounts('setActiveFolderWorkspace')).toEqual({
      'src/renderer/src/lib/worktree-activation.ts': 1
    })
  })

  it('keeps the boundary API to four exports with no creation or general-seeder dependency', () => {
    const source = readFileSync(join(rendererRoot, 'lib/worktree-activation-recovery.ts'), 'utf8')
    const exports = [
      ...source.matchAll(/^export (?:async )?(?:type |function )([A-Za-z0-9_]+)/gm)
    ].map((match) => match[1])
    expect(exports).toEqual([
      'WorkspaceActivationIdentity',
      'WorkspaceActivationContext',
      'WorkspaceActivationRecoveryResult',
      'recoverWorkspaceActivation'
    ])
    expect(source).not.toContain('worktree-creation')
    expect(source).not.toContain('ensureWorktreeHasInitialTerminal')
    expect(source).not.toContain('gateWorktreeAgentActivation')
    expect(source).not.toContain('.createTab(')
  })

  it('detects aliases, option spreading, picker conditionals, and picker-minted fake claims', () => {
    const fixtures = [
      `const callerWillProvideSurface = options.agent != null\nrecoverWorkspaceActivation(identity, { mode: 'explicit', callerWillProvideSurface })`,
      `recoverWorkspaceActivation({ ...options }, context)`,
      `if (selection.agent) recoverWorkspaceActivation(identity, context)`,
      `if (picker.agent) registerWorkspaceSurfaceProducer(identity)`,
      `const launchAgent = selection.agent
       const tab = tabs.find((candidate) => candidate.launchAgent === launchAgent)
       if (tab) useSurface(tab)
       else recoverWorkspaceActivation(identity, context)`
    ]
    for (const fixture of fixtures) {
      expect(selectionCouplingViolations(fixture)).not.toEqual([])
    }
  })

  it('routes all production recovery requests through the owner, watcher, or create failure adapter', () => {
    const callers = {
      'src/renderer/src/components/use-terminal-watcher-effects.ts': 1,
      'src/renderer/src/lib/workspace-activation-recovery-retry.ts': 1,
      'src/renderer/src/lib/worktree-activation-recovery-routing.ts': 1,
      'src/renderer/src/lib/worktree-activation-recovery.ts': 1,
      'src/renderer/src/lib/worktree-creation-flow-execute.ts': 1
    }
    expect(callerCounts('recoverWorkspaceActivation')).toEqual(callers)
    for (const path of Object.keys(callers)) {
      expect(selectionCouplingViolations(readFileSync(join(process.cwd(), path), 'utf8'))).toEqual(
        []
      )
    }
  })

  it('cleans recovery ownership on workspace deletion and execution-host retirement', () => {
    expect(callerCounts('clearWorkspaceActivationRecoveryLifecycle')).toEqual({
      'src/renderer/src/lib/workspace-activation-recovery-lifecycle.ts': 1,
      'src/renderer/src/store/folder-workspaces/folder-workspace-mutations.ts': 1,
      'src/renderer/src/store/project-groups/project-group-mutations.ts': 1,
      'src/renderer/src/store/slices/ssh.ts': 1,
      'src/renderer/src/store/slices/worktrees/session/worktree-slice-lookups.ts': 1,
      'src/renderer/src/store/slices/worktrees/teardown/purge-stale-runtime-host-state.ts': 1,
      'src/renderer/src/store/slices/worktrees/teardown/remove-worktree-store-cleanup.ts': 1
    })
  })
})
