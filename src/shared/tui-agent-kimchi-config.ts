export const KIMCHI_TUI_AGENT_CONFIG = {
  detectCmd: 'kimchi',
  launchCmd: 'kimchi',
  expectedProcess: 'kimchi',
  promptInjectionMode: 'argv',
  // Why: kimchi is pi-mono based; same orca-prefill extension pattern as pi/omp, distinct env var.
  draftPromptEnvVar: 'ORCA_KIMCHI_PREFILL',
  // Why: kimchi probes Kitty keyboard support and decodes CSI-u like pi (#9703).
  windowsShiftEnterEncoding: 'csi-u'
} as const
