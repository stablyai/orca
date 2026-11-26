import { shallow } from 'zustand/shallow'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../../store/index'
import { KeybindingsFileActions } from './KeybindingsFileActions'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { ShortcutFilterRail } from './ShortcutFilterRail'
import type { ShortcutFilter } from './ShortcutFilterRail'
import { ShortcutRowsList } from './ShortcutRowsList'
import { ShortcutTerminalPolicyControl } from './ShortcutTerminalPolicyControl'
import { getTerminalShortcutPolicySearchEntry } from './shortcuts-search'
import { matchesSettingsSearch } from '../search/settings-search'
import { clearRecordingActionForShortcutMutation } from './shortcut-recording-state'
import { adjustRecordingIndexAfterRemove, removeBindingAt } from './shortcut-binding-list-mutations'
import { useTranslate } from '@/i18n/use-translate'
import { getClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'
import { KeybindingFileDiagnostics } from './KeybindingFileDiagnostics'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useKeybindingActionEditor } from './use-keybinding-action-editor'
import { useShortcutRecorderFocus } from './use-shortcut-recorder-focus'
import type { KeybindingActionId, KeybindingInput } from '../../../../../shared/keybindings/types'

export function ShortcutsPane(): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const terminalShortcutPolicy = useAppStore(
    (state) => state.settings?.terminalShortcutPolicy ?? 'orca-first'
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  const disableKeybindingAction = useAppStore((state) => state.disableKeybindingAction)
  const {
    platform,
    catalog,
    keybindings,
    keybindingSnapshot,
    errors,
    setErrors,
    clearError,
    mountedRef,
    effectiveBindingsForAction,
    saveBindings,
    captureBinding: captureBindingAt
  } = useKeybindingActionEditor()
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] =
    useAppStoreWithHostStatuses((state, statuses) => {
      const policy = getClientCreationActionPolicy(state, state.activeWorktreeId, statuses)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    }, shallow)
  const agentDashboardEnabled = useAppStore(
    (state) => state.settings?.experimentalAgentDashboardPopout === true
  )
  const [recordingActionId, setRecordingActionId] = useState<KeybindingActionId | null>(null)
  const [recordingBindingIndex, setRecordingBindingIndex] = useState<number | null>(null)
  const [disableMemory, setDisableMemory] = useState<Partial<Record<KeybindingActionId, string[]>>>(
    {}
  )
  const [shortcutQuery, setShortcutQuery] = useState('')
  const [shortcutFilter, setShortcutFilter] = useState<ShortcutFilter>('all')

  useShortcutRecorderFocus(recordingActionId !== null)

  const { groups, conflictByAction } = catalog
  const { filterCounts, shortcutRows, visibleShortcutCount, visibleShortcutGroups } = useMemo(
    () =>
      buildShortcutRowVisibility(
        {
          groups,
          keybindings,
          conflictByAction,
          terminalShortcutPolicy,
          platform,
          managedBrowserCreationEnabled,
          mobileEmulatorCreationEnabled,
          agentDashboardEnabled,
          settingsSearchQuery: searchQuery,
          shortcutQuery,
          shortcutFilter
        },
        t
      ),
    [
      agentDashboardEnabled,
      conflictByAction,
      groups,
      keybindings,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      platform,
      searchQuery,
      shortcutFilter,
      shortcutQuery,
      t,
      terminalShortcutPolicy
    ]
  )

  const captureBinding = async (
    actionId: KeybindingActionId,
    input: KeybindingInput
  ): Promise<void> => {
    if (await captureBindingAt(actionId, input, recordingBindingIndex)) {
      setRecordingActionId(null)
      setRecordingBindingIndex(null)
    }
  }

  const removeBinding = async (actionId: KeybindingActionId, index: number): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    const current = effectiveBindingsForAction(actionId)
    await saveBindings(actionId, removeBindingAt(current, index))
  }

  const resetBinding = async (actionId: KeybindingActionId): Promise<void> => {
    await saveBindings(actionId, effectiveBindingsForAction(actionId, {}))
  }

  const disableBinding = async (actionId: KeybindingActionId): Promise<void> => {
    setErrors((prev) => ({ ...prev, [actionId]: undefined }))
    try {
      await disableKeybindingAction(actionId)
    } catch (error) {
      if (mountedRef.current) {
        setErrors((prev) => ({
          ...prev,
          [actionId]: error instanceof Error ? error.message : 'Failed to disable shortcut.'
        }))
      }
    }
  }

  const clearRecordingForAction = (actionId: KeybindingActionId): void => {
    if (recordingActionId === actionId) {
      setRecordingBindingIndex(null)
    }
    setRecordingActionId((current) => clearRecordingActionForShortcutMutation(current, actionId))
  }

  const showPolicy = matchesSettingsSearch(searchQuery, getTerminalShortcutPolicySearchEntry())

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <section className="flex min-h-0 flex-1 flex-col space-y-3">
        {showPolicy ? (
          <SettingsGroup>
            <ShortcutTerminalPolicyControl
              terminalShortcutPolicy={terminalShortcutPolicy}
              keywords={getTerminalShortcutPolicySearchEntry().keywords}
              updateSettings={updateSettings}
            />
          </SettingsGroup>
        ) : null}

        <SettingsSubsectionHeader
          title={t('auto.components.settings.ShortcutsPane.9a3a3ca03d', 'Keyboard shortcuts')}
          description={
            <>
              {t(
                'auto.components.settings.ShortcutsPane.38e86e206a',
                'Customize shortcuts visually or edit'
              )}{' '}
              <span className="font-mono text-[11px]">
                {keybindingSnapshot?.path ??
                  t(
                    'auto.components.settings.ShortcutsPane.d8c988dab4',
                    '~/.orca/keybindings.json'
                  )}
              </span>{' '}
              {t('auto.components.settings.ShortcutsPane.4b7ae34062', 'directly.')}
            </>
          }
          action={<KeybindingsFileActions />}
        />

        <KeybindingFileDiagnostics diagnostics={keybindingSnapshot?.diagnostics ?? []} />

        {/* Below xl, give the rail only content height and the list the remaining space; equal auto rows can overlap. */}
        <div className="grid min-h-0 flex-1 gap-6 max-xl:grid-rows-[auto_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)]">
          <ShortcutFilterRail
            query={shortcutQuery}
            onQueryChange={setShortcutQuery}
            filter={shortcutFilter}
            onFilterChange={setShortcutFilter}
            filterCounts={filterCounts}
            visibleCount={visibleShortcutCount}
            totalCount={shortcutRows.length}
          />

          <ShortcutRowsList
            // Hide overflow-x to avoid a phantom horizontal scrollbar from overflow-y-auto.
            className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pr-1 scrollbar-sleek"
            groups={visibleShortcutGroups}
            platform={platform}
            errors={errors}
            disableMemory={disableMemory}
            recordingActionId={recordingActionId}
            recordingBindingIndex={recordingBindingIndex}
            onStartRecordingAt={(actionId, index) => {
              setRecordingActionId(actionId)
              setRecordingBindingIndex(index)
              // Click-away keeps a row's error; drop every stale one once any new recording starts.
              setErrors({})
            }}
            onAppendBinding={(actionId) => {
              const current = effectiveBindingsForAction(actionId)
              setRecordingActionId(actionId)
              setRecordingBindingIndex(current.length)
              setErrors({})
            }}
            onCancelRecording={() => {
              setRecordingActionId(null)
              setRecordingBindingIndex(null)
            }}
            onCapture={(actionId, input) => void captureBinding(actionId, input)}
            onClearError={clearError}
            onRemoveBindingAt={(actionId, index) => {
              // Adjust pending capture after removal shifts slots, or clear it if its row was removed.
              if (recordingActionId === actionId) {
                const nextIndex = adjustRecordingIndexAfterRemove(recordingBindingIndex, index)
                setRecordingBindingIndex(nextIndex)
                if (nextIndex === null) {
                  setRecordingActionId(null)
                }
              }
              void removeBinding(actionId, index)
            }}
            onResetAction={(actionId) => {
              clearRecordingForAction(actionId)
              void resetBinding(actionId)
            }}
            onDisableAction={(actionId) => {
              const current = effectiveBindingsForAction(actionId)
              setDisableMemory((memory) => ({ ...memory, [actionId]: current }))
              clearRecordingForAction(actionId)
              void disableBinding(actionId)
            }}
            onEnableAction={(actionId) => {
              const remembered = disableMemory[actionId]
              if (remembered && remembered.length > 0) {
                void saveBindings(actionId, remembered)
              }
            }}
          />
        </div>
      </section>
    </div>
  )
}
