const sleeping = new Map<string, Promise<void>>()

export function trackAgentPaneSleep(paneKey: string, run: () => Promise<void>): Promise<void> {
  const pending = (sleeping.get(paneKey) ?? Promise.resolve()).catch(() => {}).then(run)
  sleeping.set(paneKey, pending)
  const settle = (refused: boolean) => {
    if (sleeping.get(paneKey) === pending) {
      sleeping.delete(paneKey)
      // A refused sleep left the agent awake, so no sleeping mail became available.
      if (!refused) {
        window.api.ui.notifySleepingMailAvailability?.(paneKey)
      }
    }
  }
  pending.then(
    () => settle(false),
    (err: unknown) => settle(String(err).includes('orchestration_busy'))
  )
  return pending
}

export async function waitForAgentPaneSleep(paneKey: string): Promise<void> {
  for (let pending = sleeping.get(paneKey); pending; pending = sleeping.get(paneKey)) {
    await pending
  }
}
