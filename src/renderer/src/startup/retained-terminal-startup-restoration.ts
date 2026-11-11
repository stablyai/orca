import { isWebClient } from '../components/sidebar/workspace-card/controller/worktree-card-model'
import { installRetainedTerminalDestination } from '../store/terminals/retained-terminal-start'
import { retainedTerminalDestination } from '../../../shared/workspace-layout/retained-terminal-destination'
import { z } from 'zod'
import { useAppStore } from '../store/index'
import { TerminalStartupAttempt } from '../store/terminals/terminal-startup-attempt'

const startupDestinations = z.object({ retainedTerminalStarts: z.array(z.unknown()) })

export type RetainedTerminalStartupPreparation = {
  prepare: () => Promise<boolean>
  isPrepared: () => boolean
  dispose: () => void
}

/** Install host-owned starts synchronously before reconnect can expose an unbound pane. */
export async function prepareRetainedTerminalStartupRestoration(
  isCancelled: () => boolean,
  attempt?: TerminalStartupAttempt
): Promise<boolean> {
  if (isCancelled()) {
    return false
  }
  const context = attempt ?? new TerminalStartupAttempt()
  if (!attempt) {
    useAppStore.getState().terminalStartupAttempt?.dispose()
    useAppStore.setState({ terminalStartupAttempt: context })
  }
  if (!isWebClient()) {
    context.ensureCaptured(useAppStore.getState())
  }
  const generation = context.generation
  const read = context.beginRead(useAppStore.getState())
  const restoration = await window.api.app.prepareTerminalStartupRestoration()
  if (
    isCancelled() ||
    useAppStore.getState().terminalStartupAttempt !== context ||
    context.generation !== generation
  ) {
    return false
  }
  // The browser shim's void result carries no local or paired start authority.
  if (isWebClient()) {
    context.settleAll(read, useAppStore.getState())
    return true
  }
  const parsed = startupDestinations.safeParse(restoration)
  if (!parsed.success) {
    return true
  }
  const unresolved = new Set<string>()
  let complete = true
  for (const candidate of parsed.data.retainedTerminalStarts) {
    if (
      isCancelled() ||
      context.generation !== generation ||
      useAppStore.getState().terminalStartupAttempt !== context
    ) {
      return false
    }
    const parsedDestination = retainedTerminalDestination.safeParse(candidate)
    if (!parsedDestination.success) {
      complete = false
      continue
    }
    const destination = parsedDestination.data
    const disposition = installRetainedTerminalDestination(destination, context)
    if (disposition === 'unresolved') {
      context.keepUnknown(destination.start)
      unresolved.add(`${destination.start.tabId}:${destination.start.leafId}`)
    }
  }
  if (complete) {
    context.settleAll(read, useAppStore.getState(), unresolved)
  }
  useAppStore.setState({ terminalStartupAttempt: context })
  return !isCancelled()
}

/** Shared by one startup attempt's normal continuation and degraded recovery. */
export function createRetainedTerminalStartupPreparation(
  isCancelled: () => boolean
): RetainedTerminalStartupPreparation {
  let installed = false
  let pending: Promise<boolean> | undefined
  let pendingGeneration = -1
  let installedGeneration = -1
  const attempt = new TerminalStartupAttempt()
  useAppStore.getState().terminalStartupAttempt?.dispose()
  useAppStore.setState({ terminalStartupAttempt: attempt })
  return {
    isPrepared: () =>
      installed &&
      attempt.isComplete() &&
      installedGeneration === attempt.generation &&
      !isCancelled() &&
      useAppStore.getState().terminalStartupAttempt === attempt,
    dispose: () => {
      attempt.dispose()
      if (useAppStore.getState().terminalStartupAttempt === attempt) {
        useAppStore.setState({ terminalStartupAttempt: undefined })
      }
    },
    prepare: () => {
      if (isCancelled() || useAppStore.getState().terminalStartupAttempt !== attempt) {
        return Promise.resolve(false)
      }
      if (installed && attempt.isComplete() && installedGeneration === attempt.generation) {
        return Promise.resolve(true)
      }
      if (!isWebClient()) {
        attempt.ensureCaptured(useAppStore.getState())
      }
      if (pending && pendingGeneration === attempt.generation) {
        return pending
      }
      pendingGeneration = attempt.generation
      const requestGeneration = pendingGeneration
      const current = prepareRetainedTerminalStartupRestoration(isCancelled, attempt)
        .then((prepared) => {
          const accepted =
            prepared &&
            !isCancelled() &&
            requestGeneration === attempt.generation &&
            useAppStore.getState().terminalStartupAttempt === attempt
          if (pending === current) {
            installed = accepted
            if (installed) {
              installedGeneration = requestGeneration
            }
          }
          return accepted
        })
        .finally(() => {
          if (pending === current) {
            pending = undefined
          }
        })
      pending = current
      return pending
    }
  }
}
