import { useMemo, useRef, useState } from 'react'
import { Database, Loader2, Play, Square } from 'lucide-react'
import type { Tab } from '../../../../shared/types'
import {
  DEFAULT_DATABASE_TAB_STATE,
  type DatabaseConnectionConfig,
  type DatabaseQueryResult,
  type DatabaseSchemaResult
} from '../../../../shared/database-types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  cancelDatabaseQuery,
  executeDatabaseQuery,
  introspectDatabase,
  testDatabaseConnection
} from '@/runtime/runtime-database-client'
import { getDatabaseTabPassword, setDatabaseTabPassword } from './database-tab-credentials'
import { DatabaseConnectionForm } from './DatabaseConnectionForm'
import { DatabaseResults } from './DatabaseResults'
import { DatabaseSchemaTree } from './DatabaseSchemaTree'
import { translate } from '@/i18n/i18n'

const QUERY_ROW_LIMIT = 500
const QUERY_TIMEOUT_MS = 30_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function connectionSummary(connection: DatabaseConnectionConfig): string {
  return `${connection.user}@${connection.host}:${connection.port}/${connection.database}`
}

export default function DatabasePane({ tab }: { tab: Tab }): React.JSX.Element {
  const database = tab.database ?? DEFAULT_DATABASE_TAB_STATE
  const setDatabaseTabState = useAppStore((state) => state.setDatabaseTabState)
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const [password, setPassword] = useState(() => getDatabaseTabPassword(tab.id))
  const [connected, setConnected] = useState(false)
  const [showConnection, setShowConnection] = useState(true)
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null)
  const [result, setResult] = useState<DatabaseQueryResult | null>(null)
  const [pendingConnection, setPendingConnection] = useState(false)
  const [runningQueryId, setRunningQueryId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryRef = useRef<HTMLTextAreaElement>(null)
  const ownerLabel = runtimeEnvironmentId
    ? translate('auto.components.database.owner.runtime', 'Runtime: {{value0}}', {
        value0: runtimeEnvironmentId
      })
    : translate('auto.components.database.owner.local', 'Local desktop')

  const request = useMemo(
    () => ({ connection: database.connection, credential: { password: password || undefined } }),
    [database.connection, password]
  )

  const updateDatabase = (patch: Partial<typeof database>): void => {
    setDatabaseTabState(tab.id, { ...database, ...patch })
  }

  const connect = async (): Promise<void> => {
    setPendingConnection(true)
    setError(null)
    try {
      await testDatabaseConnection(tab.worktreeId, request)
      const nextSchema = await introspectDatabase(tab.worktreeId, request)
      setSchema(nextSchema)
      setConnected(true)
      setShowConnection(false)
    } catch (caught) {
      setConnected(false)
      setError(errorMessage(caught))
    } finally {
      setPendingConnection(false)
    }
  }

  const runQuery = async (): Promise<void> => {
    const sql = database.queryDraft.trim()
    if (!sql || runningQueryId) {
      return
    }
    const queryId = crypto.randomUUID()
    setRunningQueryId(queryId)
    setError(null)
    try {
      const next = await executeDatabaseQuery(tab.worktreeId, {
        ...request,
        queryId,
        sql,
        readOnly: database.readOnly,
        maxRows: QUERY_ROW_LIMIT,
        timeoutMs: QUERY_TIMEOUT_MS
      })
      setResult(next)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setRunningQueryId(null)
    }
  }

  const cancelQuery = async (): Promise<void> => {
    if (!runningQueryId) {
      return
    }
    await cancelDatabaseQuery(tab.worktreeId, database.connection.providerId, runningQueryId).catch(
      () => false
    )
  }

  if (showConnection || !connected) {
    return (
      <div className="scrollbar-sleek flex h-full overflow-auto bg-background p-5">
        <div className="m-auto w-full space-y-3">
          <DatabaseConnectionForm
            connection={database.connection}
            idPrefix={`database-${tab.id}`}
            password={password}
            pending={pendingConnection}
            onChange={(connection) => updateDatabase({ connection })}
            onPasswordChange={(nextPassword) => {
              setPassword(nextPassword)
              setDatabaseTabPassword(tab.id, nextPassword)
            }}
            onConnect={() => void connect()}
          />
          {error ? (
            <div className="mx-auto max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-2 text-xs">
        <Database className="size-3.5" />
        <span className="min-w-0 truncate font-mono">{connectionSummary(database.connection)}</span>
        <span className="text-muted-foreground">· {ownerLabel}</span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <Checkbox
              checked={database.readOnly}
              onCheckedChange={(checked) => updateDatabase({ readOnly: checked === true })}
            />
            {translate('auto.components.database.toolbar.readOnly', 'Read only')}
          </label>
          <Button variant="ghost" size="xs" onClick={() => setShowConnection(true)}>
            {translate('auto.components.database.toolbar.editConnection', 'Edit connection')}
          </Button>
        </div>
      </div>
      {error ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-card md:block">
          <DatabaseSchemaTree
            schema={schema}
            onSelectTable={(schemaName, tableName) => {
              const identifier = `"${schemaName.replaceAll('"', '""')}"."${tableName.replaceAll('"', '""')}"`
              updateDatabase({ queryDraft: `SELECT * FROM ${identifier}\nLIMIT 100;` })
              requestAnimationFrame(() => queryRef.current?.focus())
            }}
          />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
            {runningQueryId ? (
              <Button variant="outline" size="xs" onClick={() => void cancelQuery()}>
                <Square className="fill-current" />
                {translate('auto.components.database.toolbar.cancel', 'Cancel')}
              </Button>
            ) : (
              <Button size="xs" onClick={() => void runQuery()}>
                <Play className="fill-current" />
                {translate('auto.components.database.toolbar.run', 'Run')}
              </Button>
            )}
            {runningQueryId ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.database.toolbar.shortcut',
                '{{value0}}Enter · {{value1}} row limit',
                {
                  value0: navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+',
                  value1: QUERY_ROW_LIMIT
                }
              )}
            </span>
            {result ? (
              <span className="ml-auto text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.database.toolbar.resultSummary',
                  '{{value0}} rows{{value1}} · {{value2}} ms',
                  {
                    value0: result.rows.length,
                    value1: result.truncated ? '+' : '',
                    value2: result.durationMs
                  }
                )}
              </span>
            ) : null}
          </div>
          <textarea
            ref={queryRef}
            value={database.queryDraft}
            onChange={(event) => updateDatabase({ queryDraft: event.target.value })}
            onKeyDown={(event) => {
              const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
              if (modifier && event.key === 'Enter') {
                event.preventDefault()
                void runQuery()
              }
            }}
            spellCheck={false}
            aria-label={translate('auto.components.database.editor.label', 'SQL query')}
            className="h-44 shrink-0 resize-y border-0 border-b border-border bg-editor-surface p-3 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
          <div className="min-h-0 flex-1">
            <DatabaseResults result={result} />
          </div>
        </main>
      </div>
    </div>
  )
}
