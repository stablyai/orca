import type { SettingsSearchEntry } from './search/settings-search'
import { searchKeywordTranslator } from './search/settings-search-keywords'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useEffect, useState, type ComponentProps } from 'react'
import { SearchableSetting } from './section-layout/SearchableSetting'
import { toast } from 'sonner'
import type { Project, ProjectUpdateArgs } from '../../../../shared/project-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { readHostAgentLaunchSettings } from '../../runtime/agent-launch-settings/agent-launch-settings-transport'

type ProjectDefaultAgentSettingProps = {
  project: Project
  globalDefault: GlobalSettings['defaultTuiAgent'] | undefined
  executionHostId?: ExecutionHostId
  updateProject: (projectId: string, updates: ProjectUpdateArgs['updates']) => unknown
} & Pick<ComponentProps<typeof SearchableSetting>, 'keywords' | 'forceVisible'>

export function ProjectDefaultAgentSetting(
  props: ProjectDefaultAgentSettingProps
): React.JSX.Element {
  const t = useTranslate()
  return (
    <SearchableSetting
      title={t('settings.projectDefaultAgent.title', 'Default agent')}
      description={t(
        'settings.projectDefaultAgent.description',
        'Choose the agent used for new workspaces in this project.'
      )}
      keywords={props.keywords}
      forceVisible={props.forceVisible}
    >
      <ProjectDefaultAgentControl {...props} />
    </SearchableSetting>
  )
}

function ProjectDefaultAgentControl({
  project,
  globalDefault,
  executionHostId,
  updateProject
}: ProjectDefaultAgentSettingProps): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<{
    projectId: string
    value: string
    message: string
  } | null>(null)
  const error = failure?.projectId === project.id ? failure : null
  const [remoteGlobal, setRemoteGlobal] = useState<
    | { status: 'loading' | 'unavailable' }
    | { status: 'ready'; value: GlobalSettings['defaultTuiAgent'] }
  >({ status: 'loading' })
  const host = parseExecutionHostId(executionHostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  useEffect(() => {
    if (!environmentId) {
      return
    }
    const controller = new AbortController()
    setRemoteGlobal({ status: 'loading' })
    void readHostAgentLaunchSettings({ environmentId }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setRemoteGlobal(
            result ? { status: 'ready', value: result.defaultTuiAgent } : { status: 'unavailable' }
          )
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setRemoteGlobal({ status: 'unavailable' })
        }
      }
    )
    return () => controller.abort()
  }, [environmentId])
  const label = t('settings.projectDefaultAgent.title', 'Default agent')
  const saved = project.defaultTuiAgent ?? 'inherit'
  const effectiveGlobal = environmentId
    ? remoteGlobal.status === 'ready'
      ? remoteGlobal.value
      : undefined
    : globalDefault
  const globalLabel =
    environmentId && remoteGlobal.status === 'loading'
      ? t('settings.projectDefaultAgent.targetGlobalLoading', 'Loading target host global default…')
      : effectiveGlobal === undefined
        ? t(
            'settings.projectDefaultAgent.targetGlobalUnavailable',
            'Target host global setting unavailable'
          )
        : effectiveGlobal === 'blank'
          ? t('settings.projectDefaultAgent.blankTerminal', 'Blank Terminal')
          : effectiveGlobal
            ? getAgentLabel(effectiveGlobal)
            : t('settings.projectDefaultAgent.auto', 'Automatic selection')

  const save = async (value: string): Promise<void> => {
    const next = value === 'inherit' ? null : value === 'blank' || isTuiAgent(value) ? value : null
    if (value !== 'inherit' && next === null) {
      return
    }
    setSaving(true)
    setFailure(null)
    const message = await persistProjectDefaultAgent(project.id, next, updateProject, t)
    if (message !== null) {
      setFailure({ projectId: project.id, value, message })
    }
    setSaving(false)
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`project-default-agent-${project.id}`}>{label}</Label>
      <Select value={saved} onValueChange={(value) => void save(value)} disabled={saving}>
        <SelectTrigger
          id={`project-default-agent-${project.id}`}
          aria-label={label}
          className="w-64"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">
            {t('settings.projectDefaultAgent.inherit', 'Inherit global')}
          </SelectItem>
          <SelectItem value="blank">
            {t('settings.projectDefaultAgent.blankTerminal', 'Blank Terminal')}
          </SelectItem>
          {getAgentCatalog().map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {saved === 'inherit'
          ? t(
              'settings.projectDefaultAgent.effectiveGlobal',
              'Current global default: {{value0}}',
              { value0: globalLabel }
            )
          : t(
              'settings.projectDefaultAgent.futureLaunches',
              'Applies to new workspaces and agent launches in this project.'
            )}
      </p>
      {error ? (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">
            {error.message}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => void save(error.value)}
          >
            {t('settings.projectDefaultAgent.retry', 'Retry save')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

async function persistProjectDefaultAgent(
  projectId: string,
  next: ProjectUpdateArgs['updates']['defaultTuiAgent'],
  updateProject: ProjectDefaultAgentSettingProps['updateProject'],
  t: Translate
): Promise<string | null> {
  try {
    const result = await updateProject(projectId, { defaultTuiAgent: next })
    if (result !== true) {
      return t(
        'settings.projectDefaultAgent.saveFailed',
        'Project default agent could not be saved. Update the target host and try again.'
      )
    }
    toast.success(t('settings.projectDefaultAgent.saved', 'Project default agent saved'))
    return null
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
}

export function getProjectDefaultAgentSearchEntry(
  displayName: string,
  t: Translate = translate
): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('settings.projectDefaultAgent.title', 'Default agent'),
    description: t(
      'settings.projectDefaultAgent.description',
      'Choose the agent used for new workspaces in this project.'
    ),
    keywords: [
      displayName,
      ...translateSearchKeyword('settings.projectDefaultAgent.keywordAgent', 'agent'),
      ...translateSearchKeyword('settings.projectDefaultAgent.keywordDefault', 'default agent'),
      ...translateSearchKeyword('settings.projectDefaultAgent.keywordBlank', 'blank terminal'),
      ...translateSearchKeyword('settings.projectDefaultAgent.keywordInherit', 'inherit global')
    ]
  }
}
