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
  const [openTarget, setOpenTarget] = useState<{ sourceKey?: string; sessionId?: string } | null>(
    null
  )
  const [sheetOpen, setSheetOpen] = useState(false)
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
      ),
    [loadedBySource, sources]
  )
  const value = useMemo(
    () => ({
      dataBySource,
      open: (sourceKey?: string, sessionId?: string) => {
        setOpenTarget({ sourceKey, sessionId })
        setSheetOpen(true)
      }
    }),
    [dataBySource]
  )
  const openData = openTarget?.sourceKey
    ? [dataBySource[openTarget.sourceKey]].filter(Boolean)
    : Object.values(dataBySource)
  const initialSource = openTarget?.sourceKey ? dataBySource[openTarget.sourceKey] : null
  const initialSession = openTarget?.sessionId
    ? (initialSource?.sessions.find((session) => session.sessionId === openTarget.sessionId) ??
      null)
    : null
  return (
    <AgentSubagentContext.Provider value={value}>
      {sources.map((source) => (
        <SourceLoader
          key={source.key}
          source={source}
          onChange={update}
          poll={sheetOpen && (!openTarget?.sourceKey || openTarget.sourceKey === source.key)}
        />
      ))}
      {children}
      <AgentSubagentSheet
        key={`${openTarget?.sourceKey ?? 'all'}:${openTarget?.sessionId ?? 'list'}`}
        open={sheetOpen}
        data={openData}
        initialSelection={
          initialSource && initialSession
            ? { sourceData: initialSource, session: initialSession }
            : null
        }
        onOpenChange={setSheetOpen}
      />
    </AgentSubagentContext.Provider>
  )
}

function SourceLoader({
  source,
  poll,
  onChange
}: {
  source: AgentSubagentSource
  poll: boolean
  onChange: (key: string, data: Omit<AgentSubagentSourceData, 'source'>) => void
}): null {
  const data = useAgentSubagentSessions({
    target: source.target,
    agent: source.agent,
    parentFilePath: source.structuredSessionId ? null : source.transcriptPath,
    parentSessionId: source.sessionId,
    structuredSessionId: source.structuredSessionId,
    liveSubagents: source.liveSubagents,
    poll: source.working || poll
  })
  useEffect(() => onChange(source.key, data), [data, onChange, source.key])
  return null
}
