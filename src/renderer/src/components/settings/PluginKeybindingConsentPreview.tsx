import { AlertTriangle } from 'lucide-react'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import {
  findKeybindingActionsForBinding,
  formatKeybindingList,
  getKeybindingDefinition,
  type KeybindingOverrides
} from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import { PluginReviewSection } from './plugin-review-dialog-layout'
import { useAppStore } from '@/store'

type CommandPreview = PluginHostListEntry['commands'][number]

function shortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  return navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
}

export function shadowedKeybindingTitles(
  binding: string,
  platform: NodeJS.Platform,
  overrides?: KeybindingOverrides
): string[] {
  return findKeybindingActionsForBinding(binding, platform, overrides).map(
    (actionId) => getKeybindingDefinition(actionId)?.title ?? actionId
  )
}

export function PluginKeybindingConsentPreview({
  commands
}: {
  commands: readonly CommandPreview[]
}): React.JSX.Element | null {
  const overrides = useAppStore((state) => state.keybindings)
  const platform = shortcutPlatform()
  const bindings = commands.flatMap((command) =>
    command.keybindings.map((keybinding) => ({ command, keybinding }))
  )
  if (bindings.length === 0) {
    return null
  }

  return (
    <PluginReviewSection
      headingId="plugin-keybinding-consent-heading"
      title={translate(
        'auto.components.settings.PluginKeybindingConsentPreview.heading',
        'Keyboard shortcuts'
      )}
    >
      <div className="divide-y divide-border/60">
        {bindings.map(({ command, keybinding }) => {
          const shadowed = shadowedKeybindingTitles(keybinding.key, platform, overrides)
          return (
            <div
              key={`${command.id}:${keybinding.key}`}
              className="space-y-1 py-2.5 first:pt-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{command.title}</span>
                <kbd className="rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground">
                  {formatKeybindingList([keybinding.key], platform)}
                </kbd>
              </div>
              <p className="text-xs text-muted-foreground">
                {keybinding.when === 'worktree'
                  ? translate(
                      'auto.components.settings.PluginKeybindingConsentPreview.worktree',
                      'Runs only while a workspace is active.'
                    )
                  : translate(
                      'auto.components.settings.PluginKeybindingConsentPreview.global',
                      'Works anywhere in Orca.'
                    )}
              </p>
              {shadowed.length > 0 ? (
                <p className="flex items-start gap-1.5 text-xs leading-5 text-foreground">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {translate(
                      'auto.components.settings.PluginKeybindingConsentPreview.shadows',
                      'Replaces: {{value0}}',
                      { value0: shadowed.join(', ') }
                    )}
                  </span>
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    </PluginReviewSection>
  )
}
