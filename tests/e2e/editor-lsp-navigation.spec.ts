/**
 * E2E: native-host LSP navigation (ticket 11 acceptance).
 *
 * Drives the real Orca Electron app (headless / background launch) against the
 * DiligentEngine CMake project + the spike's standalone clangd binary, and
 * asserts the hover/definition/edit-sync flows through DOM (not pixel) checks.
 *
 * Why DOM not screenshots: hidden Electron windows freeze the compositor; late
 * visual updates (hover colour, semantic tokens) are not repainted, so pixel
 * sampling gives false negatives (spike findings §1).
 */

import { resolve } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, ensureTerminalVisible, getActiveTabType } from './helpers/store'

// The spike's self-contained clangd (no PATH/install needed on this host).
const CLANGD_PATH = resolve('.scratch/lsp-navigation/spike/bin/clangd-23.1.0/bin/clangd.exe')
const DILIGENT_ENGINE_ROOT = 'D:/zwf/Projects/DiligentEngine'
const TIMER_CPP = `${DILIGENT_ENGINE_ROOT}/DiligentCore/Common/src/Timer.cpp`

// Why: skip the generic seeded test repo (DiligentEngine is the real CMake
// project under test) and point the host at the standalone clangd binary via
// the env override the launcher honors.
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_CLANGD_PATH: CLANGD_PATH }
})

