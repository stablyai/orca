/**
 * E2E: WSL-host LSP navigation (ticket 16 acceptance, boxes 1 + 3).
 *
 * Mirrors editor-lsp-navigation.spec.ts (the native-host ticket 11 e2e) but
 * against a C++ project that lives inside the WSL guest, so clangd runs inside
 * the distro (PATH-discovered, spawned via `wsl.exe --exec`). The host adapter
 * is selected from the worktree's UNC root (\\wsl.localhost\<distro>\…), the
 * LSP document URI clangd receives is the guest POSIX form, and clangd's
 * returned locations reverse-map back to UNC so Orca opens them.
 *
 * Why this exists: the unit suite covers path mapping, host-adapter selection,
 * clangd PATH-lookup parsing, and the version gate in isolation; this spec
 * proves the seams hold against a real guest clangd over a real distro. The
 * spike (§1) found hidden Electron windows freeze late repaints, so assertions
 * are DOM/store/IPC (no pixel sampling) — same basis as the native e2e.
 *
 * Skip conditions: Windows-only (WSL is a Windows feature), and a WSL distro
 * with clangd on its PATH must be reachable — otherwise the test degrades to a
 * skip (never a false pass), mirroring windows-wsl-terminal-restore.spec.ts.
 */

import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, ensureTerminalVisible, getActiveTabType } from './helpers/store'
import { buildWslExecArgs } from '../../src/shared/wsl-login-shell-command'

const execFileAsync = promisify(execFile)

// The C++ project is created inside the guest by beforeAll; its UNC root is
// resolved from the detected distro + the guest user's HOME. main.cpp calls
// foo(), declared in foo.h, so clangd resolves the definition to foo.h (the
// reverse-map target the box-3 assertion opens).
const GUEST_PROJECT_DIR = 'orca-wsl-lsp-test'
const MAIN_CPP_RELATIVE = 'main.cpp'
const FOO_H_RELATIVE = 'foo.h'

// `foo` is called on the 5th source line (0-based line 4) at 0-based char 25:
//   "    const char* result = foo(x);"
// Counting from 0: 4 leading spaces + "const char* result = " (21 chars) = 25.
const FOO_LINE = 4
const FOO_CHARACTER = 25

type WslProjectSetup = {
  distro: string
  // Windows UNC root of the guest project (\\wsl.localhost\<distro>\…).
  uncRoot: string
  uncMainCpp: string
  uncFooH: string
}

