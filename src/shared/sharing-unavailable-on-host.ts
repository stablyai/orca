// Only the signed-in desktop app registers Orca cloud services; headless hosts refuse them by name (#33593).
export const SHARING_UNAVAILABLE_ON_HOST_CODE = 'sharing_unavailable_on_host' as const

export const SHARING_UNAVAILABLE_ON_HOST_MESSAGE =
  "Orca cloud features like sharing aren't available on headless Orca servers yet. Use the Orca desktop app for this."

export const SHARING_UNAVAILABLE_ON_HOST_NEXT_STEPS: readonly string[] = [
  'Open the Orca desktop app, sign in, and run the command from an Orca terminal there.'
]

export class SharingUnavailableOnHostError extends Error {
  readonly code = SHARING_UNAVAILABLE_ON_HOST_CODE
  readonly data = { nextSteps: [...SHARING_UNAVAILABLE_ON_HOST_NEXT_STEPS] }

  constructor() {
    super(SHARING_UNAVAILABLE_ON_HOST_MESSAGE)
    this.name = 'SharingUnavailableOnHostError'
  }
}
