import { fireEvent } from '@testing-library/react'

/** Open every member of every opened run, as a reader clicking each line would. */
export function openToolRunMembers(): void {
  const closed = document.body.querySelectorAll<HTMLElement>(
    '[data-native-chat-tool-run-members] button[aria-expanded="false"]'
  )
  for (const member of closed) {
    fireEvent.click(member)
  }
}
