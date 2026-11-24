import type { WorkerTabStripChoice } from '../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'

type Choices = Record<string, Record<string, WorkerTabStripChoice>>
const key = 'orca.worker-tab-strip-choices'

export function readWorkerTabWindowChoices(): Choices {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? '{}')
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    const choices: Choices = {}
    for (const [workspace, tabs] of Object.entries(parsed)) {
      if (!tabs || typeof tabs !== 'object') {
        continue
      }
      const accepted: Record<string, WorkerTabStripChoice> = {}
      for (const [tabId, choice] of Object.entries(tabs)) {
        if (choice === 'kept' || choice === 'hidden') {
          accepted[tabId] = choice
        }
      }
      choices[workspace] = accepted
    }
    return choices
  } catch {
    return {}
  }
}

export function saveWorkerTabWindowChoices(choices: Choices): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(choices))
  } catch {
    // Windows without session storage retain their choices until reload.
  }
}
