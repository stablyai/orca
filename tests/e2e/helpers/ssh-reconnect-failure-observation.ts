import type { Page, TestInfo } from '@stablyai/playwright-test'
import {
  execDockerSshRelayTargetControlCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'
import { getTerminalContent, readPaneIdentitySnapshot } from './terminal-pane-identity'

export async function attachSshReconnectFailureObservation(
  page: Page,
  testInfo: TestInfo,
  target: DockerSshRelayTarget | null,
  targetId: string | null,
  originalPtyId: string | null
): Promise<void> {
  const observations: Record<string, unknown> = { originalPtyId, targetId }
  const observe = async (name: string, read: () => unknown): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      observations[name] = await Promise.race([
        Promise.resolve().then(read),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Observation timed out')), 5_000)
        })
      ])
    } catch (error) {
      observations[name] = { error: String(error) }
    } finally {
      clearTimeout(timer)
    }
  }
  await Promise.all([
    observe('paneIdentity', () => readPaneIdentitySnapshot(page)),
    observe('renderedContent', () => getTerminalContent(page, 8000)),
    observe('renderer', () =>
      page.evaluate((targetId) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return {
          authority: targetId ? state?.sshConnectionStates.get(targetId) : null,
          worktreeId,
          activeTabId: state?.activeTabId,
          tabs: worktreeId
            ? state?.tabsByWorktree[worktreeId]?.map(({ id, title }) => ({ id, title }))
            : null,
          panes: [...(window.__paneManagers?.entries() ?? [])].map(([tabId, manager]) => ({
            tabId,
            diagnostics: manager.getRenderingDiagnostics()
          }))
        }
      }, targetId)
    ),
    observe('pty', () =>
      page.evaluate(async (originalPtyId) => {
        const ids = new Set<string>(originalPtyId ? [originalPtyId] : [])
        for (const manager of window.__paneManagers?.values() ?? []) {
          for (const pane of manager.getPanes()) {
            const id = pane.container.dataset.ptyId
            if (id) {
              ids.add(id)
            }
          }
        }
        const read = async (request: Promise<unknown>): Promise<unknown> => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              request,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('PTY observation timed out')), 3_000)
              })
            ])
          } catch (error) {
            return { error: String(error) }
          } finally {
            clearTimeout(timer)
          }
        }
        const [delivery, processes] = await Promise.all([
          read(window.api.pty.getRendererDeliveryDebugSnapshot()),
          Promise.all(
            [...ids].map(async (id) => {
              const [process, buffer] = await Promise.all([
                read(window.api.pty.inspectProcess(id, { scanChildProcesses: true })),
                read(
                  window.api.pty.getMainBufferSnapshot(id, { scrollbackRows: 40 }).then((buffer) =>
                    buffer
                      ? {
                          source: buffer.source,
                          seq: buffer.seq,
                          alternateScreen: buffer.alternateScreen,
                          cols: buffer.cols,
                          rows: buffer.rows,
                          data: buffer.data.slice(-8000),
                          scrollbackAnsi: buffer.scrollbackAnsi?.slice(-8000)
                        }
                      : null
                  )
                )
              ])
              return { id, process, buffer }
            })
          )
        ])
        return { delivery, processes }
      }, originalPtyId)
    )
  ])
  if (target) {
    await observe('remoteProcesses', () =>
      execDockerSshRelayTargetControlCommand(
        target,
        'ps -eo pid,ppid,pgid,sid,tpgid,stat,comm,args'
      )
    )
  }
  await testInfo.attach('ssh-reconnect-failure.json', {
    body: JSON.stringify(observations, null, 2),
    contentType: 'application/json'
  })
}
