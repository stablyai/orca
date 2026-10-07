/**
 * The connect that converts a relay-era SSH host, and the source's retention then retirement,
 * shared by the runtime relay-era cell and the upgraded-profile cell.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { readPersistedProfileState } from './persisted-profile-state'
import { findOrcadMigrationSourceCutoverForTarget } from '../../../src/main/ssh/orcad-migration-cutover-journal'

const CONVERT_TIMEOUT_MS = 8 * 60_000

const RECONNECT_STEP_TIMEOUT_MS = 6 * 60_000

/** Returns what the connect itself resolved to; a step that hangs fails naming itself. */
export async function reconnect(page: Page, targetId: string): Promise<string> {
  for (const step of ['disconnect', 'connect'] as const) {
    const run = page.evaluate(
      async ({ id, step }) => {
        try {
          if (step === 'disconnect') {
            await window.api.ssh.disconnect({ targetId: id })
            return ''
          }
          const state = await window.api.ssh.connect({ targetId: id })
          return JSON.stringify(state?.managedServer ?? null)
        } catch (error) {
          return `${step} threw: ${String(error)}`
        }
      },
      { id: targetId, step }
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RECONNECT_STEP_TIMEOUT_MS)
      })
    ]).finally(() => clearTimeout(timer))
    if (result === null) {
      const main = await page.evaluate(
        async (id) => JSON.stringify(await window.api.ssh.getState({ targetId: id })),
        targetId
      )
      throw new Error(`ssh ${step} hung; main state ${main}`)
    }
    // Why: callers parse the connect's JSON, which would hide the error text behind a parse error.
    if (result.startsWith(`${step} threw:`)) {
      const main = await page.evaluate(
        async (id) => JSON.stringify(await window.api.ssh.getState({ targetId: id })),
        targetId
      )
      throw new Error(`${result}; main state ${main}`)
    }
    if (step === 'connect') {
      return result
    }
  }
  return ''
}

export function managedServer(page: Page, targetId: string): Promise<unknown> {
  return page.evaluate(
    (id) => window.__store?.getState().sshConnectionStates.get(id)?.managedServer ?? null,
    targetId
  )
}

function isManaged(server: unknown): boolean {
  return (
    typeof server === 'object' && server !== null && 'kind' in server && server.kind === 'managed'
  )
}

/** The relay-era catalog rows this profile still holds for the host. */
function sourceRows(
  userData: string,
  targetId: string
): { repos: number; folderWorkspaces: number } {
  const state = readPersistedProfileState(userData)
  const count = (rows: unknown): number =>
    (Array.isArray(rows) ? rows : []).filter((row) => row?.connectionId === targetId).length
  return { repos: count(state.repos), folderWorkspaces: count(state.folderWorkspaces) }
}

export function targetLeases(userData: string, targetId: string): { state?: unknown }[] {
  const leases = readPersistedProfileState(userData).sshRemotePtyLeases
  return (Array.isArray(leases) ? leases : []).filter((lease) => lease?.targetId === targetId)
}

export async function serverCall(
  page: Page,
  selector: string,
  method: string,
  params?: unknown
): Promise<string> {
  // Why a long budget: a fresh server's first session inventory restores every migrated tab.
  const response = await page.evaluate((args) => window.api.runtimeEnvironments.call(args), {
    selector,
    method,
    params,
    timeoutMs: 120_000
  })
  const text = JSON.stringify(response)
  expect(response, `${method} on the managed server: ${text.slice(0, 2_000)}`).toMatchObject({
    ok: true
  })
  return text
}

/** A path as it appears inside a JSON response: Windows backslashes arrive escaped. */
function jsonText(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

export type ConvertedHost = {
  targetId: string
  worktreeId: string
  repoPath: string
  folderPath: string
  sessionFilePath: string
}

/** Connects with the template in place, then proves conversion, retention and retirement. */
export async function convertAndRetain(
  page: Page,
  userData: string,
  host: ConvertedHost
): Promise<void> {
  const connected = await reconnect(page, host.targetId)
  // Polls the whole state so a timeout reports why the host stayed on the relay.
  await expect
    .poll(
      async () => {
        const server = await managedServer(page, host.targetId)
        if (isManaged(server)) {
          return 'managed'
        }
        const leases = targetLeases(userData, host.targetId)
        const journal = findOrcadMigrationSourceCutoverForTarget(userData, host.targetId)
        const mainState = await page.evaluate(
          async (id) => (await window.api.ssh.getState({ targetId: id }))?.managedServer ?? null,
          host.targetId
        )
        return JSON.stringify({
          server,
          mainState,
          connected,
          leases,
          journal: journal && { phase: journal.phase, updatedAt: journal.updatedAt }
        })
      },
      { timeout: CONVERT_TIMEOUT_MS }
    )
    .toBe('managed')
  const environments = await page.evaluate(() => window.api.runtimeEnvironments.list())
  const environment = environments.find(
    (entry) => entry.orcadDeployment?.sshTargetId === host.targetId
  )
  expect(environment, 'a managed server registered for the host').toBeTruthy()
  expect(await serverCall(page, environment!.id, 'repo.list')).toContain(jsonText(host.repoPath))
  expect(await serverCall(page, environment!.id, 'folderWorkspace.list')).toContain(
    jsonText(host.folderPath)
  )
  // The relay-era editor tab moved with the session; the server lists it for every client.
  await expect
    .poll(
      async () =>
        await serverCall(page, environment!.id, 'session.tabs.list', {
          worktree: `id:${host.worktreeId}`
        }),
      { timeout: 30_000 }
    )
    .toContain(jsonText(host.sessionFilePath))
  // A fresh managed server answers the whole inventory too, instead of waiting on a renderer.
  expect(await serverCall(page, environment!.id, 'session.tabs.listAll', {})).toContain(
    jsonText(host.sessionFilePath)
  )

  // 3. Source retained for a downgrade: kept and hidden, and still so after another connect.
  const expectRetained = async (): Promise<void> => {
    expect(findOrcadMigrationSourceCutoverForTarget(userData, host.targetId)).toMatchObject({
      phase: 'destination-committed',
      sourceRetainedAt: expect.any(String)
    })
    expect(sourceRows(userData, host.targetId)).toEqual({ repos: 1, folderWorkspaces: 1 })
    const listed = await page.evaluate(async (id) => {
      const repos = await window.api.repos.list()
      return repos.filter((repo) => repo.connectionId === id).length
    }, host.targetId)
    expect(listed, 'retained source rows stay hidden').toBe(0)
  }
  await expectRetained()
  await reconnect(page, host.targetId)
  await expect.poll(() => managedServer(page, host.targetId).then(isManaged)).toBe(true)
  await expectRetained()
  expect(await serverCall(page, environment!.id, 'repo.list')).toContain(jsonText(host.repoPath))
}
