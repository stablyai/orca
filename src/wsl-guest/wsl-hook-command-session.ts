import type { Readable, Writable } from 'node:stream'
import { homedir, userInfo } from 'node:os'
import { resolveSystemClaudeHookTarget } from '../main/claude/claude-hook-target'
import { readWslCliContext, WSL_CLI_CONTEXT_ENV } from '../shared/wsl-cli-context'
import { RelayDispatcher, type MethodHandler } from './dispatcher'
import { PreflightHandler } from './preflight-handler'
import { registerWslHookFsHandlers } from './wsl-hook-fs-bridge'
import { RELAY_SENTINEL } from './protocol'

/** No event listener or endpoint publication: stdin owns this command's entire lifetime. */
export async function runWslHookCommandSession(
  input: Readable = process.stdin,
  output: Writable = process.stdout
): Promise<void> {
  const origin = readWslCliContext(process.env[WSL_CLI_CONTEXT_ENV] ?? '')
  if (
    userInfo().username !== origin.user ||
    homedir() !== origin.home ||
    process.cwd() !== origin.cwd
  ) {
    throw new Error('WSL hooks session did not enter the original caller context')
  }
  const target = await resolveSystemClaudeHookTarget({ env: origin.env })
  if (input.destroyed) {
    throw new Error('WSL hooks session input is closed')
  }
  const controller = new AbortController()
  const active = new Set<Promise<unknown>>()
  const dispatcher = new RelayDispatcher(
    (data, onSettled) =>
      output.write(data, (error) => onSettled(error ? { ok: false, error } : { ok: true })),
    { supportsWriteCallback: true }
  )
  const owned = {
    onRequest(method: string, handler: MethodHandler): void {
      dispatcher.onRequest(method, (params, context) => {
        controller.signal.throwIfAborted()
        const cancel = (): void => controller.abort()
        context.signal?.addEventListener('abort', cancel, { once: true })
        if (context.signal?.aborted) {
          cancel()
        }
        const work = Promise.resolve().then(() => handler(params, context))
        active.add(work)
        void work
          .finally(() => {
            active.delete(work)
            context.signal?.removeEventListener('abort', cancel)
          })
          .catch(() => {})
        return work
      })
    }
  }
  new PreflightHandler(owned, target.configDir)
  registerWslHookFsHandlers(owned, origin.home, undefined, {
    configDir: target.configDir,
    signal: controller.signal
  })
  let stop = (): void => {}
  const feed = (chunk: Buffer): void => dispatcher.feed(chunk)
  await new Promise<void>((resolve) => {
    stop = (): void => {
      controller.abort()
      resolve()
    }
    input.on('data', feed)
    input.once('end', stop)
    input.once('error', stop)
    output.once('error', stop)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    dispatcher.writePrimaryBytes(Buffer.from(RELAY_SENTINEL))
  })
  // Rejecting a timed-out host promise does not settle an admitted filesystem syscall.
  await Promise.allSettled(active)
  dispatcher.dispose()
  input.off('data', feed)
  input.off('end', stop)
  input.off('error', stop)
  output.off('error', stop)
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
