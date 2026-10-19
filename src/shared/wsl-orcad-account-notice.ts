/** Main → renderer: a WSL distro's orcad started an agent without the selected managed account,
 *  because it predates `agent-session.account-env.v1`. Sent at most once per distro per run. */
export const WSL_ORCAD_ACCOUNT_NOT_APPLIED_CHANNEL = 'runtimeEnvironments:wslAccountNotApplied'

export type WslOrcadAccountNotAppliedEvent = { distro: string }
