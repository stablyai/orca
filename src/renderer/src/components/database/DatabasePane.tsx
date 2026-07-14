import { useMemo, useRef, useState } from 'react'
import { Loader2, Play, Square } from 'lucide-react'
import type { Tab } from '../../../../shared/types'
import {
  DEFAULT_DATABASE_TAB_STATE,
  type DatabaseConnectionConfig,
  type DatabaseConnectionRequest,
  type DatabaseProfileSummary,
  type DatabaseQueryResult,
  type DatabaseSchemaResult
} from '../../../../shared/database-types'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import {
  getRuntimeEnvironmentIdForWorktree,
  getSshConnectionIdForWorktree
} from '@/lib/worktree-runtime-owner'
import {
  cancelDatabaseQuery,
  executeDatabaseQuery,
  introspectDatabase,
  loadDatabaseCatalog,
  testDatabaseConnection
} from '@/runtime/runtime-database-client'
import { getDatabaseTabPassword, setDatabaseTabPassword } from './database-tab-credentials'
import { DatabaseConnectionForm } from './DatabaseConnectionForm'
import { DatabaseContextToolbar } from './DatabaseContextToolbar'
import { DatabaseResults } from './DatabaseResults'
import { DatabaseSchemaTree } from './DatabaseSchemaTree'
import { useDatabaseProfiles } from './useDatabaseProfiles'
import { translate } from '@/i18n/i18n'

