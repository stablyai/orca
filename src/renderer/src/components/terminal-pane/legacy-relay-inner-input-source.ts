import type { PtyInputSource } from './pty-input-source'

/** Retained input belongs to this exact lower token and this selection lifetime. */
export function projectLegacyRelayInnerInputSource(
  target: PtyInputSource,
  owns: () => boolean
): PtyInputSource {
  const isCurrent = (): boolean => owns() && target.isCurrent()
  const accepted = target.sendInputAccepted
  const claim = target.claimViewport
  return {
    ptyId: target.ptyId,
    get endpoint() {
      return target.endpoint
    },
    isCurrent,
    sendInput: (data, kind) => isCurrent() && target.sendInput(data, kind),
    sendInputImmediate: (data) => isCurrent() && target.sendInputImmediate(data),
    ...(accepted
      ? {
          sendInputAccepted: async (...params: Parameters<typeof accepted>) =>
            isCurrent() && (await accepted.call(target, ...params)) && isCurrent()
        }
      : {}),
    ...(claim
      ? {
          claimViewport: (...params: Parameters<typeof claim>) =>
            isCurrent() && claim.call(target, ...params)
        }
      : {})
  }
}