async function detectWslDistro(): Promise<string | null> {
  // `wsl.exe --list --quiet` emits UTF-16LE; the production capture runner
  // sets WSL_UTF8, but here we just need the first distro name — strip the
  // NUL bytes between chars that leak through when read as utf8.
  try {
    const stdout = execFileSync('wsl.exe', ['--list', '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000
    })
    const first = stdout
      .replaceAll('\u0000', '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0)
    return first ?? null
  } catch {
    return null
  }
}

/** Create the C++ project (main.cpp + foo.h) as a git repo inside the guest. */
async function createGuestProject(distro: string): Promise<void> {
  // Why one shell-free sh -c: the files need real guest newlines + a compile
  // target clangd can resolve; one command avoids per-file wsl.exe round trips.
  // `git init` makes the repo add-able as kind=git so Orca's main worktree path
  // lands as the UNC root the host adapter keys on.
  const script = [
    'set -e',
    'cd ~',
    `rm -rf ${GUEST_PROJECT_DIR}`,
    `mkdir -p ${GUEST_PROJECT_DIR}`,
    `cd ${GUEST_PROJECT_DIR}`,
    `cat > ${FOO_H_RELATIVE} <<'EOF'`,
    '#ifndef FOO_H',
    '#define FOO_H',
    '// Returns the greeting for the given value.',
    'const char* foo(int value);',
    '#endif',
    'EOF',
    `cat > ${MAIN_CPP_RELATIVE} <<'EOF'`,
    '#include "foo.h"',
    '',
    'int main() {',
    '    int x = 42;',
    '    const char* result = foo(x);',
    '    return 0;',
    '}',
    'EOF',
    'git init -q',
    'git config user.email "test@orca.local"',
    'git config user.name "Orca WSL E2E"',
    'git add -A',
    'git commit -q -m "initial"'
  ].join('\n')
  await execFileAsync('wsl.exe', buildWslExecArgs(distro, ['sh', '-c', script]), {
    windowsHide: true,
    timeout: 30_000
  })
}

/** Resolve the guest user's HOME to a Windows UNC root for the project. */
function resolveUncRoot(distro: string): string {
  const guestHome = execFileSync(
    'wsl.exe',
    buildWslExecArgs(distro, ['sh', '-c', 'printf %s "$HOME"']),
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
  ).trim()
  // Why the \\wsl.localhost\<distro> shape directly: the host adapter's
  // parseWslUncPath accepts it; build it from the guest POSIX home.
  return `\\\\wsl.localhost\\${distro}${guestHome}\\${GUEST_PROJECT_DIR}`
}

function toUnc(uncRoot: string, relative: string): string {
  return `${uncRoot}\\${relative}`
}

let project: WslProjectSetup | null = null

test.beforeAll(async () => {
  // Why detect here (not in beforeEach): the guest project must exist before
  // any test launches the app + adds the repo. Leaving project null on any
  // miss lets beforeEach degrade to a skip, never a hard file-level failure.
  if (process.platform !== 'win32') {
    return
  }
  const distro = await detectWslDistro()
  if (!distro) {
    return
  }
  try {
    await createGuestProject(distro)
    const uncRoot = resolveUncRoot(distro)
    project = {
      distro,
      uncRoot,
      uncMainCpp: toUnc(uncRoot, MAIN_CPP_RELATIVE),
      uncFooH: toUnc(uncRoot, FOO_H_RELATIVE)
    }
  } catch {
    // A failed guest-project setup is a skip, not a false fail — the spec's
    // contract is "WSL distro with clangd reachable", not "the host has it".
    project = null
  }
})

/**
 * Add the WSL repo (UNC root) and activate its main worktree. Mirrors the
 * native e2e's addAndActivateDiligentEngine, but the root is a WSL UNC path so
 * selectHostAdapter picks the WSL adapter for this worktree's session.
 */
async function addAndActivateWslProject(orcaPage: Page): Promise<string> {
  const setup = project
  if (!setup) {
    throw new Error('WSL project was not set up in beforeAll')
  }
  const repoId = await orcaPage.evaluate(async (pathToRepo: string) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const addedRepo = await store.getState().addRepoPath(pathToRepo)
    if (!addedRepo) {
      throw new Error(`repo not added: ${pathToRepo}`)
    }
    return addedRepo.id
  }, setup.uncRoot)

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
      { timeout: 30_000, message: 'WSL project worktree did not load' }
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
      // Why match by path: the main checkout's worktree path is the UNC root
      // the host adapter keys on. Folding separators + case lets a guest
      // spelling match the backslash UNC we added.
      const matchByPath = worktrees.find(
        (entry) => entry.path.replace(/\//g, '\\').toLowerCase() === pathToRepo.toLowerCase()
      )
      const worktree = matchByPath ?? worktrees[0]
      if (!worktree) {
        throw new Error(`WSL project worktree not found: ${pathToRepo}`)
      }
      state.setActiveRepo(targetRepoId)
      state.setActiveWorktree(worktree.id)
      return worktree.id
    },
    { targetRepoId: repoId, pathToRepo: setup.uncRoot }
  )
}

