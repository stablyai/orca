import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export type MonacoSetupStep = readonly [name: string, setup: () => void]

// Why: these registrations are independent and optional, so one throwing must not skip the
// rest or abort the module import that every editor surface depends on. The breadcrumb keeps
// a swallowed failure visible in crash reports instead of only in a console nobody reads.
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
