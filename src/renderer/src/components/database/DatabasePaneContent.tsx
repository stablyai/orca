import {
  useDatabaseOperationGuard,
  assertDatabaseOperationCurrent
} from './useDatabaseOperationGuard'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Tab } from '../../../../shared/tab-types'
import {
  DEFAULT_DATABASE_TAB_STATE,
  type DatabaseConnectionConfig,
  type DatabaseConnectionRequest,
  type DatabaseProfileSummary,
  type DatabaseSchemaResult
} from '../../../../shared/database-types'
import { useAppStore } from '@/store'

import {
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
import { useDatabaseQuery, DATABASE_QUERY_ROW_LIMIT } from './useDatabaseQuery'
import { DatabaseQueryToolbar } from './DatabaseQueryToolbar'
import { DATABASE_FOCUS_EVENT } from './database-tab-actions'
import { translate } from '@/i18n/i18n'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function DatabasePaneContent({
  tab,
  runtimeEnvironmentId,
  sshConnectionId,
  isActive = true
}: {
  tab: Tab
  runtimeEnvironmentId: string | null
  sshConnectionId: string | null
  isActive?: boolean
}): React.JSX.Element {
  useTranslation()
  const database = tab.database ?? DEFAULT_DATABASE_TAB_STATE
  const setDatabaseTabState = useAppStore((state) => state.setDatabaseTabState)
  const nodeIdentity = `${tab.worktreeId}:${runtimeEnvironmentId ?? 'local'}:${sshConnectionId ?? 'local'}`
  const beginOperation = useDatabaseOperationGuard(nodeIdentity)
  const [connectedOwner, setConnectedOwner] = useState<string | null>(null)
  const [password, setPassword] = useState(() => getDatabaseTabPassword(tab.id, nodeIdentity))
  const connected = connectedOwner === nodeIdentity
  const [showConnection, setShowConnection] = useState(true)
  const [schema, setSchema] = useState<DatabaseSchemaResult | null>(null)
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadDatabaseCatalog>> | null>(
    null
  )
  const [pendingConnection, setPendingConnection] = useState(false)
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
    nodeIdentity,
    database,
    updateDatabase,
    clearPassword
  })
  const ownerLabel = getOwnerLabel(runtimeEnvironmentId, sshConnectionId)

  const request = useMemo(
    () => createConnectionRequest(database.connection, database.profileId, password),
    [database.connection, database.profileId, password]
  )

  const contextKey = JSON.stringify([
    tab.worktreeId,
    runtimeEnvironmentId,
    sshConnectionId,
    database.profileId,
    database.connection
  ])
  const query = useDatabaseQuery({
    worktreeId: tab.worktreeId,
    request,
    contextKey,
    queryDraft: database.queryDraft,
    readOnly: database.readOnly,
    enabled: connected && !showConnection && !pendingConnection,
    isActive
  })
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!isActive) {
      return
    }
    const focus = (): void => {
      const element = showConnection ? rootRef.current?.querySelector('input') : queryRef.current
      element?.focus({ preventScroll: true })
    }
    const handleFocus = (event: Event): void => {
      if ((event as CustomEvent<{ tabId: string }>).detail?.tabId === tab.id) {
        focus()
      }
    }
    const frame = requestAnimationFrame(focus)
    window.addEventListener(DATABASE_FOCUS_EVENT, handleFocus)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener(DATABASE_FOCUS_EVENT, handleFocus)
    }
  }, [isActive, showConnection, tab.id])

  const loadConnectionContext = async (
    profile: DatabaseProfileSummary,
    connection: DatabaseConnectionConfig
  ): Promise<void> => {
    const isCurrent = beginOperation()
    const initialRequest = createConnectionRequest(connection, profile.id, password)
    await testDatabaseConnection(tab.worktreeId, initialRequest)
    assertDatabaseOperationCurrent(isCurrent)
    const nextCatalog = await loadDatabaseCatalog(tab.worktreeId, initialRequest)
    assertDatabaseOperationCurrent(isCurrent)
    const selectedConnection = withSchema(
      connection,
      connection.schema ?? nextCatalog.currentSchema ?? undefined
    )
    const persistedProfile = await profiles.persistProfileConnection(profile, selectedConnection)
    assertDatabaseOperationCurrent(isCurrent)
    const selectedRequest = createConnectionRequest(
      persistedProfile.connection,
      persistedProfile.id,
      password
    )
    const nextSchema = await introspectDatabase(tab.worktreeId, selectedRequest)
    assertDatabaseOperationCurrent(isCurrent)
    setCatalog(nextCatalog)
    setSchema(nextSchema)
    query.reset()
    setConnectedOwner(nodeIdentity)
    setShowConnection(false)
    useAppStore.getState().setTabLabel(tab.id, persistedProfile.name)
  }

  const connect = async (): Promise<void> => {
    const isCurrent = beginOperation()
    setPendingConnection(true)
    setError(null)
    try {
      const saved = await profiles.saveProfile(password)
      assertDatabaseOperationCurrent(isCurrent)
      await loadConnectionContext(saved, saved.connection)
      assertDatabaseOperationCurrent(isCurrent)
      if (profiles.rememberPassword) {
        clearPassword()
      }
    } catch (caught) {
      if (!isCurrent()) {
        return
      }
      setConnectedOwner(null)
      setError(errorMessage(caught))
    } finally {
      if (isCurrent()) {
        setPendingConnection(false)
      }
    }
  }

  const changeDatabase = async (databaseName: string): Promise<void> => {
    const profile = profiles.profiles.find((candidate) => candidate.id === database.profileId)
    if (!profile || databaseName === database.connection.database) {
      return
    }
    const isCurrent = beginOperation()
    setPendingConnection(true)
    setError(null)
    try {
      await loadConnectionContext(
        profile,
        withSchema({ ...database.connection, database: databaseName })
      )
    } catch (caught) {
      if (!isCurrent()) {
        return
      }
      setError(errorMessage(caught))
    } finally {
      if (isCurrent()) {
        setPendingConnection(false)
      }
    }
  }

  const changeSchema = async (schemaName?: string): Promise<void> => {
    const profile = profiles.profiles.find((candidate) => candidate.id === database.profileId)
    if (!profile || schemaName === database.connection.schema) {
      return
    }
    const isCurrent = beginOperation()
    setPendingConnection(true)
    setError(null)
    try {
      const nextConnection = withSchema(database.connection, schemaName)
      const saved = await profiles.persistProfileConnection(profile, nextConnection)
      assertDatabaseOperationCurrent(isCurrent)
      const nextSchema = await introspectDatabase(
        tab.worktreeId,
        createConnectionRequest(saved.connection, saved.id, password)
      )
      assertDatabaseOperationCurrent(isCurrent)
      setSchema(nextSchema)
      query.reset()
    } catch (caught) {
      if (!isCurrent()) {
        return
      }
      setError(errorMessage(caught))
    } finally {
      if (isCurrent()) {
        setPendingConnection(false)
      }
    }
  }

  if (showConnection || !connected) {
    return (
      <div ref={rootRef} className="scrollbar-sleek flex h-full overflow-auto bg-background p-5">
        <div className="m-auto w-full space-y-3">
          <DatabaseConnectionForm
            connection={database.connection}
            idPrefix={`database-${tab.id}`}
            password={password}
            pending={pendingConnection || query.running}
            profiles={profiles.profiles}
            selectedProfileId={database.profileId}
            profileName={profiles.profileName}
            rememberPassword={profiles.rememberPassword}
            selectedProfileHasPassword={profiles.selectedProfileHasPassword}
            onChange={(connection) => updateDatabase({ connection })}
            onPasswordChange={(nextPassword) => {
              setPassword(nextPassword)
              setDatabaseTabPassword(tab.id, nextPassword, nodeIdentity)
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
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-background"
      data-database-tab-id={tab.id}
    >
      <DatabaseContextToolbar
        connection={database.connection}
        catalog={catalog}
        ownerLabel={ownerLabel}
        readOnly={database.readOnly}
        pending={pendingConnection || query.running}
        onDatabaseChange={(value) => void changeDatabase(value)}
        onSchemaChange={(value) => void changeSchema(value)}
        onReadOnlyChange={(readOnly) => updateDatabase({ readOnly })}
        onEditConnection={() => setShowConnection(true)}
      />
      {(error ?? query.error) ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error ?? query.error}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-card md:block">
          <DatabaseSchemaTree
            schema={schema}
            disabled={query.running || pendingConnection}
            onSelectTable={(schemaName, tableName) => {
              if (query.running) {
                return
              }
              const identifier = `"${schemaName.replaceAll('"', '""')}"."${tableName.replaceAll('"', '""')}"`
              const sql = `SELECT * FROM ${identifier}\nLIMIT ${DATABASE_QUERY_ROW_LIMIT};`
              updateDatabase({ queryDraft: sql, readOnly: true })
              void query.run(sql, true)
              requestAnimationFrame(() => queryRef.current?.focus())
            }}
          />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <DatabaseQueryToolbar query={query} />
          <textarea
            ref={queryRef}
            value={database.queryDraft}
            onChange={(event) => updateDatabase({ queryDraft: event.target.value })}
            onKeyDown={(event) => {
              const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
              if (modifier && event.key === 'Enter') {
                event.preventDefault()
                void query.run()
              }
            }}
            spellCheck={false}
            aria-label={translate('auto.components.database.editor.label', 'SQL query')}
            className="h-44 shrink-0 resize-y border-0 border-b border-border bg-editor-surface p-3 font-mono text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
          <div className="min-h-0 flex-1">
            <DatabaseResults result={query.result} />
          </div>
        </main>
      </div>
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
