import type { PrimaryAction } from './source-control-primary-action-types'

export function resolveVisibleCreatePrHeaderAction({
  createPrHeaderAction
}: {
  createPrHeaderAction: PrimaryAction | null
}): PrimaryAction | null {
  // Disable rather than hide Create PR to keep the toolbar stable.
  return createPrHeaderAction
}
