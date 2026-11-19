// Generating avatar options with a local image-capable agent; the run is canceled if the picker closes.
import { useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useAppStore } from '@/store'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability,
  AvatarGenerationFailure,
  AvatarImageAgent,
  AvatarImageAgentStatus
} from '../../../../shared/avatar-generation/avatar-generation-contract'
import { describesRealPerson } from '../../../../shared/avatar-generation/avatar-generation-prompt'
import { pickAvatarAgent } from '../../../../shared/avatar-generation/avatar-generation-agent-choice'

export type AvatarGenerationState =
  | { kind: 'idle' }
  | { kind: 'running'; agent: AvatarImageAgent; startedAt: number }
  /** `src` is a data URL. */
  | { kind: 'result'; src: string }
  | { kind: 'error'; failure: AvatarGenerationFailure; agent?: AvatarImageAgent }

function generationApi(): AvatarGenerationApi | null {
  // Desktop only: a paired web or phone client has no local agents to run.
  return isWebClientLocation() ? null : (window.api?.avatarGeneration ?? null)
}

function rememberAgent(agent: AvatarImageAgent): void {
  const { settings, updateSettings } = useAppStore.getState()
  if (settings && settings.avatarGenerationAgent !== agent) {
    void updateSettings({ avatarGenerationAgent: agent })
  }
}

export function useAvatarGeneration(): {
  agents: AvatarImageAgentStatus[]
  /** null while no capable agent was found. */
  agent: AvatarImageAgent | null
  selectAgent: (agent: AvatarImageAgent) => void
  state: AvatarGenerationState
  /** `backgroundColor` is the picker's chosen tile color, when one is set. */
  generate: (description: string, backgroundColor?: string) => void
  cancel: () => void
  reset: () => void
} {
  const [agents, setAgents] = useState<AvatarImageAgentStatus[]>([])
  const remembered = useAppStore((store) => store.settings?.avatarGenerationAgent)
  const [chosen, setChosen] = useState<AvatarImageAgent | null>(null)
  const agent = pickAvatarAgent(agents, chosen ?? remembered)
  const [state, setState] = useState<AvatarGenerationState>({ kind: 'idle' })
  const current = useRef<string | null>(null)

  const setStatus = (target: AvatarImageAgent, status: AvatarImageAgentStatus['status']): void =>
    setAgents((list) =>
      list.map((entry) => (entry.agent === target ? { agent: target, status } : entry))
    )

  useEffect(() => {
    const api = generationApi()
    if (!api) {
      return
    }
    let live = true
    void api.capability().then(
      (found: AvatarGenerationCapability | undefined) => {
        // A bridge without this namespace (web fallbacks) answers undefined: keep Generate hidden.
        if (live && Array.isArray(found?.agents)) {
          setAgents(found.agents)
        }
      },
      () => {}
    )
    return () => {
      live = false
      // An open run costs the user's usage; nobody is left to pick from it.
      if (current.current) {
        void api.cancel({ requestId: current.current }).catch(() => {})
        current.current = null
      }
    }
  }, [])

  const selectAgent = (next: AvatarImageAgent): void => {
    setChosen(next)
    rememberAgent(next)
    if (state.kind === 'error') {
      setState({ kind: 'idle' })
    }
  }

  const generate = (description: string, backgroundColor?: string): void => {
    const api = generationApi()
    const text = description.trim()
    if (!api || !text || !agent) {
      return
    }
    if (describesRealPerson(text)) {
      setState({ kind: 'error', failure: 'real-person' })
      return
    }
    if (current.current) {
      void api.cancel({ requestId: current.current }).catch(() => {})
    }
    const requestId = createNonSecureContextUuid()
    current.current = requestId
    rememberAgent(agent)
    setState({ kind: 'running', agent, startedAt: Date.now() })
    void api.generate({ requestId, description: text, agent, backgroundColor }).then(
      (result) => {
        if (current.current !== requestId) {
          return
        }
        current.current = null
        if (result.ok) {
          // A run that worked proves the agent ready, whatever an older probe said.
          setStatus(result.agent, 'ready')
          setState({
            kind: 'result',
            src: `data:${result.image.mimeType};base64,${result.image.base64}`
          })
        } else if (result.error === 'canceled') {
          setState({ kind: 'idle' })
        } else {
          if (result.error === 'signed-out') {
            setStatus(agent, 'signed-out')
          }
          setState({ kind: 'error', failure: result.error, agent })
        }
      },
      () => {
        if (current.current === requestId) {
          current.current = null
          setState({ kind: 'error', failure: 'failed', agent })
        }
      }
    )
  }

  const cancel = (): void => {
    const requestId = current.current
    current.current = null
    setState({ kind: 'idle' })
    if (requestId) {
      void generationApi()
        ?.cancel({ requestId })
        .catch(() => {})
    }
  }

  return {
    agents,
    agent,
    selectAgent,
    state,
    generate,
    cancel,
    reset: () => setState({ kind: 'idle' })
  }
}
