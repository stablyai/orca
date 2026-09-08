import { expect, type Page } from '@stablyai/playwright-test'

type DockerSshRelayReconnectOptions = {
  connectTimeoutMs?: number
}

async function performDockerSshRelayReconnect(
  page: Page,
  targetId: string,
  disconnectFirst: boolean,
  options: DockerSshRelayReconnectOptions
): Promise<void> {
  await page.evaluate(
    async ({ connectTimeoutMs, targetId, disconnectFirst }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      if (disconnectFirst) {
        await window.api.ssh.disconnect({ targetId })
      }
      let connectTimer: ReturnType<typeof setTimeout> | null = null
      let connectTimedOut = false
      try {
        const connectPromise = window.api.ssh.connect({ targetId })
        const state =
          connectTimeoutMs === undefined
            ? await connectPromise
            : await Promise.race([
                connectPromise,
                new Promise<never>((_resolve, reject) => {
                  connectTimer = setTimeout(() => {
                    connectTimedOut = true
                    reject(
                      new Error(
                        `Timed out reconnecting Docker SSH target after ${connectTimeoutMs}ms`
                      )
                    )
                  }, connectTimeoutMs)
                })
              ])
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(targetId, state)
      } catch (error) {
        if (connectTimedOut) {
          void window.api.ssh.disconnect({ targetId }).catch(() => undefined)
        }
        throw error
      } finally {
        if (connectTimer !== null) {
          clearTimeout(connectTimer)
        }
      }
    },
    { connectTimeoutMs: options.connectTimeoutMs, targetId, disconnectFirst }
  )
}

export async function reconnectDockerSshRelayTarget(
  page: Page,
  targetId: string,
  options: DockerSshRelayReconnectOptions = {}
): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, true, options)
}

export async function reconnectDisconnectedDockerSshRelayTarget(
  page: Page,
  targetId: string,
  options: DockerSshRelayReconnectOptions = {}
): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, false, options)
}

export async function recoverDockerSshRelayAfterFault(
  page: Page,
  targetId: string,
  injectFault: () => void | Promise<void>
): Promise<void> {
  const readAuthority = () =>
    page.evaluate((id) => window.__store?.getState().sshConnectionStates.get(id), targetId)
  const before = await readAuthority()
  expect(before).toMatchObject({
    status: 'connected',
    providerEpoch: expect.any(String),
    connectionGeneration: expect.any(Number)
  })
  await injectFault()
  // The pre-fault connected publication can remain visible until the next IPC event.
  await expect
    .poll(
      async () => {
        const after = await readAuthority()
        return (
          after?.status === 'connected' &&
          (after.providerEpoch !== before?.providerEpoch ||
            after.connectionGeneration !== before?.connectionGeneration)
        )
      },
      { timeout: 120_000, message: 'SSH authority did not recover after the injected fault' }
    )
    .toBe(true)
}
