import { RUN_LINK_BUTTON } from '../../automation-run/automation-run-link-button'

/** A text action in a status row's opened details that copies its text, e.g. Copy instructions. */
export function NativeChatEventCopyLink({
  text,
  label
}: {
  text: string
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={RUN_LINK_BUTTON}
      onClick={() => {
        void window.api.ui.writeClipboardText(text).catch(() => undefined)
      }}
    >
      {label}
    </button>
  )
}
