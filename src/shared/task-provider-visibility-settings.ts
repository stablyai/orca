import type { TaskProvider } from './task-providers'

export type TaskProviderVisibilitySettings = {
  /** Persisted last-used task source so Tasks reopens to the same provider instead of defaulting to GitHub. */
  defaultTaskSource: TaskProvider
  /** Persisted visible task providers; hides unused providers from Tasks chrome and sidebar shortcuts. */
  visibleTaskProviders: TaskProvider[]
  /** Why: one-shot guard to make Jira visible for existing profiles once, without re-adding after a later opt-out. */
  visibleTaskProvidersDefaultedForJira: boolean
  /** One-shot stamp: ClickUp was revealed once for profiles saved before it shipped. */
  visibleTaskProvidersDefaultedForClickUp: boolean
}
