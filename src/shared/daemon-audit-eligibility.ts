export const DAEMON_AUDIT_STATE_VALUES = ['present', 'gone', 'unknown'] as const

export const DAEMON_AUDIT_TRIGGER_VALUES = [
  'inventory_answered',
  'inventory_failed',
  'token_missing_after_authenticated_disconnect',
  'transport_closed'
] as const

export const DAEMON_EVIDENCE_SOURCE_VALUES = [
  'authenticated_inventory',
  'boot_identity',
  'endpoint_identity',
  'endpoint_stat',
  'linux_proc_stat',
  'pid_record',
  'process_command_line',
  'process_signal',
  'process_start_time',
  'token_file',
  'windows_cim',
  'windows_named_pipe'
] as const

export const DAEMON_PROCESS_PRESENT_REASON_VALUES = [
  'linux_identity_match',
  'macos_identity_match',
  'windows_identity_match'
] as const

export const DAEMON_PROCESS_GONE_REASON_VALUES = [
  'linux_boot_changed',
  'linux_start_ticks_mismatch',
  'linux_zombie',
  'pid_missing',
  'windows_creation_time_mismatch',
  'windows_process_missing'
] as const

export const DAEMON_PROCESS_UNKNOWN_REASON_VALUES = [
  'command_line_mismatch',
  'command_line_unavailable',
  'exact_identity_unavailable',
  'inspection_failed',
  'linux_identity_incomplete',
  'macos_start_time_mismatch',
  'permission_denied',
  'process_start_time_unavailable',
  'windows_process_start_time_unavailable'
] as const

export const DAEMON_AUDIT_GONE_REASON_VALUES = [
  ...DAEMON_PROCESS_GONE_REASON_VALUES,
  'windows_named_pipe_missing'
] as const

export const DAEMON_AUDIT_REASON_VALUES = [
  'authenticated_inventory',
  'inventory_failed',
  'token_missing_after_authenticated_disconnect',
  'transport_closed',
  ...DAEMON_AUDIT_GONE_REASON_VALUES
] as const

export const DAEMON_AUDIT_PROCESS_REASON_VALUES = [
  ...DAEMON_PROCESS_PRESENT_REASON_VALUES,
  ...DAEMON_PROCESS_GONE_REASON_VALUES,
  ...DAEMON_PROCESS_UNKNOWN_REASON_VALUES,
  'windows_named_pipe_missing'
] as const

export type DaemonAuditTrigger = (typeof DAEMON_AUDIT_TRIGGER_VALUES)[number]
export type DaemonAuditFailureTrigger = Exclude<DaemonAuditTrigger, 'inventory_answered'>
export type DaemonEvidenceSource = (typeof DAEMON_EVIDENCE_SOURCE_VALUES)[number]
export type DaemonProcessPresentReason = (typeof DAEMON_PROCESS_PRESENT_REASON_VALUES)[number]
export type DaemonProcessGoneReason = (typeof DAEMON_PROCESS_GONE_REASON_VALUES)[number]
export type DaemonProcessUnknownReason = (typeof DAEMON_PROCESS_UNKNOWN_REASON_VALUES)[number]
export type DaemonAuditGoneReason = (typeof DAEMON_AUDIT_GONE_REASON_VALUES)[number]
