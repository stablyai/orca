import { subscribeUserWorkspaceSwitch } from './workspace-switch-user-act'
import { captureBrowserLinkReveal } from './browser-link-reveal'
import { useAppStore } from '@/store'
import type { QuickChatDestination } from './start-quick-chat'
import { QUICK_CHAT_FINISHED_EVENT } from './quick-chat-events'

type Authority = ReturnType<typeof captureBrowserLinkReveal>
export type QuickChatIntent = {
  id: string
  control?: HTMLElement
  anchorControl?: HTMLElement
  anchor?: DOMRect
  destination?: QuickChatDestination
  authority: Authority
}

/** Shared preparation is not shared consent: every accepted action settles on its own. */
export class QuickChatIntents {
  readonly pending = new Map<string, QuickChatIntent>()
  private listeners = new Set<() => void>()
  private version = 0
  private handoff: Set<QuickChatIntent> | null = null
  snapshot = () => this.version
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  changed = () => {
    this.version += 1
    this.listeners.forEach((listener) => listener())
  }
  private capture(intent: QuickChatIntent): Authority {
    return captureBrowserLinkReveal(useAppStore.getState, (observe) => {
      const stopSelection = useAppStore.subscribe((state) => {
        observe(state)
        if (!intent.authority.canReveal()) {
          this.finish(intent)
        }
      })
      const stopSwitch = subscribeUserWorkspaceSwitch(() => this.finish(intent))
      return () => {
        stopSelection()
        stopSwitch()
      }
    })
  }
  accept(id: string, control?: HTMLElement): QuickChatIntent {
    const intent: QuickChatIntent = {
      id,
      control,
      anchorControl: control,
      anchor: control?.getBoundingClientRect(),
      authority: { canReveal: () => false, dispose: () => {} }
    }
    intent.authority = this.capture(intent)
    this.pending.set(id, intent)
    this.changed()
    return intent
  }
  live(intent: QuickChatIntent): boolean {
    return (
      this.pending.get(intent.id) === intent &&
      (this.handoff?.has(intent) === true || intent.authority.canReveal())
    )
  }
  finish(intent: QuickChatIntent): void {
    if (!this.pending.delete(intent.id)) {
      return
    }
    intent.authority.dispose()
    intent.control?.dispatchEvent(new CustomEvent(QUICK_CHAT_FINISHED_EVENT, { detail: intent.id }))
    this.changed()
  }
  /** Only this synchronous transition hands current foreground authority to siblings. */
  transition(intent: QuickChatIntent, action: () => void): boolean {
    if (!this.live(intent)) {
      return false
    }
    if (this.handoff) {
      action()
      return true
    }
    const siblings = new Set([...this.pending.values()].filter((pending) => this.live(pending)))
    this.handoff = siblings
    siblings.forEach((pending) => pending.authority.dispose())
    try {
      action()
    } finally {
      this.handoff = null
      siblings.forEach((pending) => {
        if (this.pending.get(pending.id) === pending) {
          pending.authority = this.capture(pending)
        }
      })
    }
    return true
  }
  anchor(control?: HTMLElement, accepted?: QuickChatIntent): void {
    for (const intent of accepted ? [accepted] : this.pending.values()) {
      if (!intent.anchorControl?.isConnected) {
        intent.anchorControl = control
        intent.anchor = control?.getBoundingClientRect()
      }
    }
    this.changed()
  }
  dispose(): void {
    for (const intent of this.pending.values()) {
      this.finish(intent)
    }
  }
}
