import { expect, expectTypeOf, it } from 'vitest'
import type { WebPairingOffer } from './web-pairing'
import * as WebClient from './web-runtime-client'

it('keeps the paired-web client public export surface exact', () => {
  expectTypeOf<WebClient.SubscribeOptions>().toEqualTypeOf<WebClient.SubscribeOptions>()
  expectTypeOf<WebClient.WebRuntimeSubscriptionHandle>().toEqualTypeOf<WebClient.WebRuntimeSubscriptionHandle>()
  expectTypeOf<ConstructorParameters<typeof WebClient.WebRuntimeClient>>().toEqualTypeOf<
    [
      pairing: WebPairingOffer,
      options?: ConstructorParameters<typeof WebClient.WebRuntimeClient>[1]
    ]
  >()
  expectTypeOf<keyof WebClient.WebRuntimeClient>().toEqualTypeOf<
    'call' | 'close' | 'subscribe' | 'statusOwner'
  >()
  expect(Object.keys(WebClient)).toEqual(['WebRuntimeClient'])
})
