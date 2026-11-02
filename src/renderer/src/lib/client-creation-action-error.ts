import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  getClientCreationActionPolicy,
  type ClientCreationAction
} from './client-creation-action-policy'

export function showClientCreationActionError(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

// Surface policy reasons in action paths or shortcut-driven creation fails silently despite visibility gates.
export function ensureClientCreationActionAllowed(
  worktreeId: string | null,
  action: ClientCreationAction
): boolean {
  const availability = getClientCreationActionPolicy(useAppStore.getState(), worktreeId)[action]
  if (availability.state !== 'enabled') {
    toast.error(availability.reason)
    return false
  }
  return true
}
