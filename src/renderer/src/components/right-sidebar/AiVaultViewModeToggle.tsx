import type React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { AiVaultViewMode } from './ai-vault-prompt-timeline'
import { VAULT_SCOPE_TOGGLE_ITEM_CLASS } from './AiVaultPanelControls'

export function VaultViewModeToggle({
  viewMode,
  onViewModeChange
}: {
  viewMode: AiVaultViewMode
  onViewModeChange: (mode: AiVaultViewMode) => void
}): React.JSX.Element {
  return (
    <ToggleGroup
      type="single"
      value={viewMode}
      onValueChange={(value) => {
        // Single-select ToggleGroup emits '' when re-clicking the active item; ignore it.
        if (value === 'sessions' || value === 'prompts') {
          onViewModeChange(value)
        }
      }}
      variant="outline"
      className="h-7 w-full rounded-md border border-sidebar-border bg-sidebar-accent/35 shadow-xs"
      aria-label={translate(
        'auto.components.right.sidebar.AiVaultPanelControls.viewModeAriaLabel',
        'Session History view'
      )}
    >
      <ToggleGroupItem value="sessions" className={VAULT_SCOPE_TOGGLE_ITEM_CLASS}>
        {translate('auto.components.right.sidebar.AiVaultPanelControls.sessionsView', 'Sessions')}
      </ToggleGroupItem>
      <ToggleGroupItem value="prompts" className={VAULT_SCOPE_TOGGLE_ITEM_CLASS}>
        {translate('auto.components.right.sidebar.AiVaultPanelControls.promptsView', 'My prompts')}
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
