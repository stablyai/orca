export const SKILL_INSTALL_CAPABILITY = 'skills.install.v1' as const
export const SKILL_INSTALL_RESULT_V2_CAPABILITY = 'skills.install-result.v2' as const
export const SKILL_INSTALL_CANCEL_CAPABILITY = 'skills.install-cancel.v1' as const
export const SKILL_UPLOAD_CAPABILITY = 'skills.upload.v1' as const
export const SKILL_MANAGEMENT_CAPABILITY = 'skills.manage.v1' as const
export const SKILL_BUNDLE_INSTALL_CAPABILITY = 'skills.install.bundle.v1' as const
export const SKILL_BUNDLE_PREVIEW_CAPABILITY = 'skills.preview.bundle.v1' as const
export const SKILL_INSTALL_PROGRESS_CAPABILITY = 'skills.install-progress.v1' as const
/** Why: the install request schema is strict, so a host that predates the agent
 *  picker rejects the whole request rather than ignoring the new field. */
export const SKILL_INSTALL_PROVIDERS_CAPABILITY = 'skills.install-providers.v1' as const

export const SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the selected machine to install shared skills.'

/** Why capability-gated rather than Rule 1: `skills.delete` is a new RPC method,
 *  and an old host answers method-not-found, which surfaces as an unexplained
 *  failure instead of a disabled action with a reason. */
export const SKILL_DELETE_CAPABILITY = 'skills.delete.v1' as const

export const SKILL_DELETE_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the selected machine to delete skills.'
