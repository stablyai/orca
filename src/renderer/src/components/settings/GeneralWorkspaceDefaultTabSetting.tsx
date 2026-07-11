import type React from 'react'
import { useMemo } from 'react'
import { Globe, TerminalSquare } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import type { DefaultWorkspaceTab } from '../../../../shared/default-workspace-tab'
import {
  normalizeDefaultWorkspaceTab,
  parseDefaultWorkspaceTab,
  serializeDefaultWorkspaceTab
} from '../../../../shared/default-workspace-tab'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import {
  buildTabCreateMenuOptions,
  type TabCreateMenuOption
} from '../tab-bar/tab-create-menu-options'
import {
  buildTabAgentLaunchOptions,
  orderTabLaunchAgents
} from '../tab-bar/tab-agent-launch-options'
import { ShellIcon } from '../tab-bar/shell-icons'
import { AgentIcon } from '@/lib/agent-catalog'
import { useAppStore } from '../../store'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import {
  useWindowsTerminalCapabilities,
  type WindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { translate } from '@/i18n/i18n'

const IS_WINDOWS_CLIENT =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')

type GeneralWorkspaceDefaultTabSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

// Why: reuse the exact "+" new-tab menu icons so the default picker and the menu
// stay visually identical. Shells use the per-shell brand glyph like the static
// menu; browser/terminal use the same lucide icons.
function menuOptionIcon(option: TabCreateMenuOption): React.ReactNode {
  if (option.kind === 'new-browser') {
    return <Globe className="size-4 text-muted-foreground" />
  }
  if (option.kind === 'new-terminal-shell' && option.shell) {
    return <ShellIcon shell={option.shell} size={16} />
  }
  return <TerminalSquare className="size-4 text-muted-foreground" />
}

// Maps a "+" menu option to the stored descriptor. Returns null for surfaces
// that are not offered as a first-open default (markdown, mobile emulator) or a
// future kind not yet wired into activation — those are simply skipped.
function menuOptionToDefaultTab(option: TabCreateMenuOption): DefaultWorkspaceTab | null {
  if (option.kind === 'new-terminal') {
    return { kind: 'terminal' }
  }
  if (option.kind === 'new-terminal-shell') {
    return option.shell ? { kind: 'terminal-shell', shell: option.shell } : { kind: 'terminal' }
  }
  if (option.kind === 'new-browser') {
    return { kind: 'browser' }
  }
  return null
}

// Why: mirror the "+" menu's Windows shell list (PowerShell/CMD always, Git Bash
// and WSL when the local probe finds them, default shell first). Reuses the same
// translation keys as the menu so labels stay identical across locales.
function buildWindowsShellEntries(
  capabilities: WindowsTerminalCapabilities,
  defaultShell: string | undefined,
  current: DefaultWorkspaceTab
): { label: string; shell: BuiltInWindowsTerminalShell }[] | undefined {
  if (!IS_WINDOWS_CLIENT) {
    return undefined
  }
  const labels: Record<BuiltInWindowsTerminalShell, string> = {
    'powershell.exe': translate('auto.components.tab.bar.TabBar.2148f65e04', 'PowerShell'),
    'cmd.exe': translate('auto.components.tab.bar.TabBar.1a8af49530', 'CMD Prompt'),
    'wsl.exe': translate('auto.components.tab.bar.TabBar.d1afac112b', 'WSL'),
    [WINDOWS_GIT_BASH_SHELL]: translate('auto.components.tab.bar.TabBar.efb33546ff', 'Git Bash')
  }
  const shells: BuiltInWindowsTerminalShell[] = ['powershell.exe', 'cmd.exe']
  if (capabilities.gitBashAvailable) {
    shells.push(WINDOWS_GIT_BASH_SHELL)
  }
  if (capabilities.wslAvailable) {
    shells.push('wsl.exe')
  }
  // Keep the stored shell selectable even if the local probe no longer lists it.
  if (current.kind === 'terminal-shell' && !shells.includes(current.shell)) {
    shells.push(current.shell)
  }
  const ordered =
    defaultShell && shells.includes(defaultShell as BuiltInWindowsTerminalShell)
      ? [
          defaultShell as BuiltInWindowsTerminalShell,
          ...shells.filter((shell) => shell !== defaultShell)
        ]
      : shells
  return ordered.map((shell) => ({ label: labels[shell], shell }))
}

export function GeneralWorkspaceDefaultTabSetting({
  settings,
  updateSettings
}: GeneralWorkspaceDefaultTabSettingProps): React.JSX.Element {
  const capabilities = useWindowsTerminalCapabilities(IS_WINDOWS_CLIENT, false)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const { detectedIds } = useDetectedAgents(null)

  const current = normalizeDefaultWorkspaceTab(settings.defaultWorkspaceTab)

  // Single source of truth: exactly the same options the "+" new-tab menu shows
  // — on Windows the specific shells (no plain "New Terminal"), on other
  // platforms "New Terminal" — minus the document/emulator surfaces that do not
  // make sense as a reopen default.
  const surfaceItems = useMemo(() => {
    const windowsShellEntries = buildWindowsShellEntries(
      capabilities,
      settings.terminalWindowsShell,
      current
    )
    const menuOptions = buildTabCreateMenuOptions({
      terminalOnly: false,
      windowsShellEntries,
      hasNewBrowser: true,
      hasNewMarkdown: false,
      hasOpenMarkdown: false,
      hasSimulator: false,
      simulatorIsGoTo: false
    })
    const items: { value: string; label: string; icon: React.ReactNode }[] = []
    for (const option of menuOptions) {
      const descriptor = menuOptionToDefaultTab(option)
      if (!descriptor) {
        continue
      }
      items.push({
        value: serializeDefaultWorkspaceTab(descriptor),
        label: option.label,
        icon: menuOptionIcon(option)
      })
    }
    return items
  }, [capabilities, current, settings.terminalWindowsShell])

  const agentItems = useMemo(() => {
    const ordered = orderTabLaunchAgents(defaultAgent, detectedIds ?? [])
    const withCurrent =
      current.kind === 'agent' && !ordered.includes(current.agent)
        ? [current.agent, ...ordered]
        : ordered
    return buildTabAgentLaunchOptions(withCurrent)
  }, [current, defaultAgent, detectedIds])

  // Why: the stored default may not be a rendered option — a plain-terminal
  // default on Windows (where the menu shows shells, not "New Terminal"), or a
  // shell/agent no longer available on this host. Show the first option (the
  // default shell on Windows, "New Terminal" elsewhere) so the trigger always
  // reflects a valid, matching selection.
  const currentValue = serializeDefaultWorkspaceTab(current)
  const selectedValue = useMemo(() => {
    const values = new Set<string>([
      ...surfaceItems.map((item) => item.value),
      ...agentItems.map((agent) => `agent:${agent.agent}`)
    ])
    return values.has(currentValue) ? currentValue : (surfaceItems[0]?.value ?? currentValue)
  }, [surfaceItems, agentItems, currentValue])

  const title = translate(
    'auto.components.settings.GeneralWorkspaceDefaultTabSetting.d5ace069a0',
    'Default Tab'
  )
  const description = translate(
    'auto.components.settings.GeneralWorkspaceDefaultTabSetting.c8b1d50fbe',
    'The tab that opens the first time you open a workspace from the sidebar.'
  )

  return (
    <SearchableSetting title={title} description={description}>
      <SettingsRow
        label={title}
        description={description}
        control={
          <Select
            value={selectedValue}
            onValueChange={(value) =>
              updateSettings({ defaultWorkspaceTab: parseDefaultWorkspaceTab(value) })
            }
          >
            <SelectTrigger size="sm" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {surfaceItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <span className="flex items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                </SelectItem>
              ))}
              {agentItems.length > 0 && <SelectSeparator />}
              {agentItems.map((agent) => (
                <SelectItem key={`agent:${agent.agent}`} value={`agent:${agent.agent}`}>
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={agent.agent} size={14} />
                    {agent.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
