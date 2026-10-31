import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { SettingsSegmentedControl } from './SettingsFormControls'
import type { AgentPostPasteSubmitInput } from '../../../../shared/tui-agent-post-paste-submit'

export function AgentPostPasteSubmitInputControl({
  value,
  onSave
}: {
  value: AgentPostPasteSubmitInput
  onSave: (value: AgentPostPasteSubmitInput) => void | Promise<void>
}): React.JSX.Element {
  const [selectedValue, setSelectedValue] = useState(value)
  const latestValueRef = useRef(value)
  const latestSaveIdRef = useRef<number | null>(null)
  const nextSaveIdRef = useRef(0)

  useEffect(() => {
    latestValueRef.current = value
    if (latestSaveIdRef.current === null) {
      setSelectedValue(value)
    }
  }, [value])

  const save = (next: AgentPostPasteSubmitInput): void => {
    if (next === selectedValue) {
      return
    }
    const saveId = ++nextSaveIdRef.current
    latestSaveIdRef.current = saveId
    setSelectedValue(next)
    void Promise.resolve()
      .then(() => onSave(next))
      .then(
        () => {
          if (latestSaveIdRef.current === saveId) {
            latestSaveIdRef.current = null
          }
        },
        () => {
          if (latestSaveIdRef.current === saveId) {
            latestSaveIdRef.current = null
            setSelectedValue(latestValueRef.current)
          }
        }
      )
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {translate('settings.agents.postPasteSubmit', 'After pasting an action recipe')}
      </span>
      <SettingsSegmentedControl<AgentPostPasteSubmitInput>
        value={selectedValue}
        onChange={save}
        ariaLabel={translate('settings.agents.postPasteSubmit', 'After pasting an action recipe')}
        size="sm"
        options={[
          { value: 'enter', label: translate('settings.agents.submitEnter', 'Press Enter') },
          {
            value: 'ctrl-enter',
            label: translate('settings.agents.submitCtrlEnter', 'Press Ctrl+Enter')
          }
        ]}
      />
    </div>
  )
}