/** Open the guest main.cpp via the store and wait for the Monaco editor + probe. */
async function openMainCpp(orcaPage: Page): Promise<void> {
  const setup = project
  if (!setup) {
    throw new Error('WSL project was not set up in beforeAll')
  }
  const fileId = await orcaPage.evaluate(
    ({ filePath, relativePath }: { filePath: string; relativePath: string }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('no active worktree')
      }
      return state.openFile(
        {
          filePath,
          relativePath,
          worktreeId,
          language: 'cpp',
          mode: 'edit',
          runtimeEnvironmentId: null
        },
        { preview: false, forceContentReload: true, suppressActiveRuntimeFallback: true }
      )
    },
    { filePath: setup.uncMainCpp, relativePath: MAIN_CPP_RELATIVE }
  )

  await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 10_000 }).toBe('editor')
  await expect
    .poll(
      async () =>
        orcaPage.evaluate((targetFileId: string) => {
          const probe = window.__monacoEditorE2E
          return Boolean(probe && probe.filePath === targetFileId)
        }, fileId),
      { timeout: 30_000, message: 'Monaco editor + e2e probe did not mount for the WSL .cpp' }
    )
    .toBe(true)
  // didOpen proof: the doc-sync bridge resolved a local owner (the UNC worktree
  // root) and opened the document on the WSL session. A hover that returns ok
  // means clangd inside the guest answered — the full host-adapter seam held.
  await expect
    .poll(
      async () =>
        orcaPage.evaluate(
          async ({
            filePath,
            line,
            character
          }: {
            filePath: string
            line: number
            character: number
          }) => {
            const res = await window.api.languageServers.hover({
              filePath,
              position: { line, character }
            })
            return res.ok
          },
          { filePath: setup.uncMainCpp, line: FOO_LINE, character: FOO_CHARACTER }
        ),
      { timeout: 60_000, message: 'didOpen did not reach the WSL clangd session for main.cpp' }
    )
    .toBe(true)
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

