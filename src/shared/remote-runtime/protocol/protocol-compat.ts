// Pure compatibility checks take versions as inputs so renderer/tests and the Expo mirror need no platform dependencies.

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
  // Missing versions mean protocol 0, giving old servers explicit update refusals before unsupported RPCs.
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
  // Missing desktop fields mean version 0: allow legacy peers until a positive minimum deliberately fences them.
  const desktopVersion = input.desktopProtocolVersion ?? 0
  const requiredMobile = input.desktopMinCompatibleMobileVersion ?? 0

  // Desktop’s mobile kill switch outranks mobile’s local desktop-age refusal.
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
