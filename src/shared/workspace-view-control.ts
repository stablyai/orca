export type WorkspaceViewController = { windowId: number; viewId: string }
export type WorkspaceViewRegistration = { key: string; viewId: string }
export class WorkspaceViewControl {
  private readonly views = new Map<number, WorkspaceViewRegistration[]>()
  private readonly controllers = new Map<string, WorkspaceViewController>()
  register(windowId: number, views: WorkspaceViewRegistration[]): void {
    this.views.set(windowId, views)
    for (const [key, controller] of this.controllers) {
      if (
        !this.views
          .get(controller.windowId)
          ?.some((view) => view.key === key && view.viewId === controller.viewId)
      ) {
        this.controllers.delete(key)
      }
    }
    for (const [id, entries] of this.views) {
      for (const entry of entries) {
        if (!this.controllers.has(entry.key)) {
          this.controllers.set(entry.key, { windowId: id, viewId: entry.viewId })
        }
      }
    }
    if (!views.length) {
      this.views.delete(windowId)
    }
  }
  claim(windowId: number, key: string, viewId: string): boolean {
    if (!this.views.get(windowId)?.some((view) => view.key === key && view.viewId === viewId)) {
      return false
    }
    this.controllers.set(key, { windowId, viewId })
    return true
  }
  snapshot(): Record<string, WorkspaceViewController> {
    return Object.fromEntries(this.controllers)
  }
}
