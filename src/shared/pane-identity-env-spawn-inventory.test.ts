import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'
import {
  blankStringContents,
  blankStringContentsDesynced,
  stripComments
} from './source-scan/source-tree-scan'
import { PANE_IDENTITY_ENV_KEYS } from './pane-identity-env'

// Why this ratchet exists: 34 non-test source files name ORCA_AGENT_LAUNCH_TOKEN and 10 of them
// actually author it, but nothing stated the rule that produces it. A spawn that reuses a pane
// key a previous launch already owned must stamp a launch token, because the token is Orca's only
// in-band proof of authorship and the status fences read a tokenless post as foreign. Two paths
// shipped without it — the detached-pane restart (#17243) and the relay's revive — each found by
// accident. Adding a pane-identity env site now forces a deliberate classification here instead
// of silently joining the broken half.
type TokenBehavior =
  /** Mints a fresh token: this spawn reuses or claims a pane key, so it must prove authorship. */
  | 'mints-token'
  /** Forwards a token it was handed; absence is the caller's decision, not this site's. */
  | 'propagates-token'
  /** Deliberately tokenless: a non-agent pane on a pane key no prior launch owned. */
  | 'no-agent-launch'
  /** Removes pane identity rather than authoring it (a scrub or an admission fence). */
  | 'strips-identity'

type Site = { path: string; behavior: TokenBehavior; marker: string }

const INVENTORY: readonly Site[] = [
  {
    path: 'src/renderer/src/components/terminal-pane/codex-detached-pane-restart.ts',
    behavior: 'mints-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: createBrowserUuid()'
  },
  {
    path: 'src/renderer/src/lib/adopt-agent-background-session-tab.ts',
    behavior: 'mints-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: launchToken'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/pty-connection/agent-idle-working-handlers.ts',
    behavior: 'propagates-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: session.launchToken'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/pty-connection/deferred-cold-restore-and-snapshot.ts',
    behavior: 'propagates-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: env.ORCA_AGENT_LAUNCH_TOKEN'
  },
  {
    path: 'src/renderer/src/components/terminal-pane/pty-connection/cold-restore-resume-startup.ts',
    behavior: 'mints-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: coldRestoreLaunchToken'
  },
  {
    // Why tokenless is correct: setup scripts and default tabs carry no launchConfig and land on
    // freshly minted pane keys, so no fence can exist for them to fail.
    path: 'src/renderer/src/lib/launch-worktree-background-terminals.ts',
    behavior: 'no-agent-launch',
    marker: 'ORCA_PANE_KEY: makePaneKey(tabId, leafId)'
  },
  {
    // Mints only for a launchConfig spawn (an agent); a bare workspace terminal stays tokenless.
    path: 'src/main/runtime/orca-runtime.ts',
    behavior: 'mints-token',
    marker: 'ORCA_AGENT_LAUNCH_TOKEN: launchToken'
  },
  {
    path: 'src/main/ipc/pty/ipc/spawn-env.ts',
    behavior: 'strips-identity',
    marker: 'delete ctx.baseEnv.ORCA_AGENT_LAUNCH_TOKEN'
  },
  {
    path: 'src/main/ipc/pty/provider/liveness.ts',
    behavior: 'strips-identity',
    marker: 'delete stripped.ORCA_AGENT_LAUNCH_TOKEN'
  },
  {
    path: 'src/main/daemon/pty-subprocess/spawn-environment.ts',
    behavior: 'strips-identity',
    marker: 'removeUnspecifiedPaneIdentityEnv(env, opts.env)'
  },
  {
    path: 'src/relay/pty-handler.ts',
    behavior: 'strips-identity',
    marker: 'removeUnspecifiedPaneIdentityEnv(result, rendererEnv)'
  }
]

/** Names the var without authoring pane identity: hook-script emitters and passthrough allowlists. */
const NON_AUTHORING = new Set([
  'src/main/agent-hooks/hook-post-command.ts',
  'src/main/agent-hooks/hook-stdin-contract.ts',
  'src/main/agent-hooks/installer-utils.ts',
  'src/main/amp/agent-status-plugin-source.ts',
  'src/main/antigravity/hook-script.ts',
  'src/main/command-code/command-code-managed-script.ts',
  'src/main/copilot/copilot-managed-script.ts',
  'src/main/cursor/hook-script.ts',
  'src/main/cursor/hook-service.ts',
  'src/main/devin/hook-service.ts',
  'src/main/droid/hook-service.ts',
  'src/main/gemini/hook-service.ts',
  'src/main/grok/grok-hook-script.ts',
  'src/main/hermes/hermes-managed-plugin-source.ts',
  'src/main/kimi/hook-service.ts',
  'src/main/opencode/status-plugin-post-source.ts',
  'src/main/pi/agent-status-extension-source.ts',
  'src/main/providers/local-pty-launch-helpers.ts',
  'src/main/pty/wsl-orca-env.ts',
  'src/main/ssh/ssh-remote-cli-host-passthrough.ts',
  'src/main/ipc/pty/pane/launch-authority.ts',
  'src/relay/remote-cli-env.ts',
  'src/shared/orchestration-compatibility-evidence.ts',
  'src/shared/pane-identity-env.ts'
])

describe('pane identity env spawn-site ratchet', () => {
  it('classifies every file that names the launch token', async () => {
    const files = await glob(['src/**/*.{ts,tsx}'], { ignore: ['**/*.test.*', '**/*.spec.*'] })
    const found: string[] = []
    for (const path of files) {
      const raw = readFileSync(join(process.cwd(), path), 'utf8')
      if (!raw.includes('ORCA_AGENT_LAUNCH_TOKEN')) {
        continue
      }
      const decommented = stripComments(raw)
      if (blankStringContentsDesynced(decommented)) {
        throw new Error(`String scanner desynchronized while inventorying ${path}`)
      }
      // Why the decommented+blanked read: a mention inside a comment or an emitted shell snippet
      // is not this file authoring pane identity.
      if (!blankStringContents(decommented).includes('ORCA_AGENT_LAUNCH_TOKEN')) {
        continue
      }
      found.push(path)
    }
    const classified = new Set([...INVENTORY.map((site) => site.path), ...NON_AUTHORING])
    expect(found.filter((path) => !classified.has(path)).sort()).toEqual([])
  })

  it('pins the token decision each inventoried spawn site actually makes', () => {
    for (const site of INVENTORY) {
      const source = stripComments(readFileSync(join(process.cwd(), site.path), 'utf8'))
      expect({
        path: site.path,
        behavior: site.behavior,
        present: source.includes(site.marker)
      }).toEqual({
        path: site.path,
        behavior: site.behavior,
        present: true
      })
    }
  })

  it('keeps both PTY hosts scrubbing the same pane identity key set', () => {
    // Why: the daemon and the relay each inherit a process env that names whichever pane their
    // host was launched from. One host drifting from the shared key set is how the relay lost the
    // launch token while the daemon kept it.
    expect([...PANE_IDENTITY_ENV_KEYS]).toEqual([
      'ORCA_PANE_KEY',
      'ORCA_TAB_ID',
      'ORCA_WORKTREE_ID',
      'ORCA_AGENT_LAUNCH_TOKEN'
    ])
    for (const path of [
      'src/main/daemon/pty-subprocess/spawn-environment.ts',
      'src/relay/pty-handler.ts'
    ]) {
      const source = stripComments(readFileSync(join(process.cwd(), path), 'utf8'))
      expect({ path, scrubs: source.includes('removeUnspecifiedPaneIdentityEnv(') }).toEqual({
        path,
        scrubs: true
      })
    }
  })
})
