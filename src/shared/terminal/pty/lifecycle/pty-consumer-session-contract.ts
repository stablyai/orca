// Shorten owner grace only for peer-ended transport proving departure. Relay-initiated backpressure/decode teardown
// proves no owner death, so local closes never shorten grace.
export type PtyConsumerCloseCause = 'peer-closed' | 'local'
