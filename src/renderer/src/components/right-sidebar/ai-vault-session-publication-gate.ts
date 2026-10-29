import { startTransition } from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { hasInputBeenQuietFor, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

const AI_VAULT_PUBLICATION_QUIET_MS = 100
const AI_VAULT_PUBLICATION_MAX_WAIT_MS = 1_000

export class AiVaultSessionPublicationGate {
  private generation = 0
  private cancelPending: (() => void) | null = null

  publish(result: AiVaultListResult, apply: (result: AiVaultListResult) => void): void {
    this.cancel()
    const generation = this.generation
    if (hasInputBeenQuietFor(AI_VAULT_PUBLICATION_QUIET_MS)) {
      startTransition(() => apply(result))
      return
    }
    this.cancelPending = scheduleAfterInputQuiet(
      () => {
        if (generation !== this.generation) {
          return
        }
        this.cancelPending = null
        startTransition(() => apply(result))
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
