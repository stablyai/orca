// The selection already moved on; a fading overlay would only dim the surface it revealed. Escape keeps the fade.
export function skipPaletteExitAnimation(): void {
  const content = document.querySelector<HTMLElement>('[data-slot="command-dialog-content"]')
  const overlay = content?.previousElementSibling
  for (const element of [content, overlay]) {
    if (element instanceof HTMLElement) {
      element.style.animation = 'none'
    }
  }
}
