import { describe, expect, it, vi } from 'vitest'
import {
  MIXED_FOLDER,
  MIXED_GROUP
} from '../../src/shared/folder-workspace-host-routing.test-fixture'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { RuntimePtyController } from '../../src/main/runtime/runtime-pty-controller-contract'
import { spawnMock } from '../../src/main/ipc/pty/pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../../src/main/ipc/pty/pty-ipc-test-harness'
import { registerPtyHandlers } from '../../src/main/ipc/pty/register-handlers'
import { getFolderWorkspacePathErrorCopy } from '../../src/renderer/src/lib/folder-workspace-path-status'

vi.mock('electron', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock())
)
vi.mock('fs', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock())
)
vi.mock('node-pty', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock())
)
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).childProcessModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/opencode/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.openCodeHookServiceModuleMock()
  )
)
vi.mock('../../src/main/mimo/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../src/main/agent-hooks/server', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../src/main/pi/titlebar-extension-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.piTitlebarExtensionModuleMock()
  )
)
vi.mock('../../src/main/pwsh', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../src/main/wsl', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).wslModuleMock(
    await importOriginal()
  )
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).fsPromisesModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/telemetry/client', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../src/main/telemetry/classify-error', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../src/main/cli/linux-terminal-orca-cli-shim', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../src/main/memory/pty-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../src/main/agent-hooks/migration-unsupported-pty-state', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.migrationUnsupportedPtyModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-pane-account-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexPaneAccountRegistryModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-state-db-backfill-recovery', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexBackfillRecoveryModuleMock()
  )
)

describe('folder cwd ownership across IPC and renderer copy', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it.each([false, true])(
    'keeps the selected folder through real IPC/runtime admission and cwd fallback (%s)',
    async (reverse) => {
      const local = {
        ...MIXED_FOLDER,
        id: 'dup',
        executionHostId: 'local' as const,
        folderPath: '/selected'
      }
      const remote = { ...local, executionHostId: 'ssh:prod' as const, folderPath: '/foreign' }
      let folders = reverse ? [local, remote] : [remote, local]
      const store = {
        getRepos: () => [],
        getProjectGroups: () => [MIXED_GROUP],
        getFolderWorkspaces: () => folders,
        getFolderWorkspace: () => folders[0],
        getWorkspaceSession: getDefaultWorkspaceSession
      }
      const runtime = {
        preAllocateHandleForPty: vi.fn(),
        setPtyController: vi.fn<(controller: RuntimePtyController) => void>(),
        registerPty: vi.fn(),
        onPtySpawned: vi.fn(),
        onPtyExit: vi.fn(),
        onPtyData: vi.fn()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration/spawn reads these runtime and store members; no durable pane binding is requested.
      registerPtyHandlers(
        mainWindow as never,
        runtime as never,
        undefined,
        undefined,
        undefined,
        store as never
      )
      const controller = runtime.setPtyController.mock.calls[0]?.[0]
      if (!controller?.spawn) {
        throw new Error('Runtime PTY controller was not registered')
      }
      const spawn = async (cwd: string) =>
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd,
          worktreeId: 'folder:dup',
          cwdFallback: 'worktree',
          connectionId: null
        })
      await spawn('.')
      expect(spawnMock.mock.calls.at(-1)?.[2]).toMatchObject({ cwd: '/selected' })
      await controller.spawn({
        cols: 80,
        rows: 24,
        cwd: '.',
        worktreeId: 'folder:dup',
        connectionId: null,
        env: {}
      })
      expect(spawnMock.mock.calls.at(-1)?.[2]).toMatchObject({ cwd: '/selected' })
      folders = [remote]
      spawnMock.mockClear()
      await expect(spawn('.')).rejects.toThrow('folder_workspace_path_scope_not_found')
      expect(spawnMock).not.toHaveBeenCalled()
      folders = [local, { ...local }]
      const failure = await spawn('.').then(
        () => {
          throw new Error('ambiguous spawn succeeded')
        },
        (error: unknown) => {
          if (!(error instanceof Error)) {
            throw error
          }
          return error
        }
      )
      expect(failure.message).toContain('folder_workspace_connection_ambiguous:/selected')
      expect(getFolderWorkspacePathErrorCopy(failure.message)?.title).toBe(
        'Cannot determine connection'
      )
      expect(spawnMock).not.toHaveBeenCalled()
    }
  )
})
