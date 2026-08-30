import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The leaking population, computed rather than quoted.
 *
 * The case for the boundary rests on a number, and the number had only ever been written down: the
 * enumeration that produced it did not survive into the repository, so the figure in the PR body
 * could not be checked by anyone reading it. Three independent attempts on this population reported
 * 115, 118 and 137, which is what an unreproducible census looks like from outside. This file is the
 * census itself, so the figure is whatever running it says.
 *
 * ## The axis
 *
 * One axis, stated so a disagreeing count can be attributed instead of argued: **renderer
 * expressions that pass a rejection's free text into a render sink, in a module that talks to the
 * preload surface**. Concretely, an expression is counted when all of these hold:
 *
 * - it is an argument to a `toast.*(…)` call or to a `set<Name>(…)` state setter;
 * - it reads free text off a binding introduced by `catch (…)` or `.catch(…)` in the same module —
 *   `binding.message`, `String(binding)` or `${binding}`;
 * - that argument does not route through `extractIpcErrorMessage` or `stripIpcInvokeEnvelope`;
 * - the module contains a `window.api.*` call, so a rejection reaching it can have crossed IPC.
 *
 * ## What it cannot see
 *
 * Stated rather than implied, because this population has been undercounted repeatedly. It is regex
 * over source, not dataflow, so it is a floor and not a total:
 *
 * - text laundered through an intermediate variable, a helper in another module, or a store action
 *   not named `set*`, is invisible to it;
 * - its sinks are `toast.*` and `set*` only — direct JSX rendering of `{err.message}`, error
 *   boundaries and `alert` are not counted;
 * - it cannot see event-channel payloads: `ipcRenderer.on` is not `invoke`, so a main-process string
 *   arriving over an event is outside both this census and the fix;
 * - the `window.api.*` test is module-level, so a module that both calls the preload surface and
 *   catches something else contributes a false positive, and a module that receives its rejection
 *   from a caller contributes a false negative.
 *
 * ## Before and after
 *
 * The "before" is what this file computes. The "after" is not a second scan and cannot be: the fix
 * is upstream of every expression counted here, so the source is textually identical either side of
 * it and re-running the census would report the same number. What changes is the value that arrives.
 * The after-column is carried by two other running tests, and this file is only honest alongside
 * them: `ipc-invoke-boundary-bridge.electron.test.ts` shows a renderer consumer receiving the
 * narrowed reason across a real `contextBridge`, and `ipc-invoke-boundary-ratchet.test.ts` shows
 * that the wrapper is the only path to `ipcRenderer.invoke`, which is what makes that observation
 * general rather than anecdotal.
 *
 * To regenerate `LEAKING_EXPRESSIONS` after a legitimate change, run this file: the failure prints
 * the current population as a diff against the recorded one.
 */
