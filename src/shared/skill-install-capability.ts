export const SKILL_INSTALL_CAPABILITY = 'skills.install.v1' as const
export const SKILL_INSTALL_RESULT_V2_CAPABILITY = 'skills.install-result.v2' as const
export const SKILL_INSTALL_CANCEL_CAPABILITY = 'skills.install-cancel.v1' as const
export const SKILL_UPLOAD_CAPABILITY = 'skills.upload.v1' as const
export const SKILL_MANAGEMENT_CAPABILITY = 'skills.manage.v1' as const
export const SKILL_BUNDLE_INSTALL_CAPABILITY = 'skills.install.bundle.v1' as const
export const SKILL_INSTALL_PROGRESS_CAPABILITY = 'skills.install-progress.v1' as const
/** Gate providers because strict older hosts reject the whole request instead of ignoring the new field. */
export const SKILL_INSTALL_PROVIDERS_CAPABILITY = 'skills.install-providers.v1' as const

export const SKILL_INSTALL_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the selected machine to install shared skills.'

/** Gate the new method so old hosts show a disabled action rather than a method-not-found failure. */
export const SKILL_DELETE_CAPABILITY = 'skills.delete.v1' as const

export const SKILL_DELETE_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the selected machine to delete skills.'

/** skills.planBundledOrca/executeBundledOrca v1 freezes op/reason enums; unknown values render “Needs attention”. */
export const BUNDLED_ORCA_SKILL_CAPABILITY = 'skills.bundled-orca.v1' as const

export const BUNDLED_ORCA_SKILL_UPDATE_REQUIRED_MESSAGE =
  'Update Orca on the server to update its Orca skills.'

export const SKILL_RUNTIME_CAPABILITIES = [
  SKILL_INSTALL_CAPABILITY,
  SKILL_BUNDLE_INSTALL_CAPABILITY,
  SKILL_INSTALL_CANCEL_CAPABILITY,
  SKILL_INSTALL_PROGRESS_CAPABILITY,
  SKILL_INSTALL_RESULT_V2_CAPABILITY,
  SKILL_UPLOAD_CAPABILITY,
  SKILL_MANAGEMENT_CAPABILITY,
  SKILL_INSTALL_PROVIDERS_CAPABILITY,
  SKILL_DELETE_CAPABILITY,
  BUNDLED_ORCA_SKILL_CAPABILITY
] as const
