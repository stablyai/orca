import { useState } from 'react'
import { Info, Sparkles } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSecretScope } from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import { cloudSecretScopeLabel } from './cloud-secrets-copy'
import { CloudSecretList, type CloudSecretPeople } from './CloudSecretList'
import { CloudSecretsEffectiveView } from './CloudSecretsEffectiveView'
import {
  useCloudSecretList,
  useCloudSecretsEffective,
  type CloudSecretsApi
} from './use-cloud-secrets'

export type CloudSecretRepoChoice = {
  /** `github.com/owner/name`, what the control plane keys repo secrets by. */
  key: string
  label: string
}

type Tab = CloudSecretScope | 'effective'
const NO_REPO = '__none__'

function RepoPicker({
  repos,
  value,
  onChange,
  allowNone
}: {
  repos: readonly CloudSecretRepoChoice[]
  value: string | null
  onChange: (repo: string | null) => void
  allowNone: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-2">
      <Label variant="settings" className="shrink-0">
        {t('cloudSecrets.repo.label', 'Repository')}
      </Label>
      <Select
        value={value ?? NO_REPO}
        onValueChange={(next) => onChange(next === NO_REPO ? null : next)}
      >
        <SelectTrigger
          size="sm"
          className="w-64"
          aria-label={t('cloudSecrets.repo.label', 'Repository')}
        >
          <SelectValue placeholder={t('cloudSecrets.repo.choose', 'Choose a repository')} />
        </SelectTrigger>
        <SelectContent>
          {allowNone ? (
            <SelectItem value={NO_REPO}>{t('cloudSecrets.repo.none', 'No repository')}</SelectItem>
          ) : null}
          {repos.map((repo) => (
            <SelectItem key={repo.key} value={repo.key}>
              {repo.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function ReadOnlyNotice({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <p>{text}</p>
    </div>
  )
}

function ScopeTab({
  api,
  scope,
  repo,
  canWrite,
  people,
  readOnlyNotice,
  description,
  emptyTitle,
  emptyDetail,
  onSetUpAgent
}: {
  api: CloudSecretsApi
  scope: CloudSecretScope
  repo: string | null
  canWrite: boolean
  people: CloudSecretPeople
  readOnlyNotice: string | null
  description: string
  emptyTitle: string
  emptyDetail: string
  onSetUpAgent?: () => void
}): React.JSX.Element {
  const model = useCloudSecretList(api, scope, repo)
  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      {!canWrite && readOnlyNotice ? <ReadOnlyNotice text={readOnlyNotice} /> : null}
      <CloudSecretList
        // A different repo is a different list: drop any half-typed form with it.
        key={`${scope}:${repo ?? ''}`}
        model={model}
        canWrite={canWrite}
        people={people}
        emptyTitle={emptyTitle}
        emptyDetail={emptyDetail}
        onSetUpAgent={onSetUpAgent}
      />
    </div>
  )
}

function EffectiveTab({
  api,
  repo
}: {
  api: CloudSecretsApi
  repo: string | null
}): React.JSX.Element {
  const { effective, reload } = useCloudSecretsEffective(api, repo)
  return <CloudSecretsEffectiveView effective={effective} onRetry={reload} />
}

/** Orca Cloud secrets by scope, plus which scope wins. Values are write-only. */
export function CloudSecretsPane({
  api,
  repos,
  people,
  onSetUpAgent,
  initialTab = 'personal'
}: {
  api: CloudSecretsApi
  repos: readonly CloudSecretRepoChoice[]
  people: Omit<CloudSecretPeople, 'viewerUserId'>
  onSetUpAgent?: () => void
  initialTab?: Tab
}): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState<Tab>(initialTab)
  // Undefined until the user picks, so a repo list that loads after mount still preselects its first entry.
  const [pickedRepo, setRepo] = useState<string | null | undefined>(undefined)
  const repo = pickedRepo === undefined ? (repos[0]?.key ?? null) : pickedRepo
  const repoTabRepo = repo ?? repos[0]?.key ?? null
  const { effective: callerView } = useCloudSecretsEffective(api, null)
  const caller = callerView.status === 'ready' ? callerView.value.caller : null
  // Until the caller is known, keep the Shared tab so the tab row does not shift when it loads.
  const inTeam = callerView.status === 'loading' || (caller !== null && caller.orgId !== null)
  const withViewer: CloudSecretPeople = { ...people, viewerUserId: caller?.userId ?? null }
  const adminNotice = t(
    'cloudSecrets.readOnly.shared',
    'Only owners and admins can change shared secrets. Ask an admin.'
  )

  return (
    <div className="space-y-4 border-t border-border/60 pt-5" data-settings-section="cloud-secrets">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
            {t('cloudSecrets.title', 'Cloud secrets')}
          </p>
          <p className="max-w-xl text-xs leading-5 text-muted-foreground">
            {t(
              'cloudSecrets.description',
              'Environment variables and agent keys for Orca Cloud workspaces.'
            )}
          </p>
        </div>
        {onSetUpAgent ? (
          <Button variant="outline" size="sm" className="shrink-0" onClick={onSetUpAgent}>
            <Sparkles />
            {t('cloudSecrets.setUpAgent', 'Set up an agent')}
          </Button>
        ) : null}
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (next === 'personal' || next === 'org' || next === 'repo' || next === 'effective') {
            setTab(next)
          }
        }}
      >
        <TabsList size="sm">
          <TabsTrigger value="personal">{cloudSecretScopeLabel('personal', t)}</TabsTrigger>
          {inTeam ? <TabsTrigger value="org">{cloudSecretScopeLabel('org', t)}</TabsTrigger> : null}
          <TabsTrigger value="repo">{cloudSecretScopeLabel('repo', t)}</TabsTrigger>
          <TabsTrigger value="effective">
            {t('cloudSecrets.tab.effective', 'Effective')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="personal">
          <div className="pt-2">
            <ScopeTab
              api={api}
              scope="personal"
              repo={null}
              canWrite
              people={withViewer}
              readOnlyNotice={null}
              onSetUpAgent={onSetUpAgent}
              description={t(
                'cloudSecrets.personal.description',
                'Only you get these, in every Orca Cloud workspace you start.'
              )}
              emptyTitle={t('cloudSecrets.personal.emptyTitle', 'No personal secrets yet')}
              emptyDetail={t(
                'cloudSecrets.personal.emptyDetail',
                'Add one or paste a .env file. New terminals and agents in your cloud workspaces get them as environment variables.'
              )}
            />
          </div>
        </TabsContent>

        {inTeam ? (
          <TabsContent value="org">
            <div className="pt-2">
              <ScopeTab
                api={api}
                scope="org"
                repo={null}
                canWrite={caller?.canWrite.org === true}
                people={withViewer}
                readOnlyNotice={adminNotice}
                onSetUpAgent={onSetUpAgent}
                description={t(
                  'cloudSecrets.org.description',
                  'Everyone on your team gets these in their Orca Cloud workspaces.'
                )}
                emptyTitle={t('cloudSecrets.org.emptyTitle', 'Your team shares no secrets yet')}
                emptyDetail={
                  caller?.canWrite.org
                    ? t(
                        'cloudSecrets.org.emptyDetailAdmin',
                        'Share an agent key here and every teammate’s Claude or Codex works with no setup.'
                      )
                    : t(
                        'cloudSecrets.org.emptyDetailMember',
                        'An owner or admin can share agent keys and variables with the whole team.'
                      )
                }
              />
            </div>
          </TabsContent>
        ) : null}

        <TabsContent value="repo">
          <div className="space-y-3 pt-2">
            {repos.length === 0 ? (
              <div className="rounded-md border border-dashed border-border/60 px-4 py-5 text-center">
                <p className="text-sm font-medium">
                  {t('cloudSecrets.repo.noReposTitle', 'No GitHub repositories yet')}
                </p>
                <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
                  {t(
                    'cloudSecrets.repo.noReposDetail',
                    'Repo secrets follow a GitHub repository. Add a project with a GitHub remote to set them.'
                  )}
                </p>
              </div>
            ) : (
              <>
                <RepoPicker
                  repos={repos}
                  value={repoTabRepo}
                  onChange={setRepo}
                  allowNone={false}
                />
                {repoTabRepo ? (
                  <ScopeTab
                    api={api}
                    scope="repo"
                    repo={repoTabRepo}
                    canWrite={caller?.canWrite.repo === true}
                    onSetUpAgent={onSetUpAgent}
                    people={withViewer}
                    readOnlyNotice={t(
                      'cloudSecrets.readOnly.repo',
                      'Only owners and admins can change this repository’s secrets. Ask an admin.'
                    )}
                    description={t(
                      'cloudSecrets.repo.description',
                      'Cloud workspaces of this repository get these, for whoever starts them.'
                    )}
                    emptyTitle={t('cloudSecrets.repo.emptyTitle', 'No secrets for this repository')}
                    emptyDetail={t(
                      'cloudSecrets.repo.emptyDetail',
                      'Add the variables this project needs to run, such as DATABASE_URL, or paste its .env file.'
                    )}
                  />
                ) : null}
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="effective">
          <div className="space-y-3 pt-2">
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
                'cloudSecrets.effective.description',
                'What a new cloud workspace gets, and which scope each value comes from.'
              )}
            </p>
            {repos.length > 0 ? (
              <RepoPicker repos={repos} value={repo} onChange={setRepo} allowNone />
            ) : null}
            <EffectiveTab api={api} repo={repo} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