test.describe('Editor LSP navigation — WSL host (guest clangd, UNC path mapping)', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ orcaPage }) => {
    // Why skip per-test: beforeAll leaves project null when the distro/project
    // is unavailable; a worker without it must skip, not surface a setup throw.
    test.skip(process.platform !== 'win32' || !project, 'WSL project unavailable')
    await waitForSessionReady(orcaPage)
    await addAndActivateWslProject(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('hover returns the guest clangd signature for foo and stays silent on whitespace', async ({
    orcaPage
  }) => {
    const setup = project!
    await openMainCpp(orcaPage)

    // Box 1 (hover): clangd inside the guest resolves foo -> the foo.h
    // declaration's markdown signature. ok + a value mentioning foo proves the
    // guest binary answered through the wsl.exe --exec seam.
    const onSymbol = await ipcHoverResult(orcaPage, setup.uncMainCpp, FOO_LINE, FOO_CHARACTER)
    expect(onSymbol?.ok, `symbol hover IPC: ${JSON.stringify(onSymbol)}`).toBe(true)
    expect(onSymbol?.hover?.value?.toLowerCase()).toContain('foo')

    // On the #include directive's whitespace clangd returns null hover -> the
    // provider returns null -> Monaco never mounts the hover widget.
    const onWhitespace = await ipcHoverResult(orcaPage, setup.uncMainCpp, 1, 0)
    expect(onWhitespace?.ok, `whitespace hover IPC: ${JSON.stringify(onWhitespace)}`).toBe(true)
    expect(onWhitespace?.hover).toBeNull()

    // DOM assertion (ticket requirement, not pixels): the hover widget mounts
    // on a symbol. Hidden windows freeze repaints, but widget mounting is DOM
    // and reliable (spike §1, same basis as the native e2e).
    await orcaPage.evaluate(
      ({ line, column }) => window.__monacoEditorE2E?.setCursorPosition(line, column),
      { line: FOO_LINE + 1, column: FOO_CHARACTER + 1 }
    )
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.showHover())
    await expect
      .poll(async () => orcaPage.locator('.monaco-hover').count(), { timeout: 5_000 })
      .toBeGreaterThan(0)
    const hoverDom = await orcaPage
      .locator('.monaco-hover .hover-contents')
      .textContent({ timeout: 5_000 })
    expect(hoverDom?.toLowerCase() ?? '').toContain('foo')
  })

  test('F12 jumps to foo.h — guest path reverse-mapped to UNC and opened as a tab (box 3)', async ({
    orcaPage
  }) => {
    const setup = project!
    await openMainCpp(orcaPage)

    // Box 3 (definition): the IPC returns clangd's location. clangd answers in
    // the guest POSIX form (/home/…/foo.h); the adapter reverse-maps it to the
    // UNC spelling, so the location path ends in foo.h under the UNC root.
    const definition = await orcaPage.evaluate(
      async ({
        filePath,
        line,
        character
      }: {
        filePath: string
        line: number
        character: number
      }) => {
        return window.api.languageServers.definition({
          filePath,
          position: { line, character }
        })
      },
      { filePath: setup.uncMainCpp, line: FOO_LINE, character: FOO_CHARACTER }
    )
    expect(definition.ok, `definition IPC: ${JSON.stringify(definition)}`).toBe(true)
    const firstTarget = definition.locations?.[0]?.path ?? ''
    expect(firstTarget, `definition locations: ${JSON.stringify(definition.locations)}`).toMatch(
      /foo\.h$/i
    )
    // The reverse-mapped path must be the UNC form Orca opens (box 3), not the
    // guest POSIX form clangd answered in.
    expect(firstTarget.toLowerCase()).toContain('wsl.localhost')

    // F12 routes through registerEditorOpener, which opens the jumped-to file as
    // a tab. The opened tab's filePath is the UNC form — proving the round trip
    // landed a guest-returned location back on Orca's Windows identity.
    await orcaPage.evaluate(
      ({ line, column }) => window.__monacoEditorE2E?.setCursorPosition(line, column),
      { line: FOO_LINE + 1, column: FOO_CHARACTER + 1 }
    )
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.revealDefinition())
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() =>
            (window.__store?.getState().openFiles ?? []).some((f: { filePath: string }) =>
              /foo\.h$/i.test(f.filePath)
            )
          ),
        { timeout: 15_000, message: 'foo.h tab did not open after F12' }
      )
      .toBe(true)
    // The opened foo.h tab carries the UNC path (box 3 reverse map → opened).
    const openedFooH = await orcaPage.evaluate(() =>
      (window.__store?.getState().openFiles ?? []).find((f: { filePath: string }) =>
        /foo\.h$/i.test(f.filePath)
      )
    )
    expect(openedFooH?.filePath?.toLowerCase()).toContain('wsl.localhost')
  })

  test('Shift+F12 lists references for foo from the guest clangd', async ({ orcaPage }) => {
    const setup = project!
    await openMainCpp(orcaPage)

    // Box 1 (references): foo has the declaration in foo.h + the call in main.cpp,
    // so clangd returns ≥1 reference location (reverse-mapped to UNC).
    const references = await orcaPage.evaluate(
      async ({
        filePath,
        line,
        character
      }: {
        filePath: string
        line: number
        character: number
      }) => {
        return window.api.languageServers.references({
          filePath,
          position: { line, character }
        })
      },
      { filePath: setup.uncMainCpp, line: FOO_LINE, character: FOO_CHARACTER }
    )
    expect(references.ok, `references IPC: ${JSON.stringify(references)}`).toBe(true)
    expect(
      (references.locations ?? []).length,
      `references locations: ${JSON.stringify(references.locations)}`
    ).toBeGreaterThan(0)

    // DOM assertion: Shift+F12 mounts Monaco's peek references widget.
    await orcaPage.evaluate(
      ({ line, column }) => window.__monacoEditorE2E?.setCursorPosition(line, column),
      { line: FOO_LINE + 1, column: FOO_CHARACTER + 1 }
    )
    await orcaPage.evaluate(() => window.__monacoEditorE2E?.triggerReferences())
    await expect
      .poll(async () => orcaPage.locator('.peekview-widget').count(), {
        timeout: 10_000,
        message: 'peek references widget did not mount'
      })
      .toBeGreaterThan(0)
    await expect
      .poll(async () => orcaPage.locator('.peekview-widget .monaco-list-row').count(), {
        timeout: 10_000,
        message: 'peek references list did not populate'
      })
      .toBeGreaterThan(0)
  })
})
