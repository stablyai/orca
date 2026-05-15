// Why: pure compat evaluators shared between desktop tests, renderer runtime
// switching, and the mobile mirror. All version numbers are passed in to keep
// the logic dependency-free and easy to duplicate in Expo.

export type RuntimeCompatVerdict =
  | {
      kind: 'ok'
      clientProtocolVersion: number
      serverProtocolVersion: number
    }
  | {
      kind: 'blocked'
      reason: 'client-too-old' | 'server-too-old'
      clientProtocolVersion: number
      serverProtocolVersion: number
      requiredClientProtocolVersion?: number
      requiredServerProtocolVersion?: number
    }

export function evaluateRuntimeCompat(input: {
  clientProtocolVersion: number
  minCompatibleServerProtocolVersion: number
  serverProtocolVersion: number | undefined
  serverMinCompatibleClientProtocolVersion: number | undefined
}): RuntimeCompatVerdict {
  // Why: absent fields are protocol 0. New clients can give old servers a
  // clear "update server" error instead of attempting partially-supported RPCs.
  const serverProtocolVersion = input.serverProtocolVersion ?? 0
  const requiredClientProtocolVersion = input.serverMinCompatibleClientProtocolVersion ?? 0

  if (input.clientProtocolVersion < requiredClientProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'client-too-old',
      clientProtocolVersion: input.clientProtocolVersion,
      serverProtocolVersion,
      requiredClientProtocolVersion
    }
  }
  if (serverProtocolVersion < input.minCompatibleServerProtocolVersion) {
    return {
      kind: 'blocked',
      reason: 'server-too-old',
      clientProtocolVersion: input.clientProtocolVersion,
      serverProtocolVersion,
      requiredServerProtocolVersion: input.minCompatibleServerProtocolVersion
    }
  }
  return {
    kind: 'ok',
    clientProtocolVersion: input.clientProtocolVersion,
    serverProtocolVersion
  }
}

export function describeRuntimeCompatBlock(verdict: RuntimeCompatVerdict): string {
  if (verdict.kind === 'ok') {
    return 'Runtime client and server are compatible.'
  }
  if (verdict.reason === 'client-too-old') {
    return `This Orca client is too old for the selected server. Update Orca on this machine. Client protocol ${verdict.clientProtocolVersion}, server requires client protocol ${verdict.requiredClientProtocolVersion}.`
  }
  return `The selected Orca server is too old for this client. Update Orca on the server. Server protocol ${verdict.serverProtocolVersion}, client requires server protocol ${verdict.requiredServerProtocolVersion}.`
}

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
