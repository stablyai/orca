// Why: shortening an owner grace is only safe against an owner the relay has
// evidence is gone, and that evidence exists only where the transport ended on the peer's side. A
// teardown the relay itself initiated — backpressure, a decode fault — proves nothing about liveness,
// so 'local' is the default and never shortens anything.
export type PtyConsumerCloseCause = 'peer-closed' | 'local'
