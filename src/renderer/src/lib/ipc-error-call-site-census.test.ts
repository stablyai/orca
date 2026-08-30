import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Why an enumeration and not a count: the previous note on this reader put its population at 18
 * and said the sites depended on its fail-open behaviour. The real number is 31, and every one
 * of them renders the result to a user, so "these can keep the looser regex" was never a choice
 * anybody had made. A count is easy to be wrong about; this produces the list.
 *
 * `surface` is where the returned string lands. `+classifier` marks the two sites that also
 * match on the string before rendering it — they read a reason, never the envelope, so opening
 * the envelope first is what makes those matches reliable.
 */
const CALL_SITES: Readonly<Record<string, { calls: number; surface: string }>> = {
  'src/renderer/src/components/editor/rich-markdown-image-insert.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/editor/rich-markdown-paste-image.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/components/editor/useLocalImagePick.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx': {
    calls: 2,
    surface: 'toast'
  },
  'src/renderer/src/components/native-chat/native-chat-attachment-upload.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/native-chat/use-native-chat-composer-paste.ts': {
    calls: 1,
    surface: 'composer notice'
  },
  'src/renderer/src/components/right-sidebar/file-explorer-row-file-transfer.ts': {
    calls: 2,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileDuplicate.ts': { calls: 2, surface: 'toast' },
  'src/renderer/src/components/right-sidebar/useFileExplorerImport.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileExplorerInlineInput.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/right-sidebar/useFileExplorerMoveDrop.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/components/settings/McpConfigSection.tsx': {
    calls: 2,
    surface: 'toast and settings banner'
  },
  'src/renderer/src/components/settings/mcp-config-inspection.ts': {
    calls: 2,
    surface: 'config row'
  },
  'src/renderer/src/components/sidebar/AddRepoSteps.tsx': {
    calls: 1,
    surface: 'dialog error+classifier'
  },
  'src/renderer/src/components/sidebar/useAddRepoCloneFlow.ts': {
    calls: 1,
    surface: 'dialog error'
  },
  'src/renderer/src/components/sidebar/useCreateRepo.ts': { calls: 1, surface: 'dialog error' },
  'src/renderer/src/components/task-page/hooks/use-task-page-gitlab-fetch.ts': {
    calls: 1,
    surface: 'task list banner, via the errs buffer whose first entry the banner renders'
  },
  'src/renderer/src/components/terminal-pane/ipc-pty-connect.ts': {
    calls: 1,
    surface: 'terminal error+classifier'
  },
  'src/renderer/src/components/terminal-pane/terminal-native-file-drop.ts': {
    calls: 4,
    surface: 'toast'
  },
  'src/renderer/src/components/terminal-pane/terminal-remote-file-download-open.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/lib/rename-file.ts': { calls: 1, surface: 'toast' },
  'src/renderer/src/store/slices/editor/actions/markdown-preview-actions.ts': {
    calls: 1,
    surface: 'toast'
  },
  'src/renderer/src/store/slices/editor/actions/open-file-apply.ts': { calls: 1, surface: 'toast' }
}

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return []
    }
    return [fullPath]
  })
}

// Why: prose about the reader is not a call of it, and test-support modules stub it rather than
// render anything.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// Why: the declaration reads as a call to a plain text match, so it is excluded by name rather
// than by regex — a narrower pattern would also drop a real call written across two lines.
const DECLARING_MODULE = 'src/renderer/src/lib/ipc-error.ts'
const ENVELOPE_MODULE = 'src/shared/ipc-invoke-envelope.ts'

/**
 * The other half of the population.
 *
 * A caller that must not fall back to the wrapper text branches on null instead, so it reaches for
 * the stripper directly and never appears in CALL_SITES above. Counting only `extractIpcErrorMessage`
 * reports 31 and reads as a total; it is not one, and the last person to freeze a number here was
 * wrong for exactly this reason. Both lists together are the set of modules that open the envelope.
 */
const DIRECT_STRIPPER_SITES: Readonly<Record<string, { calls: number; surface: string }>> = {
  // The boundary itself: not a surface but the source of every message the rest of this list reads.
  'src/preload/ipc-invoke-boundary.ts': {
    calls: 1,
    surface: 'every preload binding — the rejection the renderer receives'
  },
  'src/renderer/src/components/LinuxPackageInstallRecoveryCard.tsx': {
    calls: 1,
    surface: 'recovery card'
  },
  'src/renderer/src/components/quick-open-file-list.ts': { calls: 1, surface: 'quick-open list' },
  'src/renderer/src/components/right-sidebar/source-control/commit/use-discard-confirmation.ts': {
    calls: 1,
    surface:
      'discard-all toast description — null drops the description, the title still names the failure'
  },
  'src/renderer/src/components/settings/VoiceSpeechModelSection.tsx': {
    calls: 1,
    surface: 'settings row'
  },
  'src/renderer/src/components/settings/account-sign-in-error-copy.ts': {
    calls: 2,
    surface: 'settings copy+classifier'
  },
  'src/renderer/src/components/sidebar/worktree-removal-error-copy.ts': {
    calls: 2,
    surface: 'toast'
  },
  'src/renderer/src/components/terminal-pane/TerminalPane.tsx': {
    calls: 1,
    surface: 'log only — keeps the wrapped form out of the toast and in the console'
  },
  'src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts': {
    calls: 1,
    surface: 'terminal error toast, via the accumulator every pane-error producer funnels through'
  },
  'src/renderer/src/components/terminal-pane/terminal-paste-errors.ts': {
    calls: 1,
    surface: 'terminal error toast'
  },
  'src/shared/ai-vault-scan-error-message.ts': { calls: 1, surface: 'scan error copy' }
}

