import { startTransition } from 'react'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  hasInputBeenQuietFor,
  scheduleAfterInputQuiet
} from '@/lib/window-activity/input-quiet-scheduler'

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

  publish(
    result: AiVaultListResult,
    apply: (result: AiVaultListResult) => void,
    eligible: () => boolean = () => true
  ): void {
    this.enqueue(() => apply(result), eligible)
  }

  publishProvisional(apply: () => void, eligible: () => boolean): () => void {
    return this.enqueue(apply, eligible)
  }

  private pending: (() => void) | null = null

  private enqueue(apply: () => void, eligible: () => boolean): () => void {
    const land = () => {
      if (eligible()) {
        this.published += 1
        startTransition(apply)
      }
    }
    this.pending = land
    if (hasInputBeenQuietFor(AI_VAULT_PUBLICATION_QUIET_MS)) {
      this.cancel()
      land()
    } else if (!this.cancelPending) {
      const generation = this.generation
      this.cancelPending = scheduleAfterInputQuiet(
        () => {
          if (generation !== this.generation) {
            return
          }
          const pending = this.pending
          this.pending = null
          this.cancelPending = null
          pending?.()
        },
        {
          delayMs: 0,
          quietMs: AI_VAULT_PUBLICATION_QUIET_MS,
          idleTimeoutMs: AI_VAULT_PUBLICATION_QUIET_MS,
          maxWaitMs: AI_VAULT_PUBLICATION_MAX_WAIT_MS
        }
      )
    }
    return () => {
      if (this.pending === land) {
        this.cancel()
      }
    }
  }

  cancel(): void {
    this.generation += 1
    this.cancelPending?.()
    this.cancelPending = null
    this.pending = null
  }
}
