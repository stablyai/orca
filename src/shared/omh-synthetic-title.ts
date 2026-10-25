export type OmhSyntheticAgentStatus = 'working' | 'permission' | 'idle'

// Why exact casing and no free text: `omh` is short enough to appear in task prose, so only
// the titles Orca itself synthesizes for an OMH pane name it.
const OMH_SYNTHETIC_TITLE_RE =
  /^\s*([\u2800-\u28ff]\s+)?OMH(\s+-\s+action required|\s+(?:ready|idle|done))?\s*$/

export function getOmhSyntheticAgentLabel(title: string): 'OMH' | null {
  return OMH_SYNTHETIC_TITLE_RE.test(title) ? 'OMH' : null
}

export function getOmhSyntheticAgentStatus(title: string): OmhSyntheticAgentStatus | null {
  const match = OMH_SYNTHETIC_TITLE_RE.exec(title)
  if (!match) {
    return null
  }
  if (match[1]) {
    return 'working'
  }
  return match[2]?.includes('action required') ? 'permission' : 'idle'
}