const REPO_ROOT = resolve(__dirname, '../../../..')
const RENDERER_ROOT = join(REPO_ROOT, 'src/renderer/src')
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/** Every leaking expression, by module. Computed by this file; not transcribed from anywhere. */
const LEAKING_EXPRESSIONS: Readonly<Record<string, number>> = {
  'src/renderer/src/app-shell/use-app-session-persistence.ts': 1,
  'src/renderer/src/components/GitLabItemDialog.tsx': 2,
  'src/renderer/src/components/LinearItemDrawer.tsx': 1,
  'src/renderer/src/components/NewWorkspaceComposerCard.tsx': 1,
  'src/renderer/src/components/Terminal.tsx': 1,
  'src/renderer/src/components/browser-pane/ClientHostedBrowserPagePane.tsx': 1,
  'src/renderer/src/components/editor/useIpynbCellExecution.ts': 1,
  'src/renderer/src/components/emulator-pane/use-mobile-emulator-agent-setup-state.ts': 2,
  'src/renderer/src/components/feature-tips/CliSkillSetupTerminal.tsx': 1,
  'src/renderer/src/components/github-item-dialog/inspect-pull-request/checks-tab-actions.ts': 2,
  'src/renderer/src/components/github-item-dialog/land-pull-request/pr-actions-panel.tsx': 1,
  'src/renderer/src/components/github-project/slug-dialog/SlugDialogBody.tsx': 1,
  'src/renderer/src/components/jira-connect-dialog.tsx': 1,
  'src/renderer/src/components/linear-api-key-dialog.tsx': 1,
  'src/renderer/src/components/new-workspace/pick-local-project-folder.ts': 1,
  'src/renderer/src/components/onboarding/ThemeStep.tsx': 1,
  'src/renderer/src/components/onboarding/use-onboarding-flow-persistence.ts': 2,
  'src/renderer/src/components/pull-request-page/actions/merge-actions.ts': 3,
  'src/renderer/src/components/pull-request-page/checks/refresh.ts': 1,
  'src/renderer/src/components/pull-request-page/checks/rerun.ts': 1,
  'src/renderer/src/components/right-sidebar/ai-vault-session-launch-actions.ts': 1,
  'src/renderer/src/components/right-sidebar/ai-vault-session-refresh.ts': 1,
  'src/renderer/src/components/right-sidebar/checks-panel/use-checks-panel-create-review.tsx': 1,
  'src/renderer/src/components/right-sidebar/source-control/review/use-create-pr-intent-review.ts': 1,
  'src/renderer/src/components/right-sidebar/source-control/review/use-hosted-review-creation.ts': 1,
  'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-commit-actions.ts': 1,
  'src/renderer/src/components/right-sidebar/use-hosted-review-actions.ts': 2,
  'src/renderer/src/components/right-sidebar/useFileExplorerKeys.ts': 1,
  'src/renderer/src/components/settings/AgentSkillSetupPanel.tsx': 1,
  'src/renderer/src/components/settings/BrowserUseExamples.tsx': 1,
  'src/renderer/src/components/settings/BrowserUsePane.tsx': 1,
  'src/renderer/src/components/settings/CliSection.tsx': 3,
  'src/renderer/src/components/settings/CliSkillRuntimeSetup.tsx': 1,
  'src/renderer/src/components/settings/ComputerUsePane.tsx': 3,
  'src/renderer/src/components/settings/EphemeralVmRuntimesSection.tsx': 4,
  'src/renderer/src/components/settings/EphemeralVmsPane.tsx': 1,
  'src/renderer/src/components/settings/GrokAccountsSection.tsx': 1,
  'src/renderer/src/components/settings/KeybindingsFileActions.tsx': 2,
  'src/renderer/src/components/settings/ManageSessionsSection.tsx': 2,
  'src/renderer/src/components/settings/MobileEmulatorAvailabilityDetails.tsx': 2,
  'src/renderer/src/components/settings/MobileEmulatorExamples.tsx': 1,
  'src/renderer/src/components/settings/OrchestrationSkillPromptDialog.tsx': 1,
  'src/renderer/src/components/settings/RepositoryIconTabs.tsx': 1,
  'src/renderer/src/components/settings/RuntimePairingUrlGenerator.tsx': 4,
  'src/renderer/src/components/settings/SkillUsageExampleDialog.tsx': 1,
  'src/renderer/src/components/settings/SshPane.tsx': 8,
  'src/renderer/src/components/settings/SshPassphraseDialog.tsx': 2,
  'src/renderer/src/components/settings/VoicePane.tsx': 2,
  'src/renderer/src/components/settings/WslCliRegistration.tsx': 3,
  'src/renderer/src/components/settings/bitbucket-credentials-dialog.tsx': 1,
  'src/renderer/src/components/settings/bitbucket-integration-card.tsx': 1,
  'src/renderer/src/components/settings/linear-agent-skill-install-cta.tsx': 1,
  'src/renderer/src/components/shared/useDaemonActions.tsx': 2,
  'src/renderer/src/components/sidebar/AddRemoteHostDialog.tsx': 2,
  'src/renderer/src/components/sidebar/AddRepoSteps.tsx': 1,
  'src/renderer/src/components/sidebar/ForgetSshWorkspaceDialog.tsx': 2,
  'src/renderer/src/components/sidebar/HostRemoveDialog.tsx': 1,
  'src/renderer/src/components/sidebar/HostSectionHeaderMenu.tsx': 2,
  'src/renderer/src/components/sidebar/NonGitFolderDialog.tsx': 1,
  'src/renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx': 1,
  'src/renderer/src/components/sidebar/WorktreeCardSshHostControl.tsx': 1,
  'src/renderer/src/components/sidebar/use-add-repo-host-selection.ts': 2,
  'src/renderer/src/components/sidebar/useSidebarProjectDrop.ts': 1,
  'src/renderer/src/components/status-bar/SshStatusSegment.tsx': 1,
  'src/renderer/src/components/status-bar/SshTargetStatusRow.tsx': 2,
  'src/renderer/src/components/tab-group/AiVaultSessionDropLayer.tsx': 1,
  'src/renderer/src/components/task-page/hooks/use-task-page-create-github-submit.ts': 1,
  'src/renderer/src/components/terminal-pane/TerminalSshReconnectOverlay.tsx': 1,
  'src/renderer/src/hooks/composer-state/attachment-drop-state.ts': 1,
  'src/renderer/src/hooks/composer-state/gitlab-provider-selection.ts': 1,
  'src/renderer/src/hooks/composer-state/host-runtime-effects.ts': 2,
  'src/renderer/src/hooks/ipc-events/content-creation-ipc-bridge.ts': 4,
  'src/renderer/src/hooks/ipc-events/direct-ssh-bridge-runtime.ts': 1,
  'src/renderer/src/hooks/ipc-events/remote-workspace-ipc-bridge.ts': 1,
  'src/renderer/src/hooks/useEphemeralVmRecipeOptions.ts': 1,
  'src/renderer/src/lib/agent-skill-cli-prerequisite.ts': 1,
  'src/renderer/src/lib/http-link-routing.ts': 1,
  'src/renderer/src/lib/launch-work-item-direct.ts': 1,
  'src/renderer/src/lib/sidebar-worktree-activation.ts': 1,
  'src/renderer/src/store/project-groups/nested-repository-operations.ts': 1,
  'src/renderer/src/store/repos/repo-removal.ts': 1,
  'src/renderer/src/store/slices/orca-profiles-auth-actions.ts': 5,
  'src/renderer/src/store/slices/orca-profiles.ts': 3,
  'src/renderer/src/store/slices/settings.ts': 1
}

