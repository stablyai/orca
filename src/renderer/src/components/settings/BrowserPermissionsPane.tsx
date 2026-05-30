import { useMemo } from 'react'
import type { BrowserSitePermissionRule, GlobalSettings } from '../../../../shared/types'
import {
  BROWSER_PERMISSION_LABELS,
  BROWSER_PERMISSION_ORDER,
  getModePermissionDefaults
} from '../../../../shared/browser-permissions'
import type { BrowserPermissionAction } from '../../../../shared/types'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { BROWSER_PERMISSIONS_PANE_SEARCH_ENTRIES } from './browser-permissions-search'

export { BROWSER_PERMISSIONS_PANE_SEARCH_ENTRIES }

type BrowserPermissionsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const ACTION_OPTIONS: BrowserPermissionAction[] = ['allow', 'deny', 'prompt']
const ACTION_LABELS: Record<BrowserPermissionAction, string> = {
  allow: 'Allow',
  deny: 'Deny',
  prompt: 'Prompt'
}

export function removeBrowserSitePermissionRuleAtIndex(
  rules: BrowserSitePermissionRule[],
  indexToRemove: number
): BrowserSitePermissionRule[] {
  return rules.filter((_entry, ruleIndex) => ruleIndex !== indexToRemove)
}

export function getBrowserPermissionRuleProfileLabel(
  profileId: string,
  profileLabelById: ReadonlyMap<string, string>
): string {
  return (
    profileLabelById.get(profileId) ??
    (profileId === 'default' ? 'Default' : `Removed profile ${profileId}`)
  )
}

export function BrowserPermissionsPane({
  settings,
  updateSettings
}: BrowserPermissionsPaneProps): React.JSX.Element {
  const browserSessionProfiles = useAppStore((state) => state.browserSessionProfiles)
  const modeDefaults = getModePermissionDefaults(settings.browserInteractionMode)
  const profileLabelById = useMemo(
    () => new Map(browserSessionProfiles.map((profile) => [profile.id, profile.label] as const)),
    [browserSessionProfiles]
  )

  const setPermissionDefault = (permission: string, action: BrowserPermissionAction): void => {
    const next = { ...settings.browserPermissionDefaults }
    if (modeDefaults[permission] === action) {
      delete next[permission]
    } else {
      next[permission] = action
    }
    updateSettings({ browserPermissionDefaults: next })
  }

  return (
    <SearchableSetting
      id="browser-permissions"
      title="Browser Permissions"
      description="Choose whether Orca's browser behaves like an automation surface or a human-driven browser, then tune default permission actions and remembered site rules."
      keywords={BROWSER_PERMISSIONS_PANE_SEARCH_ENTRIES[0].keywords}
      className="space-y-4 px-1 py-2"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Interaction Mode</Label>
          <Select
            value={settings.browserInteractionMode}
            onValueChange={(value) =>
              updateSettings({
                browserInteractionMode: value as GlobalSettings['browserInteractionMode']
              })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="agent" className="text-xs">
                Agent
              </SelectItem>
              <SelectItem value="human" className="text-xs">
                Human
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Permission Notices</Label>
          <Select
            value={settings.browserPermissionNoticePolicy}
            onValueChange={(value) =>
              updateSettings({
                browserPermissionNoticePolicy:
                  value as GlobalSettings['browserPermissionNoticePolicy']
              })
            }
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                Show all
              </SelectItem>
              <SelectItem value="important-only" className="text-xs">
                Important only
              </SelectItem>
              <SelectItem value="silent-auto-deny" className="text-xs">
                Silence auto-deny
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-0.5">
          <Label>Default Permission Rules</Label>
          <p className="text-xs text-muted-foreground">
            Mode sets the baseline. Changes here override the mode default for a specific
            permission.
          </p>
        </div>
        <div className="space-y-2">
          {BROWSER_PERMISSION_ORDER.map((permission) => {
            const effective =
              settings.browserPermissionDefaults[permission] ?? modeDefaults[permission]
            return (
              <div
                key={permission}
                className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2"
              >
                <div className="space-y-0.5">
                  <div className="text-sm">{BROWSER_PERMISSION_LABELS[permission]}</div>
                  <div className="text-[11px] text-muted-foreground">{permission}</div>
                </div>
                <Select
                  value={effective}
                  onValueChange={(value) =>
                    setPermissionDefault(permission, value as BrowserPermissionAction)
                  }
                >
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTION_OPTIONS.map((action) => (
                      <SelectItem key={action} value={action} className="text-xs">
                        {ACTION_LABELS[action]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>Remembered Site Rules</Label>
            <p className="text-xs text-muted-foreground">
              Human-mode prompts and CLI rules can remember site-specific decisions here.
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            disabled={settings.browserSitePermissionRules.length === 0}
            onClick={() => updateSettings({ browserSitePermissionRules: [] })}
          >
            Clear all
          </Button>
        </div>

        {settings.browserSitePermissionRules.length === 0 ? (
          <div className="rounded-md border border-dashed border-border/60 px-3 py-4 text-xs text-muted-foreground">
            No remembered site rules yet.
          </div>
        ) : (
          <div className="space-y-2">
            {settings.browserSitePermissionRules.map((rule, index) => {
              const profileId = rule.profileId ?? 'default'
              const profileLabel = getBrowserPermissionRuleProfileLabel(profileId, profileLabelById)
              return (
                <div
                  key={`${profileId}:${rule.origin}:${rule.permission}:${index}`}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/50 px-3 py-2"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="truncate text-sm">{rule.origin}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {profileLabel} - {rule.permission} - {ACTION_LABELS[rule.action]}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() =>
                      updateSettings({
                        browserSitePermissionRules: removeBrowserSitePermissionRuleAtIndex(
                          settings.browserSitePermissionRules,
                          index
                        )
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </SearchableSetting>
  )
}
