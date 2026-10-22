import type { SidebarFeedSnapshot } from './sidebar-feed-snapshot'

/** Each host's last installed feed, newest last, so a reopened list of it draws before its read lands. */
export class RememberedSidebarFeeds {
  private readonly byHost = new Map<string, SidebarFeedSnapshot>()

  constructor(private readonly maxHosts: number) {}

  /** Null forgets the host: a host without the feed must not open on an older one. */
  remember(hostId: string, snapshot: SidebarFeedSnapshot | null): void {
    this.byHost.delete(hostId)
    if (!snapshot) {
      return
    }
    this.byHost.set(hostId, snapshot)
    if (this.byHost.size > this.maxHosts) {
      const oldest = this.byHost.keys().next().value
      if (oldest !== undefined) {
        this.byHost.delete(oldest)
      }
    }
  }

  recall(hostId: string): SidebarFeedSnapshot | null {
    return this.byHost.get(hostId) ?? null
  }

  forgetAll(): void {
    this.byHost.clear()
  }
}
