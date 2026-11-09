import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudApiScope } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'

export type ScopeLevel = 'none' | 'read' | 'write'

type Resource = {
  id: 'workspaces' | 'messages' | 'projects' | 'routines' | 'audit'
  read?: CloudApiScope
  write?: CloudApiScope
}

/** Resource × access level: one compact row each instead of eight checkboxes. */
export const SCOPE_RESOURCES: readonly Resource[] = [
  { id: 'workspaces', read: 'workspaces:read', write: 'workspaces:write' },
  { id: 'messages', write: 'messages:write' },
  { id: 'projects', read: 'projects:read', write: 'projects:write' },
  { id: 'routines', read: 'routines:read', write: 'routines:write' },
  { id: 'audit', read: 'audit:read' }
]

export function levelOf(resource: Resource, scopes: ReadonlySet<CloudApiScope>): ScopeLevel {
  if (resource.write && scopes.has(resource.write)) {
    return 'write'
  }
  return resource.read && scopes.has(resource.read) ? 'read' : 'none'
}

/** Write includes read: an API that can change something can always look at it. */
export function withLevel(
  resource: Resource,
  scopes: ReadonlySet<CloudApiScope>,
  level: ScopeLevel
): Set<CloudApiScope> {
  const next = new Set(scopes)
  for (const scope of [resource.read, resource.write]) {
    if (scope) {
      next.delete(scope)
    }
  }
  if (level !== 'none' && resource.read) {
    next.add(resource.read)
  }
  if (level === 'write' && resource.write) {
    next.add(resource.write)
  }
  return next
}

function resourceLabel(id: Resource['id'], t: Translate): string {
  switch (id) {
    case 'workspaces':
      return t('auto.components.settings.cloudApi.matrix.workspaces', 'Workspaces')
    case 'messages':
      return t('auto.components.settings.cloudApi.matrix.messages', 'Agent messages')
    case 'projects':
      return t('auto.components.settings.cloudApi.matrix.projects', 'Projects')
    case 'routines':
      return t('auto.components.settings.cloudApi.matrix.routines', 'Routines')
    case 'audit':
      return t('auto.components.settings.cloudApi.matrix.audit', 'Audit log')
  }
}

export function ScopeMatrix({
  scopes,
  available,
  onChange
}: {
  scopes: ReadonlySet<CloudApiScope>
  available: readonly CloudApiScope[]
  onChange: (next: Set<CloudApiScope>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const adminOnly = t('auto.components.settings.cloudApi.matrix.adminOnly', 'Team admins only')
  return (
    <div className="grid gap-1 rounded-lg border border-border/70 p-2" role="group">
      {SCOPE_RESOURCES.map((resource) => {
        const labelId = `scope-matrix-${resource.id}`
        const canRead = Boolean(resource.read && available.includes(resource.read))
        const canWrite = Boolean(resource.write && available.includes(resource.write))
        const locked = !canRead && !canWrite
        return (
          <div key={resource.id} className="flex items-center justify-between gap-3 px-1 py-1">
            <span id={labelId} className="min-w-0 truncate text-sm">
              {resourceLabel(resource.id, t)}
              {locked ? (
                <span className="ml-1.5 text-xs text-muted-foreground">· {adminOnly}</span>
              ) : null}
            </span>
            <SettingsSegmentedControl<ScopeLevel>
              size="sm"
              ariaLabelledBy={labelId}
              value={levelOf(resource, scopes)}
              onChange={(level) => onChange(withLevel(resource, scopes, level))}
              options={[
                {
                  value: 'none' as const,
                  label: t('auto.components.settings.cloudApi.matrix.none', 'None')
                },
                {
                  value: 'read' as const,
                  label: t('auto.components.settings.cloudApi.matrix.read', 'Read'),
                  disabled: !canRead,
                  tooltip: resource.read ? (canRead ? undefined : adminOnly) : undefined
                },
                {
                  value: 'write' as const,
                  label:
                    resource.id === 'messages'
                      ? t('auto.components.settings.cloudApi.matrix.send', 'Send')
                      : t('auto.components.settings.cloudApi.matrix.write', 'Write'),
                  disabled: !canWrite
                }
              ].filter((option) =>
                option.value === 'read'
                  ? Boolean(resource.read)
                  : option.value === 'write'
                    ? Boolean(resource.write)
                    : true
              )}
            />
          </div>
        )
      })}
    </div>
  )
}
