/**
 * `unsupported` is the mixed-version case — the lease attached to a host that never offered the file
 * channel — and is the only one that may fall back to the desktop Downloads folder. `unavailable`
 * (no lease yet, transport lost, host closed) must fail closed instead: the host may well support
 * the channel, so a local save would be a silent downgrade of where the bytes land.
 */
export type BrowserClientFileChannelAvailability = 'negotiated' | 'unsupported' | 'unavailable'
