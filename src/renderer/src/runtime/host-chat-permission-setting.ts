import {
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { GlobalSettings } from '../../../shared/global-settings-types'

type HostSetting = { generation: number; mode?: AgentChatPermissionMode }
type HostRead = { owner: string; setting: HostSetting; generation: number }

/** A confirmed write supersedes reads already in flight on the same host. */
export class HostChatPermissionSetting {
  private readonly hosts = new Map<string, HostSetting>()

  beginRead(owner: string): HostRead {
    let setting = this.hosts.get(owner)
    if (!setting) {
      setting = { generation: 0 }
      this.hosts.set(owner, setting)
      if (this.hosts.size > 32) {
        const oldest = this.hosts.keys().next().value
        if (oldest !== undefined) {
          this.hosts.delete(oldest)
        }
      }
    } else {
      this.hosts.delete(owner)
      this.hosts.set(owner, setting)
    }
    return { owner, setting, generation: setting.generation }
  }

  captureRead(read: HostRead, settings: Partial<GlobalSettings>): void {
    if (
      this.hosts.get(read.owner) === read.setting &&
      read.generation === read.setting.generation
    ) {
      read.setting.mode = this.mode(settings)
    }
  }

  captureWrite(owner: string, settings: Partial<GlobalSettings>): void {
    const { setting } = this.beginRead(owner)
    setting.generation += 1
    setting.mode = this.mode(settings)
  }

  value(owner: string): AgentChatPermissionMode | undefined {
    return this.hosts.get(owner)?.mode
  }

  private mode(settings: Partial<GlobalSettings>): AgentChatPermissionMode | undefined {
    return isAgentChatPermissionMode(settings.nativeChatPermissionMode)
      ? settings.nativeChatPermissionMode
      : undefined
  }
}
