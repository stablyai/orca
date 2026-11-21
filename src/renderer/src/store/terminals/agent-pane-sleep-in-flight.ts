const sleeping = new Map<string, Promise<void>>()

export function trackAgentPaneSleep(paneKey: string, run: () => Promise<void>): Promise<void> {
  const pending = (sleeping.get(paneKey) ?? Promise.resolve()).catch(() => {}).then(run)
  sleeping.set(paneKey, pending)
  void pending
    .finally(() => {
      if (sleeping.get(paneKey) === pending) {
        sleeping.delete(paneKey)
        window.api.ui.notifySleepingMailAvailability?.(paneKey)
      }
    })
    .catch(() => undefined)
  return pending
}

export async function waitForAgentPaneSleep(paneKey: string): Promise<void> {
  for (let pending = sleeping.get(paneKey); pending; pending = sleeping.get(paneKey)) {
    await pending
  }
}
