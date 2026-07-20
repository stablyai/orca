import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { createRestartSession, attachRepoAndOpenTerminal } from './helpers/orca-restart'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalRead,
  RuntimeTerminalSplit,
  RuntimeTerminalShow
} from '../../src/shared/runtime-types'
import { waitForSessionReady } from './helpers/store'
import { herdrSessionNameForProject } from '../../src/shared/herdr-session-identity'
import type { Project } from '../../src/shared/types'

test.describe.configure({ mode: 'serial' })

test('Herdr terminal detaches, survives Orca restart, reattaches, and closes explicitly', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const herdrBinary = path.resolve(process.cwd(), '..', 'herdr', 'target', 'release', 'herdr')
  const herdrConfigHome = mkdtempSync(path.join(os.tmpdir(), 'orca-herdr-e2e-'))
  let sessionName: string | null = null
  const marker = `HERDR_REATTACH_${Date.now()}`
  const stoppedMarker = path.join(herdrConfigHome, 'agent-stopped')
  const repoPath = testRepoPath
  const session = createRestartSession(testInfo, {
    ORCA_HERDR_BINARY: herdrBinary,
    XDG_CONFIG_HOME: herdrConfigHome
  })
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  const appLogs: string[] = []

  try {
    const first = await session.launch()
    firstApp = first.app
    first.app.process().stderr?.on('data', (chunk: Buffer) => appLogs.push(chunk.toString()))
    await waitForSessionReady(first.page)
    const configuredBackend = await first.page.evaluate(async (binaryPath) => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store was not available')
      }
      await store.getState().updateSettings({
        terminalBackendDefault: 'herdr',
        herdrBinarySource: { kind: 'custom', path: binaryPath }
      })
      return store.getState().settings.terminalBackendDefault
    }, herdrBinary)
    expect(configuredBackend).toBe('herdr')
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath, {
      terminalBackendPreference: 'herdr'
    })
    const routingState = await first.page.evaluate(() => {
      const state = window.__store?.getState()
      return {
        terminalBackendDefault: state?.settings.terminalBackendDefault,
        terminalBackendPreference: state?.projects[0]?.terminalBackendPreference,
        terminalBackendByHost: state?.projects[0]?.terminalBackendByHost
      }
    })
    expect(routingState).toMatchObject({
      terminalBackendDefault: 'herdr',
      terminalBackendPreference: 'herdr'
    })
    const project = await first.page.evaluate(() => window.__store?.getState().projects[0] ?? null)
    sessionName = project ? herdrSessionNameForProject(project as Project) : null
    expect(sessionName).toBeTruthy()
    const client = new RuntimeClient(session.userDataDir, 60_000)

    let createdHandle: string | null = null
    try {
      await expect
        .poll(
          async () => {
            try {
              const listed = await client.call<RuntimeTerminalListResult>('terminal.list', {
                worktree: `id:${worktreeId}`
              })
              for (const terminal of listed.result.terminals) {
                const shown = await client.call<{ terminal: RuntimeTerminalShow }>(
                  'terminal.show',
                  { terminal: terminal.handle }
                )
                if (shown.result.terminal.backend === 'herdr') {
                  createdHandle = terminal.handle
                  return true
                }
              }
              return false
            } catch {
              return false
            }
          },
          { timeout: 30_000, message: 'initial Herdr terminal was not created' }
        )
        .toBe(true)
    } catch (error) {
      const snapshot = execFileSync(herdrBinary, ['--session', sessionName!, 'api', 'snapshot'], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: herdrConfigHome }
      })
      throw new Error(`${String(error)}\nHerdr snapshot:\n${snapshot}`)
    }
    if (!createdHandle) {
      throw new Error('initial Herdr terminal was not created')
    }
    const shown = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
      terminal: createdHandle
    })
    expect(shown.result.terminal.backend).toBe('herdr')
    await client.call('terminal.rename', { terminal: createdHandle, title: 'Herdr persistence' })
    await client.call('terminal.send', {
      terminal: createdHandle,
      text: `echo ${marker}`,
      enter: true
    })
    try {
      await expect
        .poll(
          async () => {
            const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
              terminal: createdHandle
            })
            return read.result.terminal.tail.join('\n')
          },
          { timeout: 30_000 }
        )
        .toContain(marker)
    } catch (error) {
      throw new Error(`${String(error)}\nApp logs:\n${appLogs.join('\n')}`)
    }

    let split: Awaited<ReturnType<typeof client.call<{ split: RuntimeTerminalSplit }>>>
    try {
      split = await client.call<{ split: RuntimeTerminalSplit }>('terminal.split', {
        terminal: createdHandle,
        direction: 'vertical',
        command: `sh -c 'trap "printf stopped > ${stoppedMarker}" EXIT HUP TERM; while :; do sleep 1; done'`
      })
    } catch (error) {
      const snapshot = execFileSync(herdrBinary, ['--session', sessionName!, 'api', 'snapshot'], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: herdrConfigHome }
      })
      throw new Error(
        `${String(error)}\nApp logs:\n${appLogs.join('\n')}\nHerdr snapshot:\n${snapshot}`
      )
    }
    const splitShow = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
      terminal: split.result.split.handle
    })
    expect(splitShow.result.terminal.backend).toBe('herdr')

    await session.close(firstApp)
    firstApp = null

    const listed = JSON.parse(
      execFileSync(herdrBinary, ['session', 'list', '--json'], {
        encoding: 'utf8',
        env: { ...process.env, XDG_CONFIG_HOME: herdrConfigHome }
      })
    ) as { sessions: { name: string; running: boolean }[] }
    expect(listed.sessions).toContainEqual(
      expect.objectContaining({ name: sessionName, running: true })
    )

    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    await attachRepoAndOpenTerminal(second.page, repoPath)
    let restoredHandle: string | null = null
    await expect
      .poll(
        async () => {
          try {
            const active = await client.call<{ handle: string }>('terminal.resolveActive', {
              worktree: `id:${worktreeId}`
            })
            restoredHandle = active.result.handle
            const restored = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
              terminal: restoredHandle
            })
            return restored.result.terminal.backend
          } catch {
            return null
          }
        },
        { timeout: 30_000, message: 'persisted Herdr terminal did not reattach' }
      )
      .toBe('herdr')
    if (!restoredHandle) {
      throw new Error('persisted Herdr terminal did not reattach')
    }
    const restoredShow = await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', {
      terminal: restoredHandle
    })
    expect(restoredShow.result.terminal.backend).toBe('herdr')
    const restoredList = await client.call<RuntimeTerminalListResult>('terminal.list', {
      worktree: `id:${worktreeId}`
    })
    const restoredHerdrTerminals = restoredList.result.terminals.filter((terminal) =>
      terminal.ptyId?.startsWith('herdr:')
    )
    expect(restoredHerdrTerminals).toHaveLength(2)
    const restoredOutputs = await Promise.all(
      restoredHerdrTerminals.map(async (terminal) => {
        const read = await client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
          terminal: terminal.handle
        })
        return read.result.terminal.tail.join('\n')
      })
    )
    expect(restoredOutputs.some((output) => output.includes(marker))).toBe(true)
    expect(existsSync(stoppedMarker)).toBe(false)
    await client.call('terminal.closeTab', { terminal: restoredHandle })
    await expect
      .poll(() => existsSync(stoppedMarker), {
        timeout: 15_000,
        message: 'closing the Herdr tab did not stop its long-running child process'
      })
      .toBe(true)
  } finally {
    if (firstApp) {
      await session.close(firstApp)
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    try {
      if (sessionName) {
        execFileSync(herdrBinary, ['session', 'stop', sessionName, '--json'], {
          stdio: 'ignore',
          env: { ...process.env, XDG_CONFIG_HOME: herdrConfigHome }
        })
      }
    } catch {
      // Session may never have started when setup fails.
    }
    await session.dispose()
    rmSync(herdrConfigHome, { recursive: true, force: true })
  }
})
