import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT } from '../orca-sign-in.test-fixture'
import { webhookErrorMessage } from './webhook-copy'

const initial = useAppStore.getState()
afterEach(() => useAppStore.setState(initial, true))

it("blames sign-in only for this desktop's own hooks, not a paired server's", () => {
  useAppStore.setState({ orcaProfileAuthStatus: ORCA_SIGNED_OUT })
  expect(webhookErrorMessage('webhooks_unavailable', 'Scout', { kind: 'local' })).toBe(
    'Paused while signed out of Orca.'
  )
  expect(
    webhookErrorMessage('webhooks_unavailable', 'Scout', {
      kind: 'environment',
      environmentId: 'server'
    })
  ).toBe('Webhooks aren’t available right now.')
})
