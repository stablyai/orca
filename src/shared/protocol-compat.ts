// Why: pure compat evaluator shared between desktop tests and mobile
// runtime. Mobile imports a thin wrapper (`mobile/src/transport/protocol-compat.ts`)
// that injects the mobile-side constants; desktop tests import this
// directly so the function is covered by the root vitest suite.
// All four numbers are passed in to keep the function dependency-free.

export type CompatVerdict =
  | { kind: 'ok' }
  | {
      kind: 'blocked'
      reason: 'mobile-too-old' | 'desktop-too-old'
      desktopVersion: number
      requiredMobileVersion?: number
      requiredDesktopVersion?: number
    }

export function evaluateCompat(input: {
  mobileProtocolVersion: number
  minCompatibleDesktopVersion: number
  desktopProtocolVersion: number | undefined
  desktopMinCompatibleMobileVersion: number | undefined
}): CompatVerdict {
  // Why: absent fields → 0 lets mobile keep talking to pre-PR desktops.
  // Bumping minCompatibleDesktopVersion above 0 will fence those older
  // desktops alongside any explicitly-version-0 desktop, which is the
  // intended kill-switch behavior.
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  // Why: mobile-too-old precedence — if desktop says "I refuse this
  // mobile build" (kill switch), that wins over any local mobile
  // judgment about desktop's age.
  if (input.mobileProtocolVersion < requiredMobile) {
    return {
      kind: 'blocked',
      reason: 'mobile-too-old',
      desktopVersion,
      requiredMobileVersion: requiredMobile
    }
  }
  if (desktopVersion < input.minCompatibleDesktopVersion) {
    return {
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion,
      requiredDesktopVersion: input.minCompatibleDesktopVersion
    }
  }
  return { kind: 'ok' }
}
