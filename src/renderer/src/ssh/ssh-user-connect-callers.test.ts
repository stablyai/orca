import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `ssh.connect` is the user's Connect: it records that they want the host connected, which
 * lifts a Disconnect they made. Anything the user did not click must use `ensureConnected`,
 * which the host refuses while their Disconnect holds. So every caller of the user's connect
 * is pinned here, and a new one has to be a real click someone reviewed.
 */
const RENDERER_ROOT = resolve(__dirname, '..')

const USER_CONNECT_CALL_SITES: Record<string, readonly string[]> = {
  // Direct calls into the preload's user connect.
  'ssh.connect(': [
    'components/NewWorkspaceComposerCard.tsx',
    'components/automations/use-automation-host-catalog.ts',
    'components/settings/SshPane.tsx',
    'components/sidebar/AddRepoSteps.tsx',
    'components/sidebar/ForgetSshWorkspaceDialog.tsx',
    'components/sidebar/use-add-repo-host-selection.ts',
    'components/status-bar/SshTargetStatusRow.tsx',
    'hooks/composer-state/host-runtime-effects.ts',
    'ssh/ssh-user-connect.ts'
  ],
  // The shared click handler behind a host control's Connect button.
  'connectSshTargetForUser(': [
    'components/sidebar/WorktreeCardSshHostControl.tsx',
    'components/terminal-pane/TerminalSshReconnectOverlay.tsx',
    'ssh/use-user-disconnected-host-connect.ts'
  ],
  // The Connect a pane card offers while the user's Disconnect holds its host down.
  'useUserDisconnectedHostConnect(': [
    'components/browser-pane/assemble-chrome/ssh-routed-browser-page-gate.tsx',
    'components/editor/EditorFileLoadErrorView.tsx',
    'components/right-sidebar/FileExplorerTreeStatus.tsx'
  ],
  // A remote server's `ssh.connect` without the background flag is that server's user connect.
  'connectRuntimeEnvironmentSshTarget(': ['ssh/ssh-user-connect.ts']
}

const DEFINITIONS = new Set([
  'ssh/ssh-user-connect.ts:connectSshTargetForUser(',
  'ssh/use-user-disconnected-host-connect.ts:useUserDisconnectedHostConnect(',
  'runtime/runtime-environment-ssh-state.ts:connectRuntimeEnvironmentSshTarget('
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || /test-(?:harness|fixture|environment)/.test(path)
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full))
    } else if (/\.tsx?$/.test(entry) && !isTestFile(full)) {
      found.push(full)
    }
  }
  return found
}

function callersOf(needle: string, sources: readonly string[]): string[] {
  const pattern = new RegExp(`(?<![\\w.])(?:window\\.api\\.)?${needle.replace(/[.(]/g, '\\$&')}`)
  return sources
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(RENDERER_ROOT, path).split('\\').join('/'))
    .filter((path) => !DEFINITIONS.has(`${path}:${needle}`))
    .sort()
}

describe("the user's SSH connect is only reachable from a user's click", () => {
  const sources = collectSourceFiles(RENDERER_ROOT)

  for (const [needle, allowed] of Object.entries(USER_CONNECT_CALL_SITES)) {
    it(`pins every caller of ${needle}`, () => {
      expect(callersOf(needle, sources)).toEqual([...allowed].sort())
    })
  }
})