type Module = { path: string; source: string }

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectModules(root: string): Module[] {
  const found: Module[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectModules(full))
    } else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !isTestFile(full)) {
      found.push({
        path: relative(REPO_ROOT, full).replaceAll('\\', '/'),
        source: readFileSync(full, 'utf8')
      })
    }
  }
  return found
}

/** Strings go too: their contents are prose, and their parentheses would break argument balancing. */
function withoutCommentsOrStringBodies(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, '""')
}

/** Bindings a rejection can arrive on: `catch (e)` and the `.catch(e => …)` callback parameter. */
function rejectionBindings(source: string): string[] {
  const names = new Set<string>()
  for (const [, name] of source.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(name)
  }
  for (const [, name] of source.matchAll(/\.catch\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/g)) {
    names.add(name)
  }
  names.delete('function')
  names.delete('async')
  return [...names]
}

function balancedArgument(source: string, openParenIndex: number): string {
  let depth = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    if (source[index] === '(') {
      depth += 1
    } else if (source[index] === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(openParenIndex + 1, index)
      }
    }
  }
  return source.slice(openParenIndex + 1)
}

const SINK = /\btoast\s*(?:\.\s*[\w$]+)?\s*\(|\bset[A-Z][\w$]*\s*\(/g
const ALREADY_STRIPPED = /extractIpcErrorMessage\s*\(|stripIpcInvokeEnvelope/
const REACHES_PRELOAD = /\bwindow\s*\.\s*api\s*\./

export function censusLeakingExpressions(modules: readonly Module[]): Record<string, number> {
  const leaking: Record<string, number> = {}
  for (const { path, source } of modules) {
    const cleaned = withoutCommentsOrStringBodies(source)
    if (!REACHES_PRELOAD.test(cleaned)) {
      continue
    }
    const bindings = rejectionBindings(cleaned)
    if (bindings.length === 0) {
      continue
    }
    const alternation = bindings.join('|')
    const readsFreeText = new RegExp(
      `\\b(?:${alternation})\\b\\s*\\.\\s*message\\b` +
        `|String\\(\\s*(?:${alternation})\\s*\\)` +
        `|\\$\\{\\s*(?:${alternation})\\s*\\}`
    )
    SINK.lastIndex = 0
    while (SINK.exec(cleaned) !== null) {
      const argument = balancedArgument(cleaned, SINK.lastIndex - 1)
      if (readsFreeText.test(argument) && !ALREADY_STRIPPED.test(argument)) {
        leaking[path] = (leaking[path] ?? 0) + 1
      }
    }
  }
  return leaking
}

/**
 * A module written to leak, injected rather than written to disk so the controls cannot leave the
 * tree mutated if the run is interrupted.
 */
const PLANTED_LEAK: Module = {
  path: 'src/renderer/src/planted-control.ts',
  source: `
    import { toast } from 'sonner'
    export async function planted(): Promise<void> {
      try {
        await window.api.ssh.addTarget()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    }
  `
}

describe('the renderer expressions that would render an IPC envelope', () => {
  const treeModules = collectModules(RENDERER_ROOT)

  it('are these, at these counts', () => {
    expect(censusLeakingExpressions(treeModules)).toEqual(LEAKING_EXPRESSIONS)
  })

  it('total 131 expressions across 84 modules', () => {
    const census = censusLeakingExpressions(treeModules)
    const total = Object.values(census).reduce((sum, count) => sum + count, 0)

    expect(total).toBe(131)
    expect(Object.keys(census)).toHaveLength(84)
  })

  /**
   * The control the previous census never had: a census nobody has shown can detect the thing is
   * not evidence that the thing is absent.
   */
  it('detects a planted leak, and counts exactly the one', () => {
    const before = censusLeakingExpressions(treeModules)
    const after = censusLeakingExpressions([...treeModules, PLANTED_LEAK])

    expect(after[PLANTED_LEAK.path]).toBe(1)
    expect(Object.keys(after)).toHaveLength(Object.keys(before).length + 1)
  })

  /** The other half of the control: the detector has to be able to say no, or it says nothing. */
  it('does not count the same expression once it is stripped, or outside the preload surface', () => {
    const stripped: Module = {
      path: PLANTED_LEAK.path,
      source: PLANTED_LEAK.source.replace(
        'err instanceof Error ? err.message : String(err)',
        'extractIpcErrorMessage(err)'
      )
    }
    const noPreloadCall: Module = {
      path: PLANTED_LEAK.path,
      source: PLANTED_LEAK.source.replace('window.api.ssh.addTarget()', 'somethingLocal()')
    }

    expect(censusLeakingExpressions([stripped])).toEqual({})
    expect(censusLeakingExpressions([noPreloadCall])).toEqual({})
  })
})
