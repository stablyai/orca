export type D2RenderRequest = {
  source: string
  isDark: boolean
}

export type D2RenderResult =
  | { ok: true; svg: string }
  | { ok: false; reason: 'missing' }
  // Why: web and mobile clients have no local main process to run d2.
  | { ok: false; reason: 'unavailable' }
  | { ok: false; reason: 'error'; message: string }