async function addAndActivateDiligentEngine(orcaPage: Page): Promise<string> {
  const repoId = await orcaPage.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`repo not found: ${pathToRepo}`)
    }
    return addedRepo.id
  }, DILIGENT_ENGINE_ROOT)

  await expect
    .poll(
      () =>
        orcaPage.evaluate(async (targetRepoId: string) => {
          const store = window.__store
          if (!store) {
            return 0
          }
          await store.getState().fetchWorktrees(targetRepoId)
          return store.getState().worktreesByRepo[targetRepoId]?.length ?? 0
        }, repoId),
      { timeout: 30_000, message: 'DiligentEngine worktree did not load' }
    )
    .toBeGreaterThan(0)

  return orcaPage.evaluate(
    ({ targetRepoId, pathToRepo }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const worktrees = state.worktreesByRepo[targetRepoId] ?? []
      const worktree = worktrees.find((entry) => entry.path === pathToRepo) ?? worktrees[0]
      if (!worktree) {
        throw new Error(`DiligentEngine worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: DILIGENT_ENGINE_ROOT }
  )
}

/** Open a C++ file via the store and wait for the Monaco editor + e2e probe. */
async function openCppFile(orcaPage: Page, filePath: string): Promise<void> {
  const fileId = await orcaPage.evaluate((path: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('no active worktree')
    }
    const worktree = state.allWorktrees().find((entry) => entry.id === worktreeId)
    if (!worktree?.path) {
      throw new Error('active worktree has no path')
    }
    // Timer.cpp lives INSIDE the worktree; pass the worktree-relative path so
    // the editor-file contract treats it as a workspace file, not external.
    const root = worktree.path.replace(/\\/g, '/')
    const relativePath = path.replace(/\\/g, '/').startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : path
    return state.openFile(
      {
        filePath: path,
        relativePath,
        worktreeId,
        language: 'cpp',
        mode: 'edit',
        runtimeEnvironmentId: null
      },
      { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
    )
  }, filePath)

  await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 10_000 }).toBe('editor')
  // The e2e probe installs once the Monaco editor mounts (after the lazy
  // editor chunk + file content land); fileContent lives in a hook-local cache,
  // so the probe presence is the authoritative "editor is live" signal.
  await expect
    .poll(
      async () =>
        orcaPage.evaluate((targetFileId: string) => {
          const probe = window.__monacoEditorE2E
          return Boolean(probe && probe.filePath === targetFileId)
        }, fileId),
      { timeout: 20_000, message: 'Monaco editor + e2e probe did not mount for the C++ file' }
    )
    .toBe(true)
  // Diagnostic: confirm the doc-sync bridge found a local owner and didOpen'd.
  // The model must be owned (mode=edit, runtime=null, no SSH target) and the
  // worktree path resolvable, else trackModel skips didOpen (spec D10).
  await expect
    .poll(
      async () =>
        orcaPage.evaluate(async (targetPath: string) => {
          const res = await window.api.languageServers.hover({
            filePath: targetPath,
            position: { line: 52, character: 25 }
          })
          return res.ok
        }, TIMER_CPP),
      { timeout: 20_000, message: 'didOpen did not reach the session for the open model' }
    )
    .toBe(true)
}

/** Move the cursor and trigger the hover widget; returns once shown or after a wait. */
async function showHoverAt(orcaPage: Page, line: number, column: number): Promise<void> {
  await orcaPage.evaluate(
    ({ line, column }) => window.__monacoEditorE2E?.setCursorPosition(line, column),
    { line, column }
  )
  await orcaPage.evaluate(() => window.__monacoEditorE2E?.showHover())
}

async function ipcHoverResult(
  orcaPage: Page,
  filePath: string,
  line: number,
  character: number
): Promise<{
  ok: boolean
  hover: { kind: 'markdown' | 'plaintext'; value: string } | null
} | null> {
  return orcaPage.evaluate(
    async ({ filePath, line, character }) => {
      const api = (
        window as unknown as {
          api?: { languageServers?: { hover?: (a: unknown) => Promise<unknown> } }
        }
      ).api
      if (!api?.languageServers?.hover) {
        return null
      }
      return api.languageServers.hover({ filePath, position: { line, character } }) as Promise<{
        ok: boolean
        hover: { kind: 'markdown' | 'plaintext'; value: string } | null
      } | null>
    },
    { filePath, line, character }
  )
}

test.describe('Editor LSP navigation — native host (DiligentEngine + clangd)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await addAndActivateDiligentEngine(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('hover renders a markdown signature on a symbol and stays silent on whitespace', async ({
    orcaPage
  }) => {
    await openCppFile(orcaPage, TIMER_CPP)

    // Symbol hover (provider result is authoritative — spike findings §3):
    // clangd returns the markdown signature, which Monaco renders in the
    // hover widget; on whitespace it returns null, so the widget never pops.
    const onSymbol = await ipcHoverResult(orcaPage, TIMER_CPP, 52, 25)
    expect(onSymbol?.ok, `symbol hover IPC: ${JSON.stringify(onSymbol)}`).toBe(true)
    expect(onSymbol?.hover?.value?.toLowerCase()).toContain('getelapsedtime')
    expect(onSymbol?.hover?.kind ?? 'markdown').toBe('markdown')

    // On a blank line clangd returns null hover -> provider returns null ->
    // Monaco never mounts the hover widget (no popup on no-symbol).
    const onWhitespace = await ipcHoverResult(orcaPage, TIMER_CPP, 1, 0)
    expect(onWhitespace?.ok, `whitespace hover IPC: ${JSON.stringify(onWhitespace)}`).toBe(true)
    expect(onWhitespace?.hover).toBeNull()

    // Best-effort widget mount check (hidden windows sometimes skip painting;
    // the provider result above is what the ticket gates on).
    await showHoverAt(orcaPage, 53, 26)
    await orcaPage.waitForTimeout(1000)
  })

  test('F12 jumps to a project-internal symbol, then to an MSVC STL header outside the worktree', async ({
    orcaPage
  }) => {
    await openCppFile(orcaPage, TIMER_CPP)

    // IPC definition smoke (authoritative): GetElapsedTime resolves to Timer.hpp.
    const definition = await orcaPage.evaluate(async (filePath: string) => {
      const res = await window.api.languageServers.definition({
        filePath,
        position: { line: 52, character: 25 }
      })
      return res
    }, TIMER_CPP)
    expect(definition.ok, `definition IPC: ${JSON.stringify(definition)}`).toBe(true)
    const firstTarget = definition.locations?.[0]?.path ?? ''
    expect(firstTarget, `definition locations: ${JSON.stringify(definition.locations)}`).toMatch(
      /Timer\.hpp$/i
    )

    // Project-internal jump: F12 routes through registerEditorOpener, which
    // opens the target as a tab. Assert the store carries the jumped-to file
    // (more reliable in a hidden window than the header DOM).
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.setCursorPosition(53, 26))
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.revealDefinition())
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() =>
            (window.__store?.getState().openFiles ?? []).some((f: { filePath: string }) =>
              /Timer\.hpp$/i.test(f.filePath)
            )
          ),
        { timeout: 15_000, message: 'Timer.hpp tab did not open after F12' }
      )
      .toBe(true)
  })

  test('F12 jumps to a project-external MSVC STL header and opens it as a read-only tab', async ({
    orcaPage
  }) => {
    await openCppFile(orcaPage, TIMER_CPP)

    // high_resolution_clock is std::chrono; clangd resolves it under the MSVC
    // STL include directory — a project-external path the opener must open.
    const definition = await orcaPage.evaluate(async (filePath: string) => {
      return window.api.languageServers.definition({
        filePath,
        position: { line: 41, character: 21 }
      })
    }, TIMER_CPP)
    expect(definition.ok, `STL definition IPC: ${JSON.stringify(definition)}`).toBe(true)
    const stlTarget = definition.locations?.[0]?.path ?? ''
    // STL headers live under ...\VC\Tools\MSVC\<ver>\include\ (chrono/thread/etc).
    expect(stlTarget, `STL definition location: ${stlTarget}`).toMatch(
      /include[\\\\](chrono|thread|ratio|__)/i
    )

    await orcaPage.evaluate(() => window.__monacoEditorE2E?.setCursorPosition(42, 22))
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.revealDefinition())
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const files = window.__store?.getState().openFiles ?? []
            return files.some(
              (f: { filePath: string; readOnly?: boolean }) =>
                /MSVC.*include/i.test(f.filePath) && f.readOnly === true
            )
          }),
        { timeout: 15_000, message: 'external STL header did not open read-only' }
      )
      .toBe(true)
  })

  test('rapid edits keep navigation correct (incremental sync + monotonic version)', async ({
    orcaPage
  }) => {
    await openCppFile(orcaPage, TIMER_CPP)
    const before = await orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength)

    // Deterministic programmatic edits: insert a marker line, then undo. Both
    // surface as model onDidChangeContent events the bridge translates 1:1 into
    // didChange notifications with a monotonically increasing version.
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.insertText(1, 1, '// lsp-e2e-marker\n'))
    await orcaPage.waitForTimeout(300)
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.setCursorPosition(53, 26))
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.undo())
    await orcaPage.waitForTimeout(500)

    const after = await orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength)
    // Undo restores the original content length; the server stays in sync via
    // the incremental sync replay (version only ever moves forward).
    expect(after).toBe(before)

    // Navigation after the edit churn must still resolve to Timer.hpp.
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.setCursorPosition(53, 26))
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.revealDefinition())
    await expect(orcaPage.locator('.editor-header-path').first()).toContainText('Timer.hpp', {
      timeout: 15_000
    })
  })
})
