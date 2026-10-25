import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export type MonacoSetupStep = readonly [name: string, setup: () => void]

// Isolate optional registrations so one failure cannot abort editor imports; record swallowed failures in crash breadcrumbs.
export function runMonacoSetupSteps(steps: readonly MonacoSetupStep[]): void {
  for (const [name, setup] of steps) {
    try {
      setup()
    } catch (error) {
      console.error(`[Monaco Setup] ${name} failed`, error)
      recordRendererCrashBreadcrumb('monaco_setup_step_failed', {
        step: name,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
}
