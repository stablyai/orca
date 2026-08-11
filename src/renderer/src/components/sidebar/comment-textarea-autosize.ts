/** Grows the comment textarea to fit its content in the same input event, so a
 *  passive effect cannot leave a stale height between keystrokes. */
export function resizeCommentTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}
