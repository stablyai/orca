import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, LoaderCircle, Unlink } from 'lucide-react'
import { JiraIcon } from '@/components/icons/JiraIcon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import type { JiraSite } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'

type JiraFormMode =
  | { kind: 'add' }
  | {
      kind: 'update'
      site: JiraSite
    }

type JiraTestResult = { state: 'ok' | 'error'; error?: string }

function getJiraSiteLabel(site: JiraSite): string {
  return `${site.displayName} · ${site.email}`
}

export function JiraIntegrationCard(): React.JSX.Element {
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const connectJira = useAppStore((s) => s.connectJira)
  const disconnectJira = useAppStore((s) => s.disconnectJira)
  const testJiraConnection = useAppStore((s) => s.testJiraConnection)
  const mountedRef = useMountedRef()

  const [formMode, setFormMode] = useState<JiraFormMode | null>(null)
  const [siteUrlDraft, setSiteUrlDraft] = useState('')
  const [emailDraft, setEmailDraft] = useState('')
  const [apiTokenDraft, setApiTokenDraft] = useState('')
  const [connectState, setConnectState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)
  const [testingSiteId, setTestingSiteId] = useState<string | null>(null)
  const [testResultBySite, setTestResultBySite] = useState<Record<string, JiraTestResult>>({})

  const jiraSites = jiraStatus.sites ?? []

  useEffect(() => {
    void checkJiraConnection()
  }, [checkJiraConnection])

  const openAddForm = (): void => {
    setFormMode({ kind: 'add' })
    setSiteUrlDraft('')
    setEmailDraft('')
    setApiTokenDraft('')
    setConnectState('idle')
    setConnectError(null)
  }

  const openUpdateForm = (site: JiraSite): void => {
    setFormMode({ kind: 'update', site })
    setSiteUrlDraft(site.siteUrl)
    setEmailDraft(site.email)
    setApiTokenDraft('')
    setConnectState('idle')
    setConnectError(null)
  }

  const closeForm = (): void => {
    if (connectState === 'connecting') {
      return
    }
    setFormMode(null)
    setConnectError(null)
    setConnectState('idle')
  }

  const handleConnect = async (): Promise<void> => {
    const siteUrl = siteUrlDraft.trim()
    const email = emailDraft.trim()
    const apiToken = apiTokenDraft.trim()
    if (!siteUrl || !email || !apiToken) {
      return
    }
    setConnectState('connecting')
    setConnectError(null)
    const result = await connectJira({ siteUrl, email, apiToken })
    if (!mountedRef.current) {
      return
    }
    if (result.ok) {
      setFormMode(null)
      setSiteUrlDraft('')
      setEmailDraft('')
      setApiTokenDraft('')
      setConnectState('idle')
      setTestResultBySite({})
      return
    }
    setConnectState('error')
    setConnectError(result.error)
  }

  const handleTest = async (siteId: string): Promise<void> => {
    setTestingSiteId(siteId)
    setTestResultBySite((prev) => {
      const next = { ...prev }
      delete next[siteId]
      return next
    })
    const result = await testJiraConnection(siteId)
    if (!mountedRef.current) {
      return
    }
    setTestResultBySite((prev) => ({
      ...prev,
      [siteId]: result.ok ? { state: 'ok' } : { state: 'error', error: result.error }
    }))
    setTestingSiteId(null)
  }

  const handleDisconnect = async (siteId: string): Promise<void> => {
    await disconnectJira(siteId)
    if (!mountedRef.current) {
      return
    }
    setTestResultBySite((prev) => {
      const next = { ...prev }
      delete next[siteId]
      return next
    })
  }

  return (
    <div className="rounded-md border border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <JiraIcon className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {translate('auto.components.settings.jira.integration.card.09742875cd', 'Jira')}
          </p>
          <p className="text-xs text-muted-foreground">
            {jiraStatus.connected
              ? translate(
                  'auto.components.settings.jira.integration.card.74f3063026',
                  '{{value0}} site{{value1}} connected',
                  { value0: jiraSites.length, value1: jiraSites.length === 1 ? '' : 's' }
                )
              : translate(
                  'auto.components.settings.jira.integration.card.9a9f8d4910',
                  'Connect Jira Cloud to browse, create, and link issues.'
                )}
          </p>
        </div>
        {jiraStatus.connected ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={openAddForm}>
              {translate('auto.components.settings.jira.integration.card.efaab83c5d', 'Add site')}
            </Button>
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.settings.jira.integration.card.9bb34706ca', 'Connected')}
            </span>
          </div>
        ) : (
          <button
            className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={openAddForm}
          >
            {translate('auto.components.settings.jira.integration.card.a28f417220', 'Connect Jira')}
          </button>
        )}
      </div>

      {formMode ? (
        <div className="mt-3 rounded-md border border-border/30 bg-background/50 px-3 py-2.5">
          <div className="grid gap-2 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
            <Input
              placeholder={translate(
                'auto.components.settings.jira.integration.card.27dae4ab60',
                'https://example.atlassian.net'
              )}
              value={siteUrlDraft}
              onChange={(e) => {
                setSiteUrlDraft(e.target.value)
                setConnectError(null)
                setConnectState('idle')
              }}
              disabled={connectState === 'connecting'}
            />
            <Input
              type="email"
              placeholder={translate(
                'auto.components.settings.jira.integration.card.09d310e42d',
                'you@example.com'
              )}
              value={emailDraft}
              onChange={(e) => {
                setEmailDraft(e.target.value)
                setConnectError(null)
                setConnectState('idle')
              }}
              disabled={connectState === 'connecting'}
            />
            <Input
              className="md:col-span-2"
              type="password"
              placeholder={translate(
                'auto.components.settings.jira.integration.card.1ab7f551f3',
                'Atlassian API token'
              )}
              value={apiTokenDraft}
              onChange={(e) => {
                setApiTokenDraft(e.target.value)
                setConnectError(null)
                setConnectState('idle')
              }}
              disabled={connectState === 'connecting'}
            />
          </div>
          {connectState === 'error' && connectError ? (
            <p className="mt-2 text-xs text-destructive">{connectError}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() =>
                window.api.shell.openUrl(
                  'https://id.atlassian.com/manage-profile/security/api-tokens'
                )
              }
            >
              <ExternalLink className="size-3.5" />
              {translate(
                'auto.components.settings.jira.integration.card.1666f8d562',
                'Create an Atlassian API token'
              )}
            </button>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={closeForm}
                disabled={connectState === 'connecting'}
              >
                {translate('auto.components.settings.jira.integration.card.5936977fcd', 'Cancel')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleConnect()}
                disabled={
                  !siteUrlDraft.trim() ||
                  !emailDraft.trim() ||
                  !apiTokenDraft.trim() ||
                  connectState === 'connecting'
                }
              >
                {connectState === 'connecting' ? (
                  <>
                    <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                    {translate(
                      'auto.components.settings.jira.integration.card.d914d7ab70',
                      'Verifying…'
                    )}
                  </>
                ) : formMode.kind === 'update' ? (
                  translate(
                    'auto.components.settings.jira.integration.card.33a8b261ee',
                    'Update credentials'
                  )
                ) : (
                  translate('auto.components.settings.jira.integration.card.2e8bb790fd', 'Connect')
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {jiraStatus.connected ? (
        <div className="mt-3 space-y-2">
          {jiraSites.map((site) => {
            const testResult = testResultBySite[site.id]
            const testing = testingSiteId === site.id
            return (
              <div
                key={site.id}
                className="flex items-center gap-3 rounded-md border border-border/50 bg-background/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {getJiraSiteLabel(site)}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{site.siteUrl}</p>
                </div>
                {testResult?.state === 'ok' ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" />
                    {translate(
                      'auto.components.settings.jira.integration.card.ab350991b8',
                      'Verified'
                    )}
                  </span>
                ) : null}
                {testResult?.state === 'error' ? (
                  <span className="flex min-w-0 max-w-[220px] shrink items-center gap-1 truncate text-xs text-destructive">
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span className="truncate">{testResult.error}</span>
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleTest(site.id)}
                  disabled={testing}
                >
                  {testing ? (
                    <>
                      <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                      {translate(
                        'auto.components.settings.jira.integration.card.cec06a0f79',
                        'Testing…'
                      )}
                    </>
                  ) : (
                    translate('auto.components.settings.jira.integration.card.255bfe98ec', 'Test')
                  )}
                </Button>
                <Button variant="outline" size="sm" onClick={() => openUpdateForm(site)}>
                  {translate('auto.components.settings.jira.integration.card.eaffa454e9', 'Update')}
                </Button>
                <button
                  onClick={() => void handleDisconnect(site.id)}
                  aria-label={translate(
                    'auto.components.settings.jira.integration.card.9046a20d4c',
                    'Disconnect {{value0}}',
                    { value0: getJiraSiteLabel(site) }
                  )}
                  className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
                >
                  <Unlink className="size-3.5" />
                </button>
              </div>
            )
          })}
          <p className="text-[11px] text-muted-foreground/70">
            {translate(
              'auto.components.settings.jira.integration.card.8ff73fef62',
              "Jira tokens are encrypted by the active runtime and stored locally. Re-entering the same site URL and email replaces that site's API token."
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
