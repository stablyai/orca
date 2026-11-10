// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'
import { WorktreeCardPluginBadges } from './WorktreeCardPluginBadges'

const toastMocks = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }))

vi.mock('sonner', () => ({ toast: toastMocks }))

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  /** Returns the English fallback with `{{value0}}` filled in. */
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

function enginePlugin(host: 'local' | 'any' = 'local', searchDepth = 0): PluginHostListEntry {
  return {
    pluginKey: 'orca-samples.engine',
    consentFingerprint: 'fingerprint',
    name: 'Engine',
    version: '1.0.0',
    publisher: 'orca-samples',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [
      {
        id: 'open-project',
        title: 'Open in Engine',
        context: 'workspace',
        handler: { type: 'worker' },
        keybindings: []
      }
    ],
    worktreeBadges: [
      {
        id: 'engine-project',
        title: 'Engine project',
        icon: { kind: 'svg', markup: '<svg viewBox="0 0 16 16"></svg>' },
        when: { pathExists: ['engine.project'], searchDepth, host },
        commands: ['open-project']
      }
    ],
    hasWorker: true,
    restarts: 0
  }
}

let existing: (path: string) => boolean
let pathExists: ReturnType<typeof vi.fn>
let pathsExist: ReturnType<typeof vi.fn>
let readDir: ReturnType<typeof vi.fn>
let invokeCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
  existing = () => true
  pathExists = vi.fn(async ({ filePath }: { filePath: string }) => existing(filePath))
  pathsExist = vi.fn(async ({ filePaths }: { filePaths: string[] }) =>
    filePaths.map((path) => ({ exists: existing(path) }))
  )
  readDir = vi.fn().mockResolvedValue([])
  invokeCommand = vi.fn().mockResolvedValue({ message: 'Starting Engine…' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { pathExists, pathsExist, readDir }, plugins: { invokeCommand } }
  })
  usePluginPanelsStore.getState().setPlugins([enginePlugin()])
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

/** Renders the badges of a workspace at `path`, on the SSH target `connectionId` names. Each test
 *  uses its own path, since path checks are cached for the session, like the sidebar's. */
function renderBadges(path: string, connectionId: string | null = null) {
  return render(
    <WorktreeCardPluginBadges
      worktree={{ id: `repo-1::${path}`, path }}
      repo={connectionId ? { connectionId } : null}
      isActive={false}
      onPointerDown={vi.fn()}
    />
  )
}

describe('WorktreeCardPluginBadges', () => {
  it('shows the badge once the marker exists and runs its command on that workspace', async () => {
    const user = userEvent.setup()
    renderBadges('/work/game')

    const badge = await screen.findByRole('button', { name: 'Engine project' })
    expect(pathsExist).toHaveBeenCalledWith({ filePaths: ['/work/game/engine.project'] })

    await user.click(badge)
    await user.click(await screen.findByRole('menuitem', { name: 'Open in Engine' }))

    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith({
        pluginKey: 'orca-samples.engine',
        commandId: 'open-project',
        args: { worktreeId: 'repo-1::/work/game' }
      })
    )
    expect(toastMocks).toHaveBeenCalledWith('Starting Engine…')
  })

  it('lists the subfolders holding the marker and runs the command on the one picked', async () => {
    usePluginPanelsStore.getState().setPlugins([enginePlugin('local', 1)])
    existing = (path) =>
      ['/work/depot/Racer/engine.project', '/work/depot/Arena/engine.project'].includes(path)
    readDir.mockResolvedValue([
      { name: 'Racer', isDirectory: true, isSymlink: false },
      { name: 'Arena', isDirectory: true, isSymlink: false },
      { name: '.git', isDirectory: true, isSymlink: false },
      { name: 'node_modules', isDirectory: true, isSymlink: false },
      { name: 'Linked', isDirectory: true, isSymlink: true },
      { name: 'notes.txt', isDirectory: false, isSymlink: false }
    ])
    const user = userEvent.setup()
    renderBadges('/work/depot')

    await user.click(await screen.findByRole('button', { name: 'Engine project' }))
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((item) => item.textContent)).toEqual(['Arena', 'Racer'])
    expect(pathsExist).toHaveBeenLastCalledWith({
      filePaths: ['/work/depot/Racer/engine.project', '/work/depot/Arena/engine.project']
    })

    await user.click(items[1])
    await waitFor(() =>
      expect(invokeCommand).toHaveBeenCalledWith({
        pluginKey: 'orca-samples.engine',
        commandId: 'open-project',
        args: { worktreeId: 'repo-1::/work/depot', folder: 'Racer' }
      })
    )
  })

  it('stays hidden when the marker is missing', async () => {
    existing = () => false
    renderBadges('/work/plain')

    await waitFor(() => expect(pathsExist).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Engine project' })).toBeNull()
  })

  it('leaves SSH workspaces out of local-only badges', async () => {
    renderBadges('/remote/game', 'ssh-target-1')

    await Promise.resolve()
    expect(pathExists).not.toHaveBeenCalled()
    expect(pathsExist).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Engine project' })).toBeNull()
  })

  it('reports a failed command with the message line of the worker error', async () => {
    invokeCommand.mockRejectedValue(
      new Error(
        "Error invoking remote method 'plugins:invokeCommand': Error: Error: Engine 2.1 is not installed.\n    at openProject (file:///plugins/engine/main.mjs:4:9)"
      )
    )
    const user = userEvent.setup()
    renderBadges('/work/broken')

    await user.click(await screen.findByRole('button', { name: 'Engine project' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Open in Engine' }))

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('Could not run Open in Engine', {
        description: 'Engine 2.1 is not installed.'
      })
    )
  })
})
