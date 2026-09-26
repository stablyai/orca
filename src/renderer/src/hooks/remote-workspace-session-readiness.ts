import type { StoreApi } from 'zustand'
import type { AppState } from '../store/types'

const WORKSPACE_HYDRATION_TIMEOUT_MS = 10_000
const WORKSPACE_HYDRATION_POLL_MS = 100

function waitForNextReadinessCheck(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false)
  }
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const finish = (shouldContinue: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      signal?.removeEventListener('abort', onAbort)
      resolve(shouldContinue)
    }
    const onAbort = (): void => finish(false)
    timer = setTimeout(() => finish(true), WORKSPACE_HYDRATION_POLL_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      finish(false)
    }
  })
}

async function pollForRemoteWorkspaceSessionReady(
  store: Pick<StoreApi<AppState>, 'getState'>,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + WORKSPACE_HYDRATION_TIMEOUT_MS
  while (!signal?.aborted && Date.now() < deadline) {
    if (store.getState().workspaceSessionReady) {
      return true
    }
    if (!(await waitForNextReadinessCheck(signal))) {
      return false
    }
  }
  return !signal?.aborted && store.getState().workspaceSessionReady
}

export async function waitForRemoteWorkspaceSessionReady(
  store: Pick<StoreApi<AppState>, 'getState'> & Partial<Pick<StoreApi<AppState>, 'subscribe'>>,
  signal?: AbortSignal
): Promise<boolean> {
  if (!store.subscribe) {
    return pollForRemoteWorkspaceSessionReady(store, signal)
  }
  if (signal?.aborted) {
    return false
  }
  if (store.getState().workspaceSessionReady) {
    return true
  }
  const deadline = Date.now() + WORKSPACE_HYDRATION_TIMEOUT_MS
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let unsubscribe = (): void => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const finish = (ready: boolean): void => {
    if (settled) {
      return
    }
    settled = true
    if (timer !== null) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', onAbort)
    unsubscribe()
    resolve(ready)
  }
  const onAbort = (): void => finish(false)
  signal?.addEventListener('abort', onAbort, { once: true })
  const subscribedUnsubscribe = store.subscribe((state) => {
    if (signal?.aborted) {
      finish(false)
    } else if (state.workspaceSessionReady) {
      finish(true)
    }
  })
  unsubscribe = subscribedUnsubscribe
  if (settled) {
    subscribedUnsubscribe()
  } else if (signal?.aborted) {
    finish(false)
  } else if (store.getState().workspaceSessionReady) {
    finish(true)
  } else {
    timer = setTimeout(
      () => finish(!signal?.aborted && store.getState().workspaceSessionReady),
      Math.max(0, deadline - Date.now())
    )
  }
  return promise
}
