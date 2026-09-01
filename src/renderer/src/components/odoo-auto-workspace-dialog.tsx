import React, { useState } from 'react'

import {
  DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS,
  ODOO_AUTO_WORKSPACE_MAX_PER_RUN,
  readOdooAutoWorkspaceSettings,
  writeOdooAutoWorkspaceSettings,
  type OdooAutoWorkspaceSettings
} from '@/components/odoo-auto-workspace-settings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ODOO_PRIORITIES } from '../../../shared/odoo-types'
import type { OdooPriority } from '../../../shared/odoo-types'
function FieldRow({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Configures the unattended workspace start: which repo, and what a ticket
 *  must look like to earn one. Off until a target repo is picked. */
export function OdooAutoWorkspaceDialog({
  open,
  onOpenChange,
  priorityLabels
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  priorityLabels: Record<OdooPriority, string>
}): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const [draft, setDraft] = useState<OdooAutoWorkspaceSettings>(readOdooAutoWorkspaceSettings)

  const patch = (updates: Partial<OdooAutoWorkspaceSettings>): void =>
    setDraft((current) => ({ ...current, ...updates }))
  const patchCriteria = (updates: Partial<OdooAutoWorkspaceSettings['criteria']>): void =>
    setDraft((current) => ({ ...current, criteria: { ...current.criteria, ...updates } }))

  const save = (): void => {
    const next = { ...draft, enabled: draft.enabled && draft.repoId !== null }
    writeOdooAutoWorkspaceSettings(next)
    setDraft(next)
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(readOdooAutoWorkspaceSettings())
        }
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.odoo.auto.workspace.dialog.def72a8110',
              'Auto-start workspaces'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.odoo.auto.workspace.dialog.b32ad78d76',
              'Starts a workspace for matching tickets on each panel refresh. A ticket that already has one never starts a second.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y divide-border/60">
          <FieldRow
            label={translate('auto.components.odoo.auto.workspace.dialog.6183b72801', 'Enabled')}
            hint={
              draft.repoId
                ? undefined
                : translate(
                    'auto.components.odoo.auto.workspace.dialog.94e897a5f6',
                    'Pick a target project first.'
                  )
            }
          >
            <Switch
              checked={draft.enabled && draft.repoId !== null}
              disabled={draft.repoId === null}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          </FieldRow>

          <FieldRow
            label={translate('auto.components.odoo.auto.workspace.dialog.0abbef1e76', 'Project')}
            hint={translate(
              'auto.components.odoo.auto.workspace.dialog.d0ee9eab4f',
              'An Odoo ticket carries no repository, so the target is set here.'
            )}
          >
            <Select
              value={draft.repoId ?? ''}
              onValueChange={(value) => patch({ repoId: value || null })}
            >
              <SelectTrigger className="h-8 w-52 text-xs">
                <SelectValue
                  placeholder={translate(
                    'auto.components.odoo.auto.workspace.dialog.f80f5d71fc',
                    'Pick a project'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    {repo.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>

          <FieldRow
            label={translate(
              'auto.components.odoo.auto.workspace.dialog.82f5c40202',
              'Base branch'
            )}
            hint={translate(
              'auto.components.odoo.auto.workspace.dialog.b2506d68ee',
              "Empty uses the project's default branch."
            )}
          >
            <Input
              value={draft.baseBranch}
              onChange={(event) => patch({ baseBranch: event.target.value })}
              className="h-8 w-52 text-xs"
            />
          </FieldRow>

          <FieldRow
            label={translate(
              'auto.components.odoo.auto.workspace.dialog.e383dfcbe7',
              'Assigned to me'
            )}
          >
            <Switch
              checked={draft.criteria.assignedToMe}
              onCheckedChange={(checked) => patchCriteria({ assignedToMe: checked })}
            />
          </FieldRow>

          <FieldRow
            label={translate('auto.components.odoo.auto.workspace.dialog.71667e4cd3', 'Priority')}
            hint={translate(
              'auto.components.odoo.auto.workspace.dialog.d428eeeeb6',
              'Any priority when none is picked.'
            )}
          >
            <div className="flex gap-1">
              {ODOO_PRIORITIES.map((priority) => {
                const active = draft.criteria.priorities.includes(priority)
                return (
                  <Button
                    key={priority}
                    type="button"
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    className="h-7 px-2 text-xs"
                    aria-pressed={active}
                    onClick={() =>
                      patchCriteria({
                        priorities: active
                          ? draft.criteria.priorities.filter((entry) => entry !== priority)
                          : [...draft.criteria.priorities, priority]
                      })
                    }
                  >
                    {priorityLabels[priority]}
                  </Button>
                )
              })}
            </div>
          </FieldRow>

          <FieldRow
            label={translate(
              'auto.components.odoo.auto.workspace.dialog.1438887ad6',
              'Due within (days)'
            )}
            hint={translate(
              'auto.components.odoo.auto.workspace.dialog.ee831d45e1',
              'Overdue tickets always match. Empty ignores deadlines.'
            )}
          >
            <Input
              type="number"
              min={0}
              value={draft.criteria.deadlineWithinDays ?? ''}
              onChange={(event) => {
                const raw = Number(event.target.value)
                patchCriteria({
                  deadlineWithinDays:
                    event.target.value === '' || !Number.isFinite(raw) || raw < 0 ? null : raw
                })
              }}
              className="h-8 w-24 text-xs"
            />
          </FieldRow>

          <FieldRow
            label={translate(
              'auto.components.odoo.auto.workspace.dialog.3c57f063a0',
              'Require a description'
            )}
          >
            <Switch
              checked={draft.criteria.requireDescription}
              onCheckedChange={(checked) => patchCriteria({ requireDescription: checked })}
            />
          </FieldRow>

          <FieldRow
            label={translate(
              'auto.components.odoo.auto.workspace.dialog.b4667b375d',
              'Max per refresh'
            )}
            hint={translate(
              'auto.components.odoo.auto.workspace.dialog.18d16befe4',
              'Bounds how many workspaces one over-broad rule can create.'
            )}
          >
            <Input
              type="number"
              min={1}
              max={ODOO_AUTO_WORKSPACE_MAX_PER_RUN}
              value={draft.maxPerRun}
              onChange={(event) => {
                // `Number('')` is 0, and a cap of 0 selects no candidate at all —
                // clearing the field must not silently disarm an enabled rule.
                const raw = Number(event.target.value)
                const cleared = event.target.value.trim() === ''
                patch({
                  maxPerRun:
                    cleared || !Number.isFinite(raw)
                      ? DEFAULT_ODOO_AUTO_WORKSPACE_SETTINGS.maxPerRun
                      : Math.min(Math.max(Math.trunc(raw), 1), ODOO_AUTO_WORKSPACE_MAX_PER_RUN)
                })
              }}
              className="h-8 w-24 text-xs"
            />
          </FieldRow>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.odoo.auto.workspace.dialog.06bb829452', 'Cancel')}
          </Button>
          <Button onClick={save}>
            {translate('auto.components.odoo.auto.workspace.dialog.f2040d28d3', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
