import type { CodexMaintenanceState } from '../../../shared/codex-cli-maintenance'

type Activity = { revision: number; job: CodexMaintenanceState['currentJob']; error: string | null }

export class CodexMaintenanceActivity {
  private readonly hosts = new Map<string, Activity>()

  reconcile(
    host: string,
    state: CodexMaintenanceState,
    revision: number,
    historical: boolean
  ): void {
    const job = historical ? state.currentJob : state.job
    if (job !== undefined && !this.isSuperseded(host, revision)) {
      this.hosts.set(host, {
        revision,
        job: job ? { id: job.id, phase: job.phase } : null,
        error: null
      })
    }
  }

  recordFailure(host: string, revision: number, error: string): void {
    const activity = this.hosts.get(host)
    if (activity && !this.isSuperseded(host, revision)) {
      this.hosts.set(host, { ...activity, revision, error })
    }
  }

  isSuperseded(host: string, revision: number): boolean {
    return (this.hosts.get(host)?.revision ?? 0) > revision
  }

  isBusy(host: string): boolean {
    const activity = this.hosts.get(host)
    return Boolean(
      !activity?.error &&
      activity?.job &&
      (activity.job.phase === 'queued' || activity.job.phase === 'running')
    )
  }

  delete(host: string): void {
    this.hosts.delete(host)
  }

  clear(): void {
    this.hosts.clear()
  }
}
