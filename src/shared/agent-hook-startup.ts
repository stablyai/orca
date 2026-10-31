import type { Server } from 'node:http'

/** Coalesce starts and let stop invalidate replay before it binds a listener. */
export class AgentHookStartup {
  private generation = 0
  private pending: { generation: number; promise: Promise<void> } | null = null

  start(bind: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.generation
    if (this.pending) {
      return this.pending.generation === generation
        ? this.pending.promise
        : this.pending.promise
            .catch(() => {})
            .then(() => {
              if (generation === this.generation) {
                return this.start(bind)
              }
              return undefined
            })
    }
    const isCurrent = () => generation === this.generation
    const promise = bind(isCurrent)
      .catch((error: unknown) => {
        if (isCurrent()) {
          throw error
        }
      })
      .finally(() => {
        if (this.pending?.promise === promise) {
          this.pending = null
        }
      })
    this.pending = { generation, promise }
    return promise
  }

  stop(): void {
    this.generation += 1
  }
}

export function listenForAgentHooks(
  server: Server,
  port: number,
  isCurrent: () => boolean,
  onBound: () => void,
  onRuntimeError: (error: Error) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off('close', onClosed)
      server.off('listening', onListening)
      server.off('error', onStartupError)
    }
    const onClosed = () => {
      cleanup()
      resolve()
    }
    const onStartupError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onListening = () => {
      cleanup()
      if (!isCurrent()) {
        server.close()
        resolve()
        return
      }
      server.on('error', onRuntimeError)
      onBound()
      resolve()
    }
    server.once('close', onClosed)
    server.once('listening', onListening)
    server.once('error', onStartupError)
    server.listen(port, '127.0.0.1')
  })
}