function countDirectStripperCalls(source: string): number {
  const cleaned = stripComments(source)
  return (
    (cleaned.match(/\bstripIpcInvokeEnvelope\(/g)?.length ?? 0) +
    (cleaned.match(/\bstripIpcInvokeEnvelopeFrom\(/g)?.length ?? 0)
  )
}

function countCalls(source: string): number {
  return stripComments(source).match(/\bextractIpcErrorMessage\(/g)?.length ?? 0
}

describe('extractIpcErrorMessage call sites', () => {
  it('are exactly the enumerated ones, at the enumerated counts', () => {
    const found: Record<string, number> = {}
    for (const file of listSourceFiles(join(REPO_ROOT, 'src'))) {
      const name = relative(REPO_ROOT, file).split(sep).join('/')
      if (name === DECLARING_MODULE) {
        continue
      }
      const calls = countCalls(readFileSync(file, 'utf8'))
      if (calls > 0) {
        found[name] = calls
      }
    }

    const expected = Object.fromEntries(
      Object.entries(CALL_SITES).map(([file, { calls }]) => [file, calls])
    )
    expect(found).toEqual(expected)
  })

  it('are joined by the direct stripper sites, which this reader cannot see', () => {
    const found: Record<string, number> = {}
    for (const file of listSourceFiles(join(REPO_ROOT, 'src'))) {
      const name = relative(REPO_ROOT, file).split(sep).join('/')
      if (name === DECLARING_MODULE || name === ENVELOPE_MODULE) {
        continue
      }
      const calls = countDirectStripperCalls(readFileSync(file, 'utf8'))
      if (calls > 0) {
        found[name] = calls
      }
    }

    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(DIRECT_STRIPPER_SITES).map(([file, { calls }]) => [file, calls])
      )
    )
  })

  /**
   * What neither list can see, stated rather than implied: both are keyed on the stripper, so they
   * enumerate sites that already handle the envelope and can never enumerate one that does not. A
   * leak is invisible here by construction — the terminal error toast was fed a raw envelope for as
   * long as this file has existed.
   *
   * So the honest scope of this file: it is a change-detector for the sites that already strip, not
   * evidence that the leaking population is empty. It is not. Enumerating by surface instead — every
   * renderer expression that reads free text off a rejection and passes it to a render sink (a
   * `toast.*` argument or a `set*` state setter whose value is rendered) — finds 239 such
   * expressions across 162 modules, of which 118 reach a producer that can cross `ipcRenderer.invoke`
   * and do not strip. Four sampled at random were all real leaks of this exact shape, including
   * `source-control/commit/use-bulk-actions.ts`, which sits beside the file this PR just fixed, and
   * `settings/SshPane.tsx`, which renders the caught message as the whole toast title.
   *
   * No per-call-site gate can close that, because the leaking shape *is* the ordinary idiom: the
   * discriminator is whether the value crossed IPC, which is not visible where it is rendered. A
   * lint rule keyed on the idiom would fire on hundreds of correct sites and need suppressions.
   *
   * The narrow fix is the boundary, not the call site, and it has since been made: all 731
   * `ipcRenderer.invoke(` calls (702 + one written across two lines in `index.ts`, 28 in
   * `gitlab.ts`) now go through `src/preload/ipc-invoke-boundary.ts`, which rejects with the
   * stripped reason and logs the wrapped form against the channel that produced it. The count above
   * is what the boundary closed. `ipc-invoke-boundary-ratchet.test.ts` is what keeps the 732nd call
   * from being written outside it.
   *
   * This file stays as the change-detector it always was. It does not become the proof: it is keyed
   * on the stripper, so it still cannot see a site that does not strip — which is now the correct
   * state for a call site rather than a leak, because the value reaching it has already been
   * narrowed upstream.
   */
  // Why: this is the number the freeze note got wrong, so it is asserted rather than described.
  it('number 31, and all of them render to a user', () => {
    const total = Object.values(CALL_SITES).reduce((sum, { calls }) => sum + calls, 0)

    expect(total).toBe(31)
    expect(Object.values(CALL_SITES).filter(({ surface }) => surface === '')).toEqual([])
    expect(Object.values(DIRECT_STRIPPER_SITES).filter(({ surface }) => surface === '')).toEqual([])
  })
})
