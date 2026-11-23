import type { CommitMessageModel } from '../../../source-control/ai/generation/commit-message-agent-spec'

export const GRAY_MODEL_LIST_ARGS = ['--dump-models', 'cached']

const modelArgument = (value: unknown): value is string =>
  // eslint-disable-next-line no-control-regex -- CLI operands must not contain terminal control characters.
  typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/u.test(value)

/** Provider and model are independent Gray arguments, not a slash-delimited selector. */
export function grayModelLaunchArgs(id: string): string[] {
  try {
    const pair: unknown = JSON.parse(id)
    if (Array.isArray(pair) && pair.length === 2 && pair.every(modelArgument)) {
      return [`--provider=${pair[0]}`, `--model=${pair[1]}`]
    }
  } catch {
    // An unlisted or stale selection must not become arbitrary command arguments.
  }
  return []
}

export function parseGrayModelList(stdout: string): CommitMessageModel[] {
  let value: { version?: unknown; error?: unknown; providers?: unknown } | null
  try {
    value = JSON.parse(stdout)
  } catch {
    return []
  }
  if (value?.version !== 1 || value.error || !Array.isArray(value.providers)) {
    return []
  }
  const models = new Map<string, CommitMessageModel>()
  for (const provider of value.providers) {
    if (!modelArgument(provider?.id) || !Array.isArray(provider.models)) {
      continue
    }
    const description = modelArgument(provider.name) ? provider.name : provider.id
    for (const model of provider.models) {
      if (!modelArgument(model?.id)) {
        continue
      }
      const id = JSON.stringify([provider.id, model.id])
      if (models.has(id)) {
        continue
      }
      models.set(id, {
        id,
        label: modelArgument(model.name) ? model.name : model.id,
        description,
        ...(provider.active === true && model.current === true ? { isDefault: true } : {})
      })
    }
  }
  return [...models.values()]
}
