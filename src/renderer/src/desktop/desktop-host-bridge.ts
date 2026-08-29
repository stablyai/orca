import type {
  DesktopHostInfo,
  DesktopIpcClientMessage,
  DesktopIpcServerMessage
} from '../../../shared/desktop-host-protocol'

export type DesktopHostBridge = {
  info: DesktopHostInfo
  invoke<T>(channel: string, args?: unknown): Promise<T>
  send(channel: string, args?: unknown): void
  on(channel: string, listener: (args: unknown) => void): () => void
  close(): void
}

const DEFAULT_HOST_URL = 'http://127.0.0.1:6769'

async function readTauriDesktopHostUrl(): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const url = await invoke<string>('desktop_host_url')
    return typeof url === 'string' && url.length > 0 ? url : null
  } catch {
    return null
  }
}

export async function resolveDesktopHostHttpUrl(): Promise<string> {
  const fromTauri = await readTauriDesktopHostUrl()
  if (fromTauri) {
    return fromTauri.replace(/\/$/, '')
  }
  const fromEnv = import.meta.env.VITE_ORCA_DESKTOP_HOST_URL
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, '')
  }
  return DEFAULT_HOST_URL
}

export async function fetchDesktopHostInfo(httpUrl?: string): Promise<DesktopHostInfo> {
  const baseUrl = httpUrl ?? (await resolveDesktopHostHttpUrl())
  const response = await fetch(`${baseUrl}/desktop/host`)
  if (!response.ok) {
    throw new Error(`Desktop host is unavailable at ${baseUrl}`)
  }
  return (await response.json()) as DesktopHostInfo
}

export async function connectDesktopHostBridge(info?: DesktopHostInfo): Promise<DesktopHostBridge> {
  const resolved = info ?? (await fetchDesktopHostInfo())
  const socket = new WebSocket(resolved.ipcUrl)
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const listeners = new Map<string, Set<(args: unknown) => void>>()
  let nextId = 0

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Desktop host IPC connect timed out')),
      8_000
    )
    socket.addEventListener('open', () => {
      window.clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      window.clearTimeout(timer)
      reject(new Error(`Desktop host IPC failed: ${resolved.ipcUrl}`))
    })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as DesktopIpcServerMessage
    if (message.type === 'result') {
      const waiter = pending.get(message.id)
      if (!waiter) {
        return
      }
      pending.delete(message.id)
      if (message.ok) {
        waiter.resolve(message.result)
        return
      }
      waiter.reject(new Error(message.error.message))
      return
    }
    for (const listener of listeners.get(message.channel) ?? []) {
      listener(message.args)
    }
  })

  const sendMessage = (message: DesktopIpcClientMessage): void => {
    socket.send(JSON.stringify(message))
  }

  return {
    info: resolved,
    invoke<T>(channel: string, args?: unknown): Promise<T> {
      const id = `desktop-${++nextId}`
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject
        })
        sendMessage({ type: 'invoke', id, channel, args })
      })
    },
    send(channel: string, args?: unknown): void {
      sendMessage({ type: 'send', channel, args })
    },
    on(channel: string, listener: (args: unknown) => void): () => void {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    },
    close() {
      socket.close()
    }
  }
}
