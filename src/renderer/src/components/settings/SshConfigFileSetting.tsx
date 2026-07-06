import React, { useEffect, useId, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { translate } from '@/i18n/i18n'

type SshConfigFileSettingProps = {
  // Why: after the path changes, re-import + reload so the host list reflects
  // the new file (the pane already does this on open).
  onCommitted: () => void | Promise<void>
}

export function SshConfigFileSetting({
  onCommitted
}: SshConfigFileSettingProps): React.JSX.Element {
  const inputId = useId()
  const settingsValue = useAppStore((s) => s.settings)?.sshConfigPath ?? ''
  const updateSettings = useAppStore((s) => s.updateSettings)

  // Why: commit on blur/Enter, not per keystroke — the setting flows into the
  // ssh binary's -F flag, and each keystroke would fire an IPC set + re-import.
  const [draftValue, setDraftValue] = useState(settingsValue)
  const draftValueRef = useRef(settingsValue)
  const skipNextBlurCommitRef = useRef(false)

  useEffect(() => {
    setDraftValue(settingsValue)
    draftValueRef.current = settingsValue
  }, [settingsValue])

  const setDraft = (next: string): void => {
    draftValueRef.current = next
    setDraftValue(next)
  }

  const commitDraftValue = (): void => {
    const next = draftValueRef.current
    if (next === settingsValue) {
      return
    }
    void (async () => {
      await updateSettings({ sshConfigPath: next })
      await onCommitted()
    })()
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId} className="text-sm font-medium">
        {translate('auto.components.settings.SshConfigFileSetting.7a1c2e0b45', 'SSH config file')}
      </Label>
      <Input
        id={inputId}
        value={draftValue}
        placeholder="~/.ssh/config"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (skipNextBlurCommitRef.current) {
            skipNextBlurCommitRef.current = false
            return
          }
          commitDraftValue()
        }}
        onKeyDown={(e) => {
          // Why: an Enter that only confirms a CJK IME candidate must not commit.
          if (isImeCompositionKeyDown(e)) {
            return
          }
          if (e.key === 'Enter') {
            skipNextBlurCommitRef.current = true
            commitDraftValue()
            e.currentTarget.blur()
            return
          }
          if (e.key === 'Escape') {
            skipNextBlurCommitRef.current = true
            setDraft(settingsValue)
            e.currentTarget.blur()
          }
        }}
        className="text-xs"
      />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.SshConfigFileSetting.9d3f5a1c67',
          'Local OpenSSH client config used to import hosts and connect. Use an absolute or ~-based path. Leave blank to use ~/.ssh/config.'
        )}
      </p>
    </div>
  )
}
