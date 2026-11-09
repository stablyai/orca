import { startTransition } from 'react'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { hasInputBeenQuietFor, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

const AI_VAULT_PUBLICATION_QUIET_MS = 100
const AI_VAULT_PUBLICATION_MAX_WAIT_MS = 1_000

export class AiVaultSessionPublicationGate {
  private generation = 0
  private cancelPending: (() => void) | null = null

  private published = 0

  /** Applies a list that arrives later unless a list was published meanwhile; cancels don't drop it. */
  showUntilPublished<T>(pending: Promise<T | null>, apply: (value: T) => void): void {
    const published = this.published
    void pending.then((value) => {
      if (value !== null && published === this.published) {
        startTransition(() => apply(value))
      }
    })
  }

  publish(result: AiVaultListResult, apply: (result: AiVaultListResult) => void): void {
    this.cancel()
    const generation = this.generation
    // Counted when it lands: a cancelled publication must not drop a saved list still on its way.
    const land = () => {
      this.published += 1
      startTransition(() => apply(result))
    }
    if (hasInputBeenQuietFor(AI_VAULT_PUBLICATION_QUIET_MS)) {
      land()
      return
    }
    this.cancelPending = scheduleAfterInputQuiet(
      () => {
        if (generation !== this.generation) {
          return
        }
        this.cancelPending = null
        land()
      },
      {
        delayMs: 0,
        quietMs: AI_VAULT_PUBLICATION_QUIET_MS,
        idleTimeoutMs: AI_VAULT_PUBLICATION_QUIET_MS,
        maxWaitMs: AI_VAULT_PUBLICATION_MAX_WAIT_MS
      }
    )
  }

  cancel(): void {
    this.generation += 1
    this.cancelPending?.()
    this.cancelPending = null
  }
}
