import type { Page } from '@stablyai/playwright-test'
import type { RuntimeTerminalFocus } from '../../../src/shared/runtime-types'
import { expect } from './orca-app'
import { createRemoteSessionBulkOpenFixture } from './remote-session-bulk-open-fixture'
import { closeStreamingTerminals } from './streaming-terminal-cleanup'

export type HostFocusStormSession = {
  marker: string
  terminal: string
  worktreeId: string
}

async function callRuntime<TResult>(
  page: Page,
  method: string,
  params: unknown,
  environmentId?: string
): Promise<TResult> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = environmentId
        ? await window.api.runtimeEnvironments.call({ selector: environmentId, method, params })
        : await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId: environmentId ?? null, method, params }
  ) as Promise<TResult>
}

export async function seedHostFocusStormSessions(
  page: Page,
  worktreeId: string,
  count = 6,
  environmentId?: string
): Promise<{ sessions: HostFocusStormSession[]; dispose: () => Promise<void> }> {
  const fixture = createRemoteSessionBulkOpenFixture()
  const sessions: HostFocusStormSession[] = []
  const closeSessions = async (): Promise<void> => {
    try {
      await closeStreamingTerminals(
        sessions.map((session) => session.terminal),
        (method, terminal) => callRuntime(page, method, { terminal }, environmentId)
      )
    } finally {
      fixture.dispose()
    }
  }
  try {
    for (let index = 0; index < count; index += 1) {
      const marker = `HOST_FOCUS_${index}`
      const params = {
        worktree: `id:${worktreeId}`,
        command: fixture.command(marker),
        activate: false,
        select: false,
        navigation: 'caller'
      }
      const result = await callRuntime<{ tab: { terminal: string | null } }>(
        page,
        'session.tabs.createTerminal',
        params,
        environmentId
      )
      if (!result.tab.terminal) {
        throw new Error(`Host focus terminal ${marker} was not created`)
      }
      sessions.push({ marker, terminal: result.tab.terminal, worktreeId })
    }
    await expect
      .poll(
        async () => {
          const ready = await Promise.all(
            sessions.map(async (session) => {
              const params = { terminal: session.terminal, limit: 200 }
              const result = await callRuntime<{ terminal: { tail: string[] } }>(
                page,
                'terminal.read',
                params,
                environmentId
              )
              return result.terminal.tail.join('\n').includes(`BG:${session.marker}:`)
            })
          )
          return ready.every(Boolean)
        },
        { timeout: 60_000 }
      )
      .toBe(true)
    return { sessions, dispose: closeSessions }
  } catch (error) {
    await closeSessions().catch((cleanupError) => {
      throw new AggregateError(
        [error, cleanupError],
        'Focus-storm session seeding and cleanup failed'
      )
    })
    throw error
  }
}

export async function runHostFocusStorm(
  page: Page,
  sessions: HostFocusStormSession[],
  environmentId?: string
): Promise<RuntimeTerminalFocus[]> {
  if (sessions.length < 2) {
    throw new Error('host focus storm requires at least two terminals')
  }
  return page.evaluate(
    async ({ environmentId, targets }) => {
      const callFocus = (terminal: string) =>
        environmentId
          ? window.api.runtimeEnvironments.call({
              selector: environmentId,
              method: 'terminal.focus',
              params: { terminal, navigation: 'host' }
            })
          : window.api.runtime.call({
              method: 'terminal.focus',
              params: { terminal, navigation: 'host' }
            })
      const prior = targets.slice(0, -1).map((target) => callFocus(target.terminal))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const latestTarget = targets.at(-1)
      if (!latestTarget) {
        throw new Error('host focus storm lost its latest target')
      }
      const latest = callFocus(latestTarget.terminal)
      const responses = await Promise.all([...prior, latest])
      return responses.map((response) => {
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        return (response.result as { focus: RuntimeTerminalFocus }).focus
      })
    },
    { environmentId: environmentId ?? null, targets: sessions }
  )
}
