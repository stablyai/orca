import { TASK_PROVIDERS, type TaskProvider } from '../work-items/task-providers'

export type TaskProviderVisibilitySettings = {
  /** Persisted visible task providers; hides unused providers from Tasks chrome and sidebar shortcuts. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot guard to make Jira visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** Why: one-shot guard to make ClickUp visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForClickUp: boolean
}

/** New profiles show every provider, so the one-shot guards start satisfied. */
export function defaultTaskProviderVisibilitySettings(): TaskProviderVisibilitySettings {
  return {
    visibleTaskProviders: [...TASK_PROVIDERS],
    visibleTaskProvidersDefaultedForJira: true,
    visibleTaskProvidersDefaultedForClickUp: true
  }
}
