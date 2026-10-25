let version = 0

export function getTranslationResourceVersion(): number {
  return version
}

export function advanceTranslationResourceVersion(): void {
  version += 1
}
