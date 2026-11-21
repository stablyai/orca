function labelKey(label: string): string {
  return label.trim().toLowerCase()
}

function sharedLabels(labels: readonly string[]): Set<string> {
  const counts = new Map<string, number>()
  for (const label of labels) {
    const key = labelKey(label)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key))
}

/** A whole parenthetical or the entire label. A shorter id inside a longer one is not a match. */
function tokenPresent(label: string, token: string): boolean {
  if (token.length === 0) {
    return false
  }
  const lower = label.toLowerCase()
  const needle = token.toLowerCase()
  return lower === needle || lower.includes(`(${needle})`)
}

/** Names a provider route on a label several models share, leaving the model id unchanged. */
export function distinguishSharedModelLabels(
  models: readonly { id: string; label: string }[]
): string[] {
  const duplicated = sharedLabels(models.map((model) => model.label))
  const qualified = models.map((model) => {
    if (!duplicated.has(labelKey(model.label))) {
      return model.label
    }
    const slash = model.id.indexOf('/')
    const provider = slash > 0 ? model.id.slice(0, slash) : ''
    if (provider && !tokenPresent(model.label, provider)) {
      return `${model.label} (${provider})`
    }
    return tokenPresent(model.label, model.id) ? model.label : `${model.label} (${model.id})`
  })
  const stillShared = sharedLabels(qualified)
  const named = qualified.map((label, index) => {
    const model = models[index]
    if (!model || !stillShared.has(labelKey(label)) || tokenPresent(label, model.id)) {
      return label
    }
    return `${model.label} (${model.id})`
  })
  return uniqueChoiceLabels(named, models)
}

/** Resolve against the labels that will render, until every choice has its own. */
function uniqueChoiceLabels(
  labels: readonly string[],
  models: readonly { id: string; label: string }[]
): string[] {
  const next = [...labels]
  for (let pass = 0; pass <= models.length; pass += 1) {
    const shared = sharedLabels(next)
    if (shared.size === 0) {
      return next
    }
    let changed = false
    for (let index = 0; index < next.length; index += 1) {
      const current = next[index]
      const model = models[index]
      if (!current || !model || !shared.has(labelKey(current))) {
        continue
      }
      const withId = tokenPresent(current, model.id)
        ? `${model.label} (${model.id}) #${index + 1}`
        : `${current} (${model.id})`
      const taken = next.some(
        (label, other) => other !== index && labelKey(label) === labelKey(withId)
      )
      const resolved = taken ? `${withId} #${index + 1}` : withId
      if (resolved !== current) {
        next[index] = resolved
        changed = true
      }
    }
    if (!changed) {
      for (let index = 0; index < next.length; index += 1) {
        const current = next[index]
        if (current && shared.has(labelKey(current))) {
          next[index] = `${current} #${index + 1}`
        }
      }
    }
  }
  return next
}
