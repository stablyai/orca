import { expect, expectTypeOf, it } from 'vitest'
import type { WebPairingOffer } from './web-pairing'
import * as WebClient from './web-runtime-client'

it('keeps the paired-web client public export surface exact', () => {
  expectTypeOf<WebClient.SubscribeOptions>().toEqualTypeOf<WebClient.SubscribeOptions>()
  expectTypeOf<WebClient.WebRuntimeSubscriptionHandle>().toEqualTypeOf<WebClient.WebRuntimeSubscriptionHandle>()
  expectTypeOf<ConstructorParameters<typeof WebClient.WebRuntimeClient>>().toEqualTypeOf<
    [pairing: WebPairingOffer]
  >()
  expectTypeOf<keyof WebClient.WebRuntimeClient>().toEqualTypeOf<'call' | 'close' | 'subscribe'>()
  expect(Object.keys(WebClient)).toEqual(['WebRuntimeClient'])
})