const QUERY_ROW_LIMIT = 500
const QUERY_TIMEOUT_MS = 30_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function DatabasePane({ tab }: { tab: Tab }): React.JSX.Element {
  const database = tab.database ?? DEFAULT_DATABASE_TAB_STATE
  const setDatabaseTabState = useAppStore((state) => state.setDatabaseTabState)
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const sshConnectionId = useAppStore((state) =>
    getSshConnectionIdForWorktree(state, tab.worktreeId)
  )
  const [password, setPassword] = useState(() => getDatabaseTabPassword(tab.id))
  const [connected, setConnected] = useState(false)
  const [showConnection, setShowConnection] = useState(true)
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null)
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadDatabaseCatalog>> | null>(
    null
  )
  const [result, setResult] = useState<DatabaseQueryResult | null>(null)
  const [pendingConnection, setPendingConnection] = useState(false)
  const [runningQueryId, setRunningQueryId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queryRef = useRef<HTMLTextAreaElement>(null)

  const updateDatabase = (patch: Partial<typeof database>): void => {
    const current = useAppStore.getState().getTab(tab.id)?.database ?? database
    setDatabaseTabState(tab.id, { ...current, ...patch })
  }
  const clearPassword = (): void => {
    setPassword('')
    setDatabaseTabPassword(tab.id, '')
  }
  const profiles = useDatabaseProfiles({
    worktreeId: tab.worktreeId,
    nodeIdentity: `${runtimeEnvironmentId ?? 'local'}:${sshConnectionId ?? 'local'}`,
    database,
    updateDatabase,
    clearPassword
  })
  const ownerLabel = getOwnerLabel(runtimeEnvironmentId, sshConnectionId)

  const request = useMemo(
    () => createConnectionRequest(database.connection, database.profileId, password),
    [database.connection, database.profileId, password]
  )

  const loadConnectionContext = async (
    profile: DatabaseProfileSummary,
    connection: DatabaseConnectionConfig
  ): Promise<void> => {
    const initialRequest = createConnectionRequest(connection, profile.id, password)
    await testDatabaseConnection(tab.worktreeId, initialRequest)
    const nextCatalog = await loadDatabaseCatalog(tab.worktreeId, initialRequest)
    const selectedConnection = withSchema(
      connection,
      connection.schema ?? nextCatalog.currentSchema ?? undefined
    )
    const persistedProfile = await profiles.persistProfileConnection(profile, selectedConnection)
    const selectedRequest = createConnectionRequest(
      persistedProfile.connection,
      persistedProfile.id,
      password
    )
    const nextSchema = await introspectDatabase(tab.worktreeId, selectedRequest)
    setCatalog(nextCatalog)
    setSchema(nextSchema)
    setConnected(true)
    setShowConnection(false)
  }

  const connect = async (): Promise<void> => {
    setPendingConnection(true)
    setError(null)
    try {
      const saved = await profiles.saveProfile(password)
      await loadConnectionContext(saved, saved.connection)
      if (profiles.rememberPassword) {
        clearPassword()
      }
    } catch (caught) {
      setConnected(false)
      setError(errorMessage(caught))
    } finally {
      setPendingConnection(false)
    }
  }

  const changeDatabase = async (databaseName: string): Promise<void> => {
    const profile = profiles.profiles.find((candidate) => candidate.id === database.profileId)
    if (!profile || databaseName === database.connection.database) {
      return
    }
    setPendingConnection(true)
    setError(null)
    try {
      await loadConnectionContext(
        profile,
        withSchema({ ...database.connection, database: databaseName })
      )
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPendingConnection(false)
    }
  }

  const changeSchema = async (schemaName?: string): Promise<void> => {
    const profile = profiles.profiles.find((candidate) => candidate.id === database.profileId)
    if (!profile || schemaName === database.connection.schema) {
      return
    }
    setPendingConnection(true)
    setError(null)
    try {
      const nextConnection = withSchema(database.connection, schemaName)
      const saved = await profiles.persistProfileConnection(profile, nextConnection)
      const nextSchema = await introspectDatabase(
        tab.worktreeId,
        createConnectionRequest(saved.connection, saved.id, password)
      )
      setSchema(nextSchema)
    } catch (caught) {
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
      setResult(
        await executeDatabaseQuery(tab.worktreeId, {
          ...request,
          queryId,
          sql,
          readOnly: database.readOnly,
          maxRows: QUERY_ROW_LIMIT,
          timeoutMs: QUERY_TIMEOUT_MS
        })
      )
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
            profiles={profiles.profiles}
            selectedProfileId={database.profileId}
            profileName={profiles.profileName}
            rememberPassword={profiles.rememberPassword}
            selectedProfileHasPassword={profiles.selectedProfileHasPassword}
            onChange={(connection) => updateDatabase({ connection })}
            onPasswordChange={(nextPassword) => {
              setPassword(nextPassword)
              setDatabaseTabPassword(tab.id, nextPassword)
            }}
            onProfileSelect={profiles.selectProfile}
            onProfileNameChange={profiles.setProfileName}
            onRememberPasswordChange={profiles.setRememberPassword}
            onDeleteProfile={() => {
              setError(null)
              void profiles
                .deleteProfile()
                .catch((caught: unknown) => setError(errorMessage(caught)))
            }}
            onConnect={() => void connect()}
          />
          {(error ?? profiles.profileError) ? (
            <div className="mx-auto max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error ?? profiles.profileError}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <DatabaseContextToolbar
        connection={database.connection}
        catalog={catalog}
        ownerLabel={ownerLabel}
        readOnly={database.readOnly}
        pending={pendingConnection}
        onDatabaseChange={(value) => void changeDatabase(value)}
        onSchemaChange={(value) => void changeSchema(value)}
        onReadOnlyChange={(readOnly) => updateDatabase({ readOnly })}
        onEditConnection={() => setShowConnection(true)}
      />
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
          <QueryToolbar
            running={Boolean(runningQueryId)}
            result={result}
            onRun={() => void runQuery()}
            onCancel={() => void cancelQuery()}
          />
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

function QueryToolbar(props: {
  running: boolean
  result: DatabaseQueryResult | null
  onRun: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
      {props.running ? (
        <Button variant="outline" size="xs" onClick={props.onCancel}>
          <Square className="fill-current" />
          {translate('auto.components.database.toolbar.cancel', 'Cancel')}
        </Button>
      ) : (
        <Button size="xs" onClick={props.onRun}>
          <Play className="fill-current" />
          {translate('auto.components.database.toolbar.run', 'Run')}
        </Button>
      )}
      {props.running ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
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
      {props.result ? (
        <span className="ml-auto text-[11px] text-muted-foreground">
          {translate(
            'auto.components.database.toolbar.resultSummary',
            '{{value0}} rows{{value1}} · {{value2}} ms',
            {
              value0: props.result.rows.length,
              value1: props.result.truncated ? '+' : '',
              value2: props.result.durationMs
            }
          )}
        </span>
      ) : null}
    </div>
  )
}

function createConnectionRequest(
  connection: DatabaseConnectionConfig,
  profileId: string | undefined,
  password: string
): DatabaseConnectionRequest {
  return {
    ...(profileId ? { profileId } : {}),
    connection,
    credential: password ? { password } : {}
  }
}

function withSchema(
  connection: DatabaseConnectionConfig,
  schema?: string
): DatabaseConnectionConfig {
  const { schema: _ignored, ...withoutSchema } = connection
  return { ...withoutSchema, ...(schema ? { schema } : {}) }
}

function getOwnerLabel(
  runtimeEnvironmentId: string | null,
  sshConnectionId: string | null
): string {
  if (sshConnectionId) {
    return runtimeEnvironmentId
      ? translate(
          'auto.components.database.owner.runtimeSsh',
          'Runtime: {{value0}} → SSH: {{value1}}',
          {
            value0: runtimeEnvironmentId,
            value1: sshConnectionId
          }
        )
      : translate('auto.components.database.owner.ssh', 'SSH: {{value0}}', {
          value0: sshConnectionId
        })
  }
  return runtimeEnvironmentId
    ? translate('auto.components.database.owner.runtime', 'Runtime: {{value0}}', {
        value0: runtimeEnvironmentId
      })
    : translate('auto.components.database.owner.local', 'Local desktop')
}
