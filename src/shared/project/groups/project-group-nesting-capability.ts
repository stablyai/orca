// Why: older hosts strip projectGroup.update's parentGroupId yet still answer with the group, so
// clients send a group move only to hosts advertising this.
export const PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY = 'projectGroup.nesting.v1' as const
