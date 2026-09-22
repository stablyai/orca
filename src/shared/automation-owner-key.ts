import type {
  AutomationAuthorityRef,
  AutomationHostSelector,
  AutomationOwnerRef,
  StableAutomationAuthorityRef,
  StableAutomationCatalogRef,
  StableAutomationCatalogSelector
} from './automation-owner-ref'

/**
 * The one canonical encoder for automation ownership keys.
 *
 * Every component is `encodeURIComponent`-escaped before joining, so the
 * separator can never appear inside a component and a hostile target ID cannot
 * forge another host's key. Display labels, bare IDs, and `JSON.stringify` are
 * never keys: labels change, bare IDs collide across authorities, and object
 * key order is not part of the language contract.
 *
 * Stable and owner keys live in separate namespaces (`host:` / `owner:`) so a
 * desktop+self stable key can never be mistaken for a desktop+self owner key if
 * the two ever share a map.
 */

const SEPARATOR = ':'
const HOST_STABLE_NAMESPACE = 'host'
const OWNER_NAMESPACE = 'owner'

function encodePart(value: string): string {
  return encodeURIComponent(value)
}

// Numbers are encoded through the same escaper so exotic literals ('1e+21') stay separator-free.
function encodeNumber(value: number): string {
  return encodePart(String(value))
}

function decodePart(raw: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }
  // Why: require the canonical escaping so a non-round-tripping key is rejected rather than aliased.
  return decoded && encodePart(decoded) === raw ? decoded : null
}

function stableAuthorityParts(authority: StableAutomationAuthorityRef): string[] {
  return authority.kind === 'desktop'
    ? ['desktop']
    : ['runtime', encodePart(authority.environmentId)]
}

function ownerAuthorityParts(authority: AutomationAuthorityRef): string[] {
  return authority.kind === 'desktop'
    ? ['desktop']
    : ['runtime', encodePart(authority.environmentId), encodeNumber(authority.pairingRevision)]
}

function stableSelectorParts(selector: StableAutomationCatalogSelector): string[] {
  return selector.kind === 'ssh' ? ['ssh', encodePart(selector.targetId)] : [selector.kind]
}

function ownerSelectorParts(selector: AutomationHostSelector): string[] {
  return selector.kind === 'ssh'
    ? ['ssh', encodePart(selector.targetId), encodeNumber(selector.targetGeneration)]
    : ['self']
}

/** Key for the persisted filter and display slot; excludes every incarnation field. */
export function hostStableKey(ref: StableAutomationCatalogRef): string {
  return [
    HOST_STABLE_NAMESPACE,
    ...stableAuthorityParts(ref.authority),
    ...stableSelectorParts(ref.selector)
  ].join(SEPARATOR)
}

/** Key for fetched rows, mutations, secondary reads, and commit fences; includes incarnations. */
export function ownerKey(owner: AutomationOwnerRef): string {
  return [
    OWNER_NAMESPACE,
    ...ownerAuthorityParts(owner.authority),
    ...ownerSelectorParts(owner.selector)
  ].join(SEPARATOR)
}

export function toStableCatalogRef(owner: AutomationOwnerRef): StableAutomationCatalogRef {
  const authority: StableAutomationAuthorityRef =
    owner.authority.kind === 'desktop'
      ? { kind: 'desktop' }
      : { kind: 'runtime', environmentId: owner.authority.environmentId }
  return owner.selector.kind === 'ssh'
    ? { authority, selector: { kind: 'ssh', targetId: owner.selector.targetId } }
    : { authority, selector: { kind: 'self' } }
}

export function isSameAutomationOwner(a: AutomationOwnerRef, b: AutomationOwnerRef): boolean {
  return ownerKey(a) === ownerKey(b)
}

export function isSameStableAutomationHost(
  a: StableAutomationCatalogRef,
  b: StableAutomationCatalogRef
): boolean {
  return hostStableKey(a) === hostStableKey(b)
}

function parseStableAuthority(
  parts: readonly string[]
): { authority: StableAutomationAuthorityRef; rest: readonly string[] } | null {
  if (parts[0] === 'desktop') {
    return { authority: { kind: 'desktop' }, rest: parts.slice(1) }
  }
  if (parts[0] !== 'runtime') {
    return null
  }
  const environmentId = parts[1] === undefined ? null : decodePart(parts[1])
  return environmentId
    ? { authority: { kind: 'runtime', environmentId }, rest: parts.slice(2) }
    : null
}

function parseStableSelector(parts: readonly string[]): StableAutomationCatalogSelector | null {
  if (parts.length === 1 && (parts[0] === 'self' || parts[0] === 'orphan')) {
    return { kind: parts[0] }
  }
  if (parts.length !== 2 || parts[0] !== 'ssh') {
    return null
  }
  const targetId = decodePart(parts[1])
  return targetId ? { kind: 'ssh', targetId } : null
}

/** Inverse of {@link hostStableKey}; returns null for anything malformed. */
export function parseHostStableKey(key: string): StableAutomationCatalogRef | null {
  const parts = key.split(SEPARATOR)
  if (parts[0] !== HOST_STABLE_NAMESPACE) {
    return null
  }
  const parsedAuthority = parseStableAuthority(parts.slice(1))
  if (!parsedAuthority) {
    return null
  }
  const selector = parseStableSelector(parsedAuthority.rest)
  return selector
    ? ({ authority: parsedAuthority.authority, selector } as StableAutomationCatalogRef)
    : null
}
