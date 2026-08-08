import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AgentSubagentContext,
  type AgentSubagentSource,
  type AgentSubagentSourceData
} from './AgentSubagentContext'
import { AgentSubagentSheet } from './AgentSubagentSheet'
import { useAgentSubagentSessions } from './use-agent-subagent-sessions'

export type { AgentSubagentSource } from './AgentSubagentContext'

export function AgentSubagentProvider({
  sources,
  children
}: {
  sources: readonly AgentSubagentSource[]
  children: React.ReactNode
}): React.JSX.Element {
  const [loadedBySource, setLoadedBySource] = useState<
    Record<string, Omit<AgentSubagentSourceData, 'source'>>
  >({})
  const [openSourceKey, setOpenSourceKey] = useState<string | null>(null)
  const update = useCallback(
    (key: string, data: Omit<AgentSubagentSourceData, 'source'>) =>
      setLoadedBySource((current) =>
        current[key] === data ? current : { ...current, [key]: data }
      ),
    []
  )
  const dataBySource = useMemo(
    () =>
      Object.fromEntries(
        sources.map((source) => [
          source.key,
          {
            source,
            loading: loadedBySource[source.key]?.loading ?? false,
            sessions: loadedBySource[source.key]?.sessions ?? []
          }
        ])
      ) as Record<string, AgentSubagentSourceData>,
    [loadedBySource, sources]
  )
  const value = useMemo(
    () => ({ dataBySource, open: (sourceKey: string) => setOpenSourceKey(sourceKey) }),
    [dataBySource]
  )
  return (
    <AgentSubagentContext.Provider value={value}>
      {sources.map((source) => (
        <SourceLoader key={source.key} source={source} onChange={update} />
      ))}
      {children}
      <AgentSubagentSheet
        key={openSourceKey ?? 'closed'}
        open={openSourceKey !== null}
        data={openSourceKey ? (dataBySource[openSourceKey] ?? null) : null}
        onOpenChange={(open) => !open && setOpenSourceKey(null)}
      />
    </AgentSubagentContext.Provider>
  )
}

function SourceLoader({
  source,
  onChange
}: {
  source: AgentSubagentSource
  onChange: (key: string, data: Omit<AgentSubagentSourceData, 'source'>) => void
}): null {
  const data = useAgentSubagentSessions({
    target: source.target,
    agent: source.agent,
    parentFilePath: source.transcriptPath,
    liveSubagents: source.liveSubagents
  })
  useEffect(() => onChange(source.key, data), [data, onChange, source.key])
  return null
}
