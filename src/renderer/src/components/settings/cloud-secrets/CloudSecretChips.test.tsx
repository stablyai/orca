// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLOUD_SWAPPED_CREDENTIALS,
  cloudSecretStoredOnVm
} from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import { CloudSecretChips } from './CloudSecretVmBadge'

describe('CloudSecretChips', () => {
  afterEach(() => cleanup())

  it('tags every key the egress proxy swaps, from the shared swap rule', () => {
    for (const name of CLOUD_SWAPPED_CREDENTIALS) {
      const { container } = render(<CloudSecretChips name={name} />)
      expect(container.textContent, name).toBe('Agent key')
      cleanup()
    }
  })

  it('tags nothing that reaches the sandbox as a real value, so no row reads as protected', () => {
    const real = [
      'AWS_SECRET_ACCESS_KEY',
      'OPENROUTER_API_KEY',
      'GITHUB_PACKAGES_TOKEN',
      'SENTRY_ENV'
    ]
    for (const name of real) {
      const { container } = render(<CloudSecretChips name={name} />)
      expect(container.textContent, name).toBe('')
      expect(container.textContent).not.toContain('Real value in sandbox')
      cleanup()
    }
    // Agent settings are team-preferred but not credentials: no tag either.
    const { container } = render(<CloudSecretChips name="ANTHROPIC_MODEL" />)
    expect(container.textContent).toBe('')
  })

  it('agrees with the stored-on-VM rule: a tagged key is never one the sandbox holds in full', () => {
    for (const name of CLOUD_SWAPPED_CREDENTIALS) {
      expect(cloudSecretStoredOnVm(name), name).toBe(false)
    }
  })
})
