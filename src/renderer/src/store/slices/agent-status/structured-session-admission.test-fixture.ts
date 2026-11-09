import type { admitStructuredAgentSession } from '@/lib/agent-session/structured-agent-session-busy'

export function admissionFromBusy(busy: () => boolean): typeof admitStructuredAgentSession {
  return (_workspace, _tab, _intent, effect) => {
    void effect(busy(), {
      current: () => true,
      busy,
      signal: new AbortController().signal
    })
    return Promise.resolve()
  }
}
