import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  GITIGNORE_TEMPLATES_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type {
  GitignoreTemplateCatalogResult,
  GitignoreTemplateResult
} from '../../../shared/gitignore-templates'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from './runtime-rpc-client'
import { translate } from '@/i18n/i18n'

const updateMessage = (): string =>
  translate(
    'gitignore.templates.errors.hostUnavailable',
    'Gitignore templates are unavailable on this host. Reconnect to update Orca, then try again.'
  )

async function callTemplateRuntime<T>(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  method: string,
  params: object | null
): Promise<T> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'local') {
    if (method === 'gitignoreTemplates.list') {
      return window.api.gitignoreTemplates.list() as Promise<T>
    }
    return window.api.gitignoreTemplates.get((params as { name: string }).name) as Promise<T>
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    GITIGNORE_TEMPLATES_RUNTIME_CAPABILITY as RuntimeCapability,
    updateMessage()
  )
  return callRuntimeRpc<T>(target, method, params, { timeoutMs: 15_000 })
}

export function listRuntimeGitignoreTemplates(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<GitignoreTemplateCatalogResult> {
  return callTemplateRuntime(settings, 'gitignoreTemplates.list', null)
}

export function getRuntimeGitignoreTemplate(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  name: string
): Promise<GitignoreTemplateResult> {
  return callTemplateRuntime(settings, 'gitignoreTemplates.get', { name })
}
