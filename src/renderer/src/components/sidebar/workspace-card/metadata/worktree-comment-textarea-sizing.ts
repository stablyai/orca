export function resizeCommentTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}
