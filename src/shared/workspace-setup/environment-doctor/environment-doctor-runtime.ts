// Zod-free so capability lists that reach the mobile web bundle can import it.
export const ENVIRONMENT_DOCTOR_METHOD = 'environment.doctor' as const
// Hosts that run the environment doctor on their own checkout; older hosts skip the build checks.
export const ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY = 'environment.doctor.v1' as const
