import { useEffect, type RefObject } from 'react'

// Why: plain click inside a contenteditable places the caret, so markdown links
// only open on Cmd/Ctrl-click. Toggling this class while the platform modifier
// is held lets CSS surface a pointer cursor only at that moment — matching
// VS Code's link affordance without misleading the user into expecting a plain
// click to open.
export function useModifierHeldClass(
  targetRef: RefObject<HTMLElement | null>,
  isMac: boolean,
  className = 'rich-markdown-mod-held'
): void {
  useEffect(() => {
    const target = targetRef.current
    if (!target) {
      return
    }
    const modKey = isMac ? 'Meta' : 'Control'
    const update = (pressed: boolean): void => {
      target.classList.toggle(className, pressed)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === modKey) {
        update(true)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === modKey) {
        update(false)
      }
    }
    const onBlur = (): void => update(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      update(false)
    }
  }, [targetRef, isMac, className])
}
