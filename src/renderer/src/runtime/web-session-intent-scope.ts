export type WebSessionIntentScope = {
  environmentId: string
  worktreeId: string
}

type PublicationGeneration = {
  publicationEpoch: string
  seenPublicationEpochs: Set<string>
}

// Why: this registry follows the same bounded host/worktree ownership model as
// the intents it annotates; removed scopes also receive explicit cleanup.
export const MAX_WEB_SESSION_PUBLICATION_EPOCH_SCOPES = 256
export const MAX_WEB_SESSION_PUBLICATION_EPOCHS_PER_SCOPE = 256

const publicationGenerationByScope = new Map<string, PublicationGeneration>()

function trimWebSessionPublicationEpochs(): void {
  while (publicationGenerationByScope.size > MAX_WEB_SESSION_PUBLICATION_EPOCH_SCOPES) {
    const oldestScopeKey = publicationGenerationByScope.keys().next().value
    if (oldestScopeKey === undefined) {
      break
    }
    publicationGenerationByScope.delete(oldestScopeKey)
  }
}

export function webSessionIntentEnvironmentPrefix(environmentId: string): string | null {
  const normalizedEnvironmentId = environmentId.trim()
  return normalizedEnvironmentId ? `${JSON.stringify(normalizedEnvironmentId)}\u0000` : null
}

export function webSessionIntentScopeKey(scope: WebSessionIntentScope): string | null {
  const environmentPrefix = webSessionIntentEnvironmentPrefix(scope.environmentId)
  return environmentPrefix && scope.worktreeId ? `${environmentPrefix}${scope.worktreeId}` : null
}

export function rememberWebSessionPublicationEpoch(
  scope: WebSessionIntentScope,
  publicationEpoch: string
): void {
  const key = webSessionIntentScopeKey(scope)
  if (!key || !publicationEpoch) {
    return
  }
  const existing = publicationGenerationByScope.get(key)
  if (existing?.publicationEpoch === publicationEpoch) {
    publicationGenerationByScope.delete(key)
    publicationGenerationByScope.set(key, existing)
    return
  }
  if (existing?.seenPublicationEpochs.has(publicationEpoch)) {
    // Why: different publication epochs can represent individual host
    // mutations. A late frame from a previously observed epoch must not roll
    // the generation used to bind a new user action backward.
    publicationGenerationByScope.delete(key)
    publicationGenerationByScope.set(key, existing)
    return
  }
  const seenPublicationEpochs = existing?.seenPublicationEpochs ?? new Set<string>()
  seenPublicationEpochs.add(publicationEpoch)
  while (seenPublicationEpochs.size > MAX_WEB_SESSION_PUBLICATION_EPOCHS_PER_SCOPE) {
    const oldestEpoch = seenPublicationEpochs.values().next().value
    if (oldestEpoch === undefined) {
      break
    }
    seenPublicationEpochs.delete(oldestEpoch)
  }
  publicationGenerationByScope.delete(key)
  publicationGenerationByScope.set(key, { publicationEpoch, seenPublicationEpochs })
  trimWebSessionPublicationEpochs()
}

export function getWebSessionPublicationEpoch(scope: WebSessionIntentScope): string | null {
  const key = webSessionIntentScopeKey(scope)
  const generation = key ? publicationGenerationByScope.get(key) : undefined
  if (!key || !generation) {
    return null
  }
  publicationGenerationByScope.delete(key)
  publicationGenerationByScope.set(key, generation)
  return generation.publicationEpoch
}

export function clearWebSessionPublicationEpoch(scope: WebSessionIntentScope): void {
  const key = webSessionIntentScopeKey(scope)
  if (key) {
    publicationGenerationByScope.delete(key)
  }
}

export function clearWebSessionPublicationEpochsForEnvironment(environmentId: string): void {
  const prefix = webSessionIntentEnvironmentPrefix(environmentId)
  if (!prefix) {
    return
  }
  for (const key of publicationGenerationByScope.keys()) {
    if (key.startsWith(prefix)) {
      publicationGenerationByScope.delete(key)
    }
  }
}

export function resetWebSessionPublicationEpochsForTests(): void {
  publicationGenerationByScope.clear()
}

export function getWebSessionPublicationEpochCountForTests(): number {
  return publicationGenerationByScope.size
}

export function getWebSessionPublicationEpochEntryCountForTests(): number {
  let epochs = 0
  for (const generation of publicationGenerationByScope.values()) {
    epochs += generation.seenPublicationEpochs.size
  }
  return epochs
}
