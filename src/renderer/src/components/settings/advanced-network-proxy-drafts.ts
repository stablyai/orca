/**
 * Draft state for the three proxy fields.
 */

export type HttpProxyUrlDraftState = {
  sourceValue: string
  draft: string
  error: string | null
}

export function createHttpProxyUrlDraftState(
  httpProxyUrl: string | undefined
): HttpProxyUrlDraftState {
  const sourceValue = httpProxyUrl ?? ''
  return {
    sourceValue,
    draft: sourceValue,
    error: null
  }
}

export function resolveHttpProxyUrlDraftState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined
): HttpProxyUrlDraftState {
  const sourceValue = httpProxyUrl ?? ''
  return state.sourceValue === sourceValue ? state : createHttpProxyUrlDraftState(httpProxyUrl)
}

export function updateHttpProxyUrlDraftState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined,
  draft: string
): HttpProxyUrlDraftState {
  return {
    // Why: settings persistence is async, so edits after an external settings
    // reload must build on the latest persisted proxy source.
    ...resolveHttpProxyUrlDraftState(state, httpProxyUrl),
    draft,
    error: null
  }
}

export function setHttpProxyUrlDraftErrorState(
  state: HttpProxyUrlDraftState,
  httpProxyUrl: string | undefined,
  error: string
): HttpProxyUrlDraftState {
  return {
    ...resolveHttpProxyUrlDraftState(state, httpProxyUrl),
    error
  }
}

export type HttpProxyCaPathDraftState = {
  sourceValue: string
  draft: string
  error: string | null
}

export function createHttpProxyCaPathDraftState(
  httpProxyCaPath: string | undefined
): HttpProxyCaPathDraftState {
  const sourceValue = httpProxyCaPath ?? ''
  return { sourceValue, draft: sourceValue, error: null }
}

export function resolveHttpProxyCaPathDraftState(
  state: HttpProxyCaPathDraftState,
  httpProxyCaPath: string | undefined
): HttpProxyCaPathDraftState {
  const sourceValue = httpProxyCaPath ?? ''
  return state.sourceValue === sourceValue
    ? state
    : createHttpProxyCaPathDraftState(httpProxyCaPath)
}

export function updateHttpProxyCaPathDraftState(
  state: HttpProxyCaPathDraftState,
  httpProxyCaPath: string | undefined,
  draft: string
): HttpProxyCaPathDraftState {
  return {
    ...resolveHttpProxyCaPathDraftState(state, httpProxyCaPath),
    draft,
    error: null
  }
}

export function setHttpProxyCaPathDraftErrorState(
  state: HttpProxyCaPathDraftState,
  httpProxyCaPath: string | undefined,
  error: string
): HttpProxyCaPathDraftState {
  return {
    ...resolveHttpProxyCaPathDraftState(state, httpProxyCaPath),
    error
  }
}

export type HttpProxyBypassRulesDraftState = {
  sourceValue: string
  draft: string
}

export function createHttpProxyBypassRulesDraftState(
  httpProxyBypassRules: string | undefined
): HttpProxyBypassRulesDraftState {
  const sourceValue = httpProxyBypassRules ?? ''
  return {
    sourceValue,
    draft: sourceValue
  }
}

export function resolveHttpProxyBypassRulesDraftState(
  state: HttpProxyBypassRulesDraftState,
  httpProxyBypassRules: string | undefined
): HttpProxyBypassRulesDraftState {
  const sourceValue = httpProxyBypassRules ?? ''
  return state.sourceValue === sourceValue
    ? state
    : createHttpProxyBypassRulesDraftState(httpProxyBypassRules)
}

export function updateHttpProxyBypassRulesDraftState(
  state: HttpProxyBypassRulesDraftState,
  httpProxyBypassRules: string | undefined,
  draft: string
): HttpProxyBypassRulesDraftState {
  return {
    ...resolveHttpProxyBypassRulesDraftState(state, httpProxyBypassRules),
    draft
  }
}
