import { useCallback, useMemo, useState } from 'react'
import type { CloudSecretScope } from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { applyDotenvPaste, askScopes, type CloudSecretsAskData } from './cloud-secrets-ask-model'
import {
  EMPTY_ASK_STATE,
  type CloudSecretsAskFormActions,
  type CloudSecretsAskFormState
} from './CloudSecretsAskForm'
import { saveMissingSecrets } from './use-cloud-secrets-ask'

export function useCloudSecretsAskForm(args: {
  data: CloudSecretsAskData | null
  /** Running sandbox to refresh after a save; null while it is starting or asleep. */
  refreshRuntimeEnvironmentId: string | null
  onSaved: (names: string[]) => void
  onSkip: () => void
}): { state: CloudSecretsAskFormState; actions: CloudSecretsAskFormActions } {
  const { data, refreshRuntimeEnvironmentId, onSaved, onSkip } = args
  const [state, setState] = useState<CloudSecretsAskFormState>(EMPTY_ASK_STATE)

  const save = useCallback(async () => {
    if (!data) {
      return
    }
    const values = Object.fromEntries(
      data.missing
        .map((name) => [name, state.values[name] ?? ''] as const)
        .filter(([, value]) => value.length > 0)
    )
    if (Object.keys(values).length === 0) {
      return
    }
    setState((current) => ({ ...current, phase: 'saving', refused: {} }))
    // Unchosen names go to the first scope offered (Personal, or Repository in a shared workspace).
    const fallback = askScopes(data)[0]
    if (!fallback) {
      return
    }
    const scopes = Object.fromEntries(
      Object.keys(values).map((name) => [name, state.scopes[name] ?? fallback])
    )
    const result = await saveMissingSecrets({
      values,
      scopes,
      repoKey: data.repoKey,
      refreshRuntimeEnvironmentId
    })
    if (!result.ok) {
      setState((current) => ({ ...current, phase: 'failed' }))
      return
    }
    setState((current) => {
      // Saved values leave the renderer at once; refused ones stay so they can be fixed.
      const kept = Object.fromEntries(
        Object.entries(current.values).filter(([name]) => !result.saved.includes(name))
      )
      return {
        ...current,
        values: kept,
        refused: result.refused,
        phase: result.saved.length > 0 ? 'saved' : 'editing',
        pasteSummary: null
      }
    })
    if (result.saved.length > 0) {
      onSaved(result.saved)
    }
  }, [data, state.values, state.scopes, refreshRuntimeEnvironmentId, onSaved])

  const actions = useMemo<CloudSecretsAskFormActions>(
    () => ({
      onValueChange: (name, value) =>
        setState((current) => {
          const { [name]: _cleared, ...refused } = current.refused
          return {
            ...current,
            values: { ...current.values, [name]: value },
            refused,
            phase: current.phase === 'failed' ? 'editing' : current.phase
          }
        }),
      onScopeChange: (name: string, scope: CloudSecretScope) =>
        setState((current) => ({ ...current, scopes: { ...current.scopes, [name]: scope } })),
      onTogglePaste: () => setState((current) => ({ ...current, pasteOpen: !current.pasteOpen })),
      onPaste: (text) =>
        setState((current) => {
          if (!data || !text.trim()) {
            return current
          }
          const applied = applyDotenvPaste(text, data.missing, current.values)
          return {
            ...current,
            values: applied.values,
            pasteOpen: false,
            pasteSummary: applied.summary
          }
        }),
      onSave: () => void save(),
      onSkip: () => {
        setState({ ...EMPTY_ASK_STATE, phase: 'skipped' })
        onSkip()
      }
    }),
    [data, save, onSkip]
  )
  return { state, actions }
}
