import { formatEmulatorAvailabilityUserFacingMessage } from '@/lib/cli-emulator-user-facing-copy'

export function emulatorPaneErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return formatEmulatorAvailabilityUserFacingMessage(error.message) || error.message
  }
  return fallback
}
