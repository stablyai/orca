import { Fragment, useMemo, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { NativeChatDisclosureContext } from './native-chat-disclosure-store'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS,
  NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS,
  useNativeChatAppearanceStyle
} from './native-chat-appearance-style'
import { createNativeChatAppearanceSample } from './native-chat-appearance-sample'

function blockPreviewInteraction(event: SyntheticEvent): void {
  event.preventDefault()
  event.stopPropagation()
}

function ignorePreviewAction(): void {}

export function NativeChatAppearancePreview({
  settings
}: {
  settings: GlobalSettings
}): React.JSX.Element {
  const appearanceStyle = useNativeChatAppearanceStyle(settings)
  const { i18n } = useTranslation()
  const messages = useMemo(() => createNativeChatAppearanceSample(i18n.language), [i18n.language])
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/50">
      <div className="border-b border-border/50 bg-background px-3 py-1.5 text-[11px] text-muted-foreground">
        {translate('settings.appearance.chat.preview', 'Preview')}
      </div>
      <div
        data-native-chat-appearance-preview
        className={cn(
          NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
          'h-[440px] overflow-hidden text-chat-foreground'
        )}
        style={appearanceStyle}
        inert
        onClickCapture={blockPreviewInteraction}
        onAuxClickCapture={blockPreviewInteraction}
        onKeyDownCapture={blockPreviewInteraction}
        onContextMenuCapture={blockPreviewInteraction}
      >
        <NativeChatDisclosureContext.Provider value={null}>
          <div className={cn(NATIVE_CHAT_TRANSCRIPT_OUTER_CLASS, 'py-3')}>
            <div className={cn(NATIVE_CHAT_TRANSCRIPT_COLUMN_CLASS, 'gap-2')}>
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  {index === 1 ? (
                    <NativeChatWorkingStatus
                      startedAt={null}
                      workedSeconds={12}
                      expanded
                      onToggleExpanded={ignorePreviewAction}
                    />
                  ) : null}
                  <MessageRow
                    message={message}
                    expandSignal={false}
                    toolRunExpandOverride
                    toolRunSummaryOverride={translate(
                      'settings.appearance.chat.previewSample.toolSummary',
                      'Searched 1 pattern, read 1 file'
                    )}
                    hideUserMeta
                    onScrollMessageToTop={ignorePreviewAction}
                  />
                </Fragment>
              ))}
            </div>
          </div>
        </NativeChatDisclosureContext.Provider>
      </div>
    </div>
  )
}
