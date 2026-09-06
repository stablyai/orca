import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_AGENTS,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import {
  getFirstWslDistro,
  removeWslGoldenStubAgent,
  stageWslGoldenStubAgent,
  useWslRuntimeForActiveProject
} from './helpers/wsl-golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'
import type { BuiltInWindowsTerminalShell } from '../../src/shared/windows-terminal-shell'

// Covers the Windows-only tab-bar launch path that the default-shell test misses.

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

const WINDOWS_SHELLS: readonly BuiltInWindowsTerminalShell[] = [
  'powershell.exe',
  'cmd.exe',
  'git-bash'
]

async function openWorkspaceTerminal(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
}

for (const { id, menuItemName } of GOLDEN_STUB_AGENTS) {
  test(`tab-bar + menu launches ${id} into a live TUI @tab-bar-agent-launch-golden`, async ({
    orcaPage
  }) => {
    await openWorkspaceTerminal(orcaPage)
    await configureGoldenStubAgent(orcaPage, { agent: id })
    await launchGoldenStubAgentFromNewTab(orcaPage, menuItemName)

    const activeTab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
    await expect(activeTab).toHaveAttribute('data-tab-title', /Golden Stub Agent|Codex|Claude/i)
    // The marker distinguishes an agent launch from an identical bare-shell tab.
    const terminalContent = await getTerminalContent(orcaPage)
    expect(terminalContent).toContain(GOLDEN_STUB_READY_MARKER)
    if (id === 'trae') {
      expect(terminalContent).toContain('tui.terminal_title=["thread-title"]')
      await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('Orca store is unavailable')
        }
        const state = store.getState()
        const worktreeId = state.activeWorktreeId
        const terminalTab = (state.tabsByWorktree[worktreeId ?? ''] ?? []).find(
          (tab) => tab.launchAgent === 'trae'
        )
        if (!worktreeId || !terminalTab) {
          throw new Error('Launched Trae terminal tab is unavailable')
        }
        const generatedTitle = 'Orca generated title'
        store.setState({
          settings: { ...state.settings, tabAutoGenerateTitle: true },
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [worktreeId]: state.tabsByWorktree[worktreeId]!.map((tab) =>
              tab.id === terminalTab.id ? { ...tab, generatedTitle } : tab
            )
          },
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((tab) =>
              tab.contentType === 'terminal' && tab.entityId === terminalTab.id
                ? { ...tab, generatedLabel: generatedTitle }
                : tab
            )
          }
        })
      })
      await expect(activeTab).toHaveAttribute('data-tab-title', 'Golden Stub Agent')
    }
  })
}

// Suite-level skipping avoids launching Electron for each unsupported case.
test.describe('Windows runtimes', () => {
  test.skip(process.platform !== 'win32', 'Windows agent launch matrix is Windows-only')

  for (const shell of WINDOWS_SHELLS) {
    test(`tab-bar + menu launches an agent under ${shell} @tab-bar-agent-launch-golden`, async ({
      orcaPage
    }) => {
      await openWorkspaceTerminal(orcaPage)
      // Each shell family requires different launch-command quoting.
      await configureGoldenStubAgent(orcaPage, { agent: 'codex', windowsShell: shell })
      await launchGoldenStubAgentFromNewTab(orcaPage)

      expect(await getTerminalContent(orcaPage)).toContain(GOLDEN_STUB_READY_MARKER)
    })
  }

  test('tab-bar + menu launches an agent inside WSL @tab-bar-agent-launch-golden', async ({
    orcaPage
  }) => {
    await openWorkspaceTerminal(orcaPage)

    const distro = await getFirstWslDistro(orcaPage)
    test.skip(!distro, 'No WSL distro is available on this Windows host')
    const stage = stageWslGoldenStubAgent(distro!)
    test.skip(!stage, 'WSL distro would not accept the staged stub agent')

    try {
      // WSL must retarget both agent detection and the PTY.
      await useWslRuntimeForActiveProject(orcaPage, distro!)
      await configureGoldenStubAgent(orcaPage, { agent: 'codex' })
      await launchGoldenStubAgentFromNewTab(orcaPage)

      // The distro-only marker proves the agent ran in WSL.
      expect(await getTerminalContent(orcaPage)).toContain(GOLDEN_STUB_READY_MARKER)
    } finally {
      removeWslGoldenStubAgent(distro!, stage!)
    }
  })
})
