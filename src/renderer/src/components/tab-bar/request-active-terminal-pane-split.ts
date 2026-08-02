import {
  REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
  type RequestActiveTerminalPaneSplitDetail
} from '@/constants/terminal'

export function requestActiveTerminalPaneSplit(detail: RequestActiveTerminalPaneSplitDetail): void {
  window.dispatchEvent(
    new CustomEvent<RequestActiveTerminalPaneSplitDetail>(
      REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
      { detail }
    )
  )
}
