/**
 * orcad advertises this in status.get when it runs on an Orca Cloud VM (ORCA_IS_CLOUD=1 from the
 * image). A desktop then sends it none of its own Agent API keys, however the host was paired: the
 * answer comes from the host itself, not from this desktop's records.
 */
export const ORCA_CLOUD_HOST_RUNTIME_CAPABILITY = 'host.orca-cloud.v1' as const
