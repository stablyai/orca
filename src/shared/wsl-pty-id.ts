const PREFIX = 'wsl:'
const SEPARATOR = '@@'

export type WslPtyOwner = {
  distro: string
  relayBuildId: string
}

export type ParsedWslPtyId = WslPtyOwner & { relayPtyId: string }

function validPart(value: string): boolean {
  return value.trim().length > 0 && !/[\0\r\n]/.test(value)
}

export function parseAppWslPtyId(id: string): ParsedWslPtyId | null {
  if (!id.startsWith(PREFIX)) {
    return null
  }
  const first = id.indexOf(SEPARATOR, PREFIX.length)
  const second = id.indexOf(SEPARATOR, first + SEPARATOR.length)
  if (first === -1 || second === -1) {
    return null
  }
  try {
    const distro = decodeURIComponent(id.slice(PREFIX.length, first))
    const relayBuildId = decodeURIComponent(id.slice(first + SEPARATOR.length, second))
    const relayPtyId = id.slice(second + SEPARATOR.length)
    return validPart(distro) && validPart(relayBuildId) && validPart(relayPtyId)
      ? { distro, relayBuildId, relayPtyId }
      : null
  } catch {
    return null
  }
}

function assertOwner(owner: WslPtyOwner, parsed: ParsedWslPtyId): void {
  if (parsed.distro !== owner.distro || parsed.relayBuildId !== owner.relayBuildId) {
    throw new Error('WSL terminal belongs to a different distro or relay build')
  }
}

export function toAppWslPtyId(owner: WslPtyOwner, relayPtyId: string): string {
  if (!validPart(owner.distro) || !validPart(owner.relayBuildId) || !validPart(relayPtyId)) {
    throw new Error('Invalid WSL terminal identity')
  }
  const parsed = parseAppWslPtyId(relayPtyId)
  if (parsed) {
    assertOwner(owner, parsed)
    return relayPtyId
  }
  if (relayPtyId.startsWith(PREFIX) || relayPtyId.startsWith('ssh:')) {
    throw new Error('Expected a guest-local terminal identity')
  }
  return `${PREFIX}${encodeURIComponent(owner.distro)}${SEPARATOR}${encodeURIComponent(owner.relayBuildId)}${SEPARATOR}${relayPtyId}`
}

export function toRelayWslPtyId(owner: WslPtyOwner, id: string): string {
  const parsed = parseAppWslPtyId(id)
  if (!parsed) {
    throw new Error('Expected a WSL-owned terminal identity')
  }
  assertOwner(owner, parsed)
  return parsed.relayPtyId
}
